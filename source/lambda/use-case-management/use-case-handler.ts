// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { APIGatewayEvent } from 'aws-lambda';
import { CaseCommand } from './model/commands/case-command';
import {
    CreateUseCaseCommand,
    DeleteUseCaseCommand,
    ListUseCasesCommand,
    PermanentlyDeleteUseCaseCommand,
    UpdateUseCaseCommand,
    GetUseCaseCommand
} from './model/commands/use-case-command';
import { ListUseCasesAdapter } from './model/list-use-cases';
import { UseCase } from './model/use-case';
import { logger, metrics, tracer } from './power-tools-init';
import { checkEnv, handleLambdaError, getRootResourceId, parseEventBody, getStackAction } from './utils/utils';
import { formatResponse } from './utils/http-response-formatters';
import { ChatUseCaseDeploymentAdapter, ChatUseCaseInfoAdapter } from './model/adapters/chat-use-case-adapter';
import { AgentUseCaseDeploymentAdapter } from './model/adapters/agent-use-case-adapter';
import { Status, UseCaseTypeFromApiEvent } from './utils/constants';
import { GetUseCaseAdapter } from './model/get-use-case';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AWSClientManager } from 'aws-sdk-lib';
import { VOICE_ROUTING_TABLE_NAME_ENV_VAR, USE_CASES_TABLE_NAME_ENV_VAR, VOICE_CONVERSATIONS_TABLE_NAME_ENV_VAR } from './utils/constants';
import { extractTenantId, isCustomerPrincipal, isPlatformAdmin } from './utils/utils';

const commands: Map<string, CaseCommand> = new Map<string, CaseCommand>();
commands.set('create', new CreateUseCaseCommand());
commands.set('update', new UpdateUseCaseCommand());
commands.set('delete', new DeleteUseCaseCommand());
commands.set('permanentlyDelete', new PermanentlyDeleteUseCaseCommand());
commands.set('list', new ListUseCasesCommand());
commands.set('get', new GetUseCaseCommand());

const routeMap = new Map([
    ['GET:/deployments', 'list'],
    ['POST:/deployments', 'create'],
    ['GET:/deployments/{useCaseId}', 'get'],
    ['PATCH:/deployments/{useCaseId}', 'update'],
    ['DELETE:/deployments/{useCaseId}', 'delete'],
    ['POST:/deployments/{useCaseId}/channels/voice', 'assignVoice'],
    ['GET:/usage/voice', 'usageVoice']
]);

export const lambdaHandler = async (event: APIGatewayEvent) => {
    checkEnv();

    const stackAction = getStackAction(event, routeMap);
    const command = commands.get(stackAction);

    try {
        if (stackAction === 'assignVoice') {
            const response = await assignVoiceChannel(event);
            return formatResponse(response);
        }
        if (stackAction === 'usageVoice') {
            const response = await getVoiceUsage(event);
            return formatResponse(response);
        }

        if (!command) {
            logger.error(`Invalid action: ${stackAction}`);
            throw new Error(`Invalid action: ${stackAction}`);
        }

        const response = await command.execute(await adaptEvent(event, stackAction));

        // as create stack and update stack failures don't throw error, but returns a Failure response
        // to render a 500 request in the UI the following error is
        if (response === Status.FAILED) {
            throw new Error('Command execution failed');
        }
        return formatResponse(response);
    } catch (error: unknown) {
        const mcpAction = event.httpMethod && event.resource ? `${event.httpMethod}:${event.resource}` : 'unknown';
        return handleLambdaError(error, mcpAction, 'Usecase');
    }
};

function parseIso(s: any): number | undefined {
    const t = typeof s === 'string' ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : undefined;
}

async function getVoiceUsage(event: APIGatewayEvent): Promise<any> {
    // Customer-only (admin can use other dashboards; we can broaden later)
    if (!isCustomerPrincipal(event) && !isPlatformAdmin(event)) {
        return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Forbidden' }) };
    }

    const tenantId = extractTenantId(event);
    if (!tenantId) {
        return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Missing tenant context' }) };
    }

    const tableName = process.env[VOICE_CONVERSATIONS_TABLE_NAME_ENV_VAR];
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR];
    if (!tableName || !useCasesTable) {
        return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Server not configured for voice usage' }) };
    }

    const qs = event.queryStringParameters ?? {};
    const daysRaw = (qs.days ?? '').toString().trim();
    const days = daysRaw ? Math.max(1, Math.min(90, parseInt(daysRaw, 10))) : 7;

    const nowMs = Date.now();
    const startMs = nowMs - days * 24 * 60 * 60 * 1000;
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(nowMs).toISOString();

    const ddbDoc = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));

    // Query by tenant, filter by StartedAt range (MVP: filter expression; optimize later with time-based SK/GSI).
    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    const items: any[] = [];
    do {
        const resp = await ddbDoc.send(
            new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: 'TenantId = :tid',
                ExpressionAttributeValues: { ':tid': tenantId, ':start': startIso, ':end': endIso },
                FilterExpression: 'StartedAt BETWEEN :start AND :end',
                ExclusiveStartKey: lastEvaluatedKey
            })
        );
        items.push(...(resp.Items ?? []));
        lastEvaluatedKey = resp.LastEvaluatedKey as any;
    } while (lastEvaluatedKey);

    type Agg = {
        useCaseId: string;
        calls: number;
        endedCalls: number;
        errorCalls: number;
        totalTurns: number;
        totalLatencyMs: number;
        totalDurationSec: number;
        lastCallAt?: string;
    };

    const byUseCase = new Map<string, Agg>();
    let totals: Agg = {
        useCaseId: 'TOTAL',
        calls: 0,
        endedCalls: 0,
        errorCalls: 0,
        totalTurns: 0,
        totalLatencyMs: 0,
        totalDurationSec: 0
    };

    for (const it of items) {
        const useCaseId = String(it.UseCaseId ?? '').trim();
        if (!useCaseId) continue;

        const ended = Boolean(it.Ended);
        const hasErr = Boolean(it.LastError);
        const turns = Number(it.TurnCount ?? 0) || 0;
        const lat = Number(it.LastLatencyMs ?? 0) || 0;
        const startedAt = typeof it.StartedAt === 'string' ? it.StartedAt : undefined;
        const endedAt = typeof it.EndedAt === 'string' ? it.EndedAt : undefined;
        const durSec = (() => {
            const s = parseIso(startedAt);
            const e = parseIso(endedAt);
            if (!s || !e || e < s) return 0;
            return Math.floor((e - s) / 1000);
        })();

        const agg = byUseCase.get(useCaseId) ?? {
            useCaseId,
            calls: 0,
            endedCalls: 0,
            errorCalls: 0,
            totalTurns: 0,
            totalLatencyMs: 0,
            totalDurationSec: 0,
            lastCallAt: undefined
        };

        agg.calls += 1;
        totals.calls += 1;

        if (ended) {
            agg.endedCalls += 1;
            totals.endedCalls += 1;
        }
        if (hasErr) {
            agg.errorCalls += 1;
            totals.errorCalls += 1;
        }

        agg.totalTurns += turns;
        totals.totalTurns += turns;

        agg.totalLatencyMs += lat;
        totals.totalLatencyMs += lat;

        agg.totalDurationSec += durSec;
        totals.totalDurationSec += durSec;

        if (startedAt) {
            if (!agg.lastCallAt || startedAt > agg.lastCallAt) agg.lastCallAt = startedAt;
            if (!totals.lastCallAt || startedAt > totals.lastCallAt) totals.lastCallAt = startedAt;
        }

        byUseCase.set(useCaseId, agg);
    }

    const uniqueUseCaseIds = Array.from(byUseCase.keys());
    const nameMap = new Map<string, string>();
    if (uniqueUseCaseIds.length > 0) {
        // BatchGet max 100 keys
        for (let i = 0; i < uniqueUseCaseIds.length; i += 100) {
            const chunk = uniqueUseCaseIds.slice(i, i + 100);
            const resp = await ddbDoc.send(
                new BatchGetCommand({
                    RequestItems: {
                        [useCasesTable]: {
                            Keys: chunk.map((id) => ({ UseCaseId: id })),
                            ProjectionExpression: 'UseCaseId, UseCaseName, #n',
                            ExpressionAttributeNames: {
                                '#n': 'Name'
                            }
                        }
                    }
                })
            );
            const got = (resp.Responses?.[useCasesTable] ?? []) as any[];
            for (const u of got) {
                const id = u.UseCaseId;
                const nm = u.UseCaseName ?? u.Name ?? id;
                if (id) nameMap.set(id, String(nm));
            }
        }
    }

    const byUseCaseArr = Array.from(byUseCase.values())
        .map((a) => {
            const calls = a.calls || 0;
            return {
                useCaseId: a.useCaseId,
                useCaseName: nameMap.get(a.useCaseId) ?? a.useCaseId,
                calls,
                endedCalls: a.endedCalls,
                errorCalls: a.errorCalls,
                totalDurationSec: a.totalDurationSec,
                avgDurationSec: calls ? Math.round(a.totalDurationSec / calls) : 0,
                avgTurns: calls ? Math.round(a.totalTurns / calls) : 0,
                avgLatencyMs: calls ? Math.round(a.totalLatencyMs / calls) : 0,
                lastCallAt: a.lastCallAt
            };
        })
        .sort((a, b) => b.calls - a.calls);

    const totalCalls = totals.calls || 0;
    const response = {
        tenantId,
        range: { days, startIso, endIso },
        totals: {
            calls: totalCalls,
            endedCalls: totals.endedCalls,
            errorCalls: totals.errorCalls,
            totalDurationSec: totals.totalDurationSec,
            totalDurationMinutes: Math.round(totals.totalDurationSec / 60),
            avgDurationSec: totalCalls ? Math.round(totals.totalDurationSec / totalCalls) : 0,
            avgTurns: totalCalls ? Math.round(totals.totalTurns / totalCalls) : 0,
            avgLatencyMs: totalCalls ? Math.round(totals.totalLatencyMs / totalCalls) : 0,
            lastCallAt: totals.lastCallAt ?? null
        },
        byUseCase: byUseCaseArr
    };

    return response;
}

const isE164 = (s: string) => /^\+[1-9]\d{6,14}$/.test(s);

async function assignVoiceChannel(event: APIGatewayEvent): Promise<any> {
    // Admin-only for now (customer portal will use different UX)
    if (!isPlatformAdmin(event)) {
        return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Forbidden' }) };
    }

    const useCaseId = event.pathParameters?.useCaseId;
    if (!useCaseId) {
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'useCaseId is required' }) };
    }

    const body = parseEventBody(event);
    const phoneNumber = String(body?.phoneNumber ?? '').trim();
    if (!isE164(phoneNumber)) {
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'phoneNumber must be in E.164 format, e.g. +14155550123' }) };
    }

    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]!;
    const voiceRoutingTable = process.env[VOICE_ROUTING_TABLE_NAME_ENV_VAR]!;

    const ddbDoc = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));
    const useCase = await ddbDoc.send(
        new GetCommand({
            TableName: useCasesTable,
            Key: { UseCaseId: useCaseId }
        })
    );
    const tenantId = (useCase.Item as any)?.TenantId;
    if (!tenantId) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Deployment has no TenantId. Assign it to a customer before enabling voice.' })
        };
    }

    // Prevent accidental reassignment of a phone number
    const existing = await ddbDoc.send(
        new GetCommand({
            TableName: voiceRoutingTable,
            Key: { phoneNumber }
        })
    );
    if (existing.Item && ((existing.Item as any).useCaseId !== useCaseId || (existing.Item as any).tenantId !== tenantId)) {
        return {
            statusCode: 409,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'phoneNumber is already assigned', phoneNumber })
        };
    }

    const now = new Date().toISOString();
    await ddbDoc.send(
        new PutCommand({
            TableName: voiceRoutingTable,
            Item: {
                phoneNumber,
                tenantId,
                useCaseId,
                updatedAt: now,
                createdAt: (existing.Item as any)?.createdAt ?? now
            }
        })
    );

    // Also persist on the deployment record so the admin UI can display voice assignment after refresh.
    await ddbDoc.send(
        new UpdateCommand({
            TableName: useCasesTable,
            Key: { UseCaseId: useCaseId },
            UpdateExpression: 'SET VoicePhoneNumber = :p, UpdatedDate = :u',
            ExpressionAttributeValues: {
                ':p': phoneNumber,
                ':u': now
            }
        })
    );

    return { ok: true, phoneNumber, tenantId, useCaseId };
}

export const adaptEvent = async (
    event: APIGatewayEvent,
    stackAction: string
): Promise<UseCase | ListUseCasesAdapter | GetUseCaseAdapter> => {
    if (stackAction === 'list') {
        return new ListUseCasesAdapter(event);
    } else if (stackAction === 'delete' || stackAction === 'permanentlyDelete') {
        return new ChatUseCaseInfoAdapter(event);
    } else if (stackAction === 'get') {
        return new GetUseCaseAdapter(event);
    }

    // Parse the event body
    const eventBody = parseEventBody(event);
    const useCaseType = eventBody.UseCaseType;

    // Only get root resource ID when ExistingRestApiId is provided
    let rootResourceId;
    if (eventBody.ExistingRestApiId) {
        rootResourceId = await getRootResourceId(eventBody.ExistingRestApiId);
    }

    // Create the appropriate adapter based on UseCaseType
    switch (useCaseType) {
        case UseCaseTypeFromApiEvent.TEXT:
            return new ChatUseCaseDeploymentAdapter(event, rootResourceId);
        case UseCaseTypeFromApiEvent.AGENT:
            return new AgentUseCaseDeploymentAdapter(event, rootResourceId);
        default:
            throw new Error(`Unsupported UseCaseType: ${useCaseType}`);
    }
};

export const handler = middy(lambdaHandler).use([
    captureLambdaHandler(tracer),
    injectLambdaContext(logger),
    logMetrics(metrics)
]);
