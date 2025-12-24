// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { APIGatewayEvent } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminUpdateUserAttributesCommand,
    ListUsersInGroupCommand,
    CognitoIdentityProviderClient
} from '@aws-sdk/client-cognito-identity-provider';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { AWSClientManager } from 'aws-sdk-lib';
import { logger, metrics, tracer } from './power-tools-init';
import { checkEnv, handleLambdaError, parseEventBody } from './utils/utils';
import { formatResponse } from './utils/http-response-formatters';
import {
    CUSTOMER_ADMIN_GROUP_NAME,
    CUSTOMER_USER_GROUP_NAME,
    PLATFORM_ADMIN_GROUP_NAME,
    SUPERVISOR_ASSIGNMENTS_TABLE_NAME_ENV_VAR,
    TENANTS_REQUIRED_ENV_VARS,
    TENANTS_TABLE_NAME_ENV_VAR,
    USER_POOL_ID_ENV_VAR
} from './utils/constants';

type Role = 'customer_admin' | 'customer_user';

const extractGroupsFromAuthorizer = (event: APIGatewayEvent): string[] => {
    const ctx: any = event.requestContext?.authorizer ?? {};
    const groupsRaw = ctx.Groups;
    if (!groupsRaw) return [];
    try {
        const groups = JSON.parse(groupsRaw);
        return Array.isArray(groups) ? groups.filter((x) => typeof x === 'string') : [];
    } catch {
        return String(groupsRaw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }
};

const isCustomerAdmin = (event: APIGatewayEvent): boolean => {
    return extractGroupsFromAuthorizer(event).includes(CUSTOMER_ADMIN_GROUP_NAME);
};

const isPlatformAdmin = (event: APIGatewayEvent): boolean => {
    const ctx: any = event.requestContext?.authorizer ?? {};
    const groupsRaw = ctx.Groups;
    if (!groupsRaw) return false;
    try {
        const groups = JSON.parse(groupsRaw);
        return Array.isArray(groups) && groups.includes(PLATFORM_ADMIN_GROUP_NAME);
    } catch {
        // fallback: comma separated
        return String(groupsRaw).split(',').map((s) => s.trim()).includes(PLATFORM_ADMIN_GROUP_NAME);
    }
};

const getTenantIdFromAuthorizer = (event: APIGatewayEvent): string | undefined => {
    const ctx: any = event.requestContext?.authorizer ?? {};
    const tenantId = ctx.TenantId;
    return tenantId ? String(tenantId) : undefined;
};

const ddbDoc = () => DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));
const cognito = () =>
    AWSClientManager.getServiceClient<CognitoIdentityProviderClient>('cognito', tracer);

const ok = (body: any) => formatResponse(body);
const badRequest = (message: string) => ({
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
});
const conflict = (message: string) => ({
    statusCode: 409,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
});

const usernameFromEmailPrefix = (email: string): string => {
    const raw = email.trim().toLowerCase();
    const prefix = raw.includes('@') ? raw.split('@')[0] : raw;
    return prefix;
};

const sanitizeUsername = (username: string): string => {
    // Keep it simple and predictable. Cognito usernames support more chars, but we choose a conservative set.
    // Replace anything outside [a-z0-9._-] with '-'.
    const cleaned = username
        .trim()
        .toLowerCase()
        .replace(/@/g, '') // never allow email format
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
    return cleaned.length <= 128 ? cleaned : cleaned.slice(0, 128);
};

export const tenantsLambdaHandler = async (event: APIGatewayEvent) => {
    checkEnv(TENANTS_REQUIRED_ENV_VARS);

    const routeKey = `${event.httpMethod}:${event.resource}`;

    try {
        // Customer/admin: identity endpoint
        if (routeKey === 'GET:/portal/me') {
            return ok({
                userId: (event.requestContext?.authorizer as any)?.UserId ?? null,
                email: (event.requestContext?.authorizer as any)?.Email ?? null,
                tenantId: getTenantIdFromAuthorizer(event) ?? null,
                groups: (() => {
                    const raw = (event.requestContext?.authorizer as any)?.Groups;
                    if (!raw) return [];
                    try {
                        return JSON.parse(raw);
                    } catch {
                        return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
                    }
                })()
            });
        }

        // Customer portal: list tenant users (customer-admin only)
        if (routeKey === 'GET:/portal/users') {
            if (!isCustomerAdmin(event)) {
                return {
                    statusCode: 403,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: 'Forbidden' })
                };
            }
            const tenantId = getTenantIdFromAuthorizer(event);
            if (!tenantId) {
                return {
                    statusCode: 403,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: 'Missing tenant context' })
                };
            }

            const userPoolId = process.env[USER_POOL_ID_ENV_VAR]!;

            const fetchGroupUsers = async (groupName: string) => {
                const resp = await cognito().send(
                    new ListUsersInGroupCommand({
                        UserPoolId: userPoolId,
                        GroupName: groupName,
                        Limit: 60
                    })
                );
                const users = resp.Users ?? [];
                return users.map((u) => ({ groupName, user: u }));
            };

            // We include both customer_admin + customer_user for the tenant.
            const all = [...(await fetchGroupUsers(CUSTOMER_ADMIN_GROUP_NAME)), ...(await fetchGroupUsers(CUSTOMER_USER_GROUP_NAME))];

            const rows = all
                .map(({ groupName, user }) => {
                    const attrs = (user.Attributes ?? []).reduce<Record<string, string>>((acc, a) => {
                        if (a?.Name && typeof a.Value === 'string') acc[a.Name] = a.Value;
                        return acc;
                    }, {});
                    const tid = attrs['custom:tenant_id'] ?? '';
                    if (tid !== tenantId) return null;

                    const userStatus = String((user as any).UserStatus ?? '');
                    const enabled = (user as any).Enabled !== false;
                    const status =
                        !enabled
                            ? 'disabled'
                            : userStatus === 'FORCE_CHANGE_PASSWORD'
                              ? 'invited'
                              : userStatus === 'CONFIRMED'
                                ? 'active'
                                : userStatus.toLowerCase() || 'unknown';

                    return {
                        username: user.Username ?? '',
                        email: attrs.email ?? '',
                        status,
                        userStatus,
                        enabled,
                        groupName,
                        createdAt: (user as any).UserCreateDate ?? null,
                        updatedAt: (user as any).UserLastModifiedDate ?? null
                    };
                })
                .filter(Boolean) as Array<any>;

            // De-dupe by username (in case of edge overlap)
            const seen = new Set<string>();
            const users = rows.filter((u) => {
                const k = String(u.username || '');
                if (!k || seen.has(k)) return false;
                seen.add(k);
                return true;
            });

            return ok({ tenantId, users });
        }

        // Customer portal: invite tenant user (customer-admin only)
        if (routeKey === 'POST:/portal/users') {
            if (!isCustomerAdmin(event)) {
                return {
                    statusCode: 403,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: 'Forbidden' })
                };
            }
            const tenantId = getTenantIdFromAuthorizer(event);
            if (!tenantId) return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Missing tenant context' }) };

            const body = parseEventBody(event);
            const email = String(body?.email ?? '').trim().toLowerCase();
            const requestedUsername = body?.username ? String(body.username) : '';
            if (!email) return badRequest('email is required');

            const userPoolId = process.env[USER_POOL_ID_ENV_VAR]!;
            let usernameBase =
                requestedUsername.trim().length > 0 ? requestedUsername : usernameFromEmailPrefix(email);
            if (usernameBase.includes('@')) return badRequest('username must not be an email address');
            usernameBase = sanitizeUsername(usernameBase);
            if (!usernameBase) return badRequest('username is invalid');

            // Create user (handle rare username collisions with suffix)
            let createdUsername = usernameBase;
            try {
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        await cognito().send(
                            new AdminCreateUserCommand({
                                UserPoolId: userPoolId,
                                Username: createdUsername,
                                DesiredDeliveryMediums: ['EMAIL'],
                                UserAttributes: [
                                    { Name: 'email', Value: email },
                                    { Name: 'email_verified', Value: 'true' }
                                ]
                            })
                        );
                        break;
                    } catch (inner: any) {
                        const innerName = inner?.name ?? inner?.code;
                        if (innerName === 'UsernameExistsException') {
                            const suffix = randomUUID().split('-')[0];
                            createdUsername = sanitizeUsername(`${usernameBase}-${suffix}`);
                            continue;
                        }
                        throw inner;
                    }
                }
            } catch (e: any) {
                const name = e?.name ?? e?.code;
                if (name === 'AliasExistsException' || name === 'UsernameExistsException') {
                    return conflict('A user with this email already exists.');
                }
                if (name === 'InvalidParameterException') {
                    return badRequest(e?.message ?? 'Invalid request');
                }
                throw e;
            }

            await cognito().send(
                new AdminUpdateUserAttributesCommand({
                    UserPoolId: userPoolId,
                    Username: createdUsername,
                    UserAttributes: [{ Name: 'custom:tenant_id', Value: tenantId }]
                })
            );
            await cognito().send(
                new AdminAddUserToGroupCommand({
                    UserPoolId: userPoolId,
                    Username: createdUsername,
                    GroupName: CUSTOMER_USER_GROUP_NAME
                })
            );

            return ok({ username: createdUsername, email, tenantId, role: 'customer_user', groupName: CUSTOMER_USER_GROUP_NAME });
        }

        // Customer portal: get supervisors for a use case (customer-admin only)
        if (routeKey === 'GET:/portal/use-cases/{useCaseId}/supervisors') {
            if (!isCustomerAdmin(event)) {
                return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Forbidden' }) };
            }
            const tenantId = getTenantIdFromAuthorizer(event);
            if (!tenantId) {
                return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Missing tenant context' }) };
            }

            const useCaseId = String((event.pathParameters as any)?.useCaseId ?? '').trim();
            if (!useCaseId) return badRequest('useCaseId is required');

            const tableName = process.env[SUPERVISOR_ASSIGNMENTS_TABLE_NAME_ENV_VAR]!;
            const resp = await ddbDoc().send(
                new QueryCommand({
                    TableName: tableName,
                    KeyConditionExpression: 'tenantId = :t AND begins_with(assignmentId, :pfx)',
                    ExpressionAttributeValues: {
                        ':t': tenantId,
                        ':pfx': `${useCaseId}#`
                    }
                })
            );

            const usernames = (resp.Items ?? [])
                .map((i: any) => String(i?.username ?? ''))
                .filter(Boolean)
                .sort((a, b) => a.localeCompare(b));

            return ok({ tenantId, useCaseId, usernames });
        }

        // Customer portal: set supervisors for a use case (customer-admin only)
        if (routeKey === 'PUT:/portal/use-cases/{useCaseId}/supervisors') {
            if (!isCustomerAdmin(event)) {
                return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Forbidden' }) };
            }
            const tenantId = getTenantIdFromAuthorizer(event);
            if (!tenantId) {
                return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Missing tenant context' }) };
            }

            const useCaseId = String((event.pathParameters as any)?.useCaseId ?? '').trim();
            if (!useCaseId) return badRequest('useCaseId is required');

            const body = parseEventBody(event);
            const usernamesIn = Array.isArray(body?.usernames) ? body.usernames : [];
            const usernames = usernamesIn
                .map((u: any) => String(u ?? '').trim())
                .filter(Boolean)
                .slice(0, 100);

            const tableName = process.env[SUPERVISOR_ASSIGNMENTS_TABLE_NAME_ENV_VAR]!;

            // Delete existing assignments for this use case
            const existing = await ddbDoc().send(
                new QueryCommand({
                    TableName: tableName,
                    KeyConditionExpression: 'tenantId = :t AND begins_with(assignmentId, :pfx)',
                    ExpressionAttributeValues: {
                        ':t': tenantId,
                        ':pfx': `${useCaseId}#`
                    }
                })
            );

            const deletes = (existing.Items ?? []).map((i: any) => ({
                DeleteRequest: {
                    Key: { tenantId, assignmentId: String(i.assignmentId) }
                }
            }));

            const now = new Date().toISOString();
            const puts = Array.from(new Set(usernames)).map((username) => ({
                PutRequest: {
                    Item: {
                        tenantId,
                        assignmentId: `${useCaseId}#${username}`,
                        useCaseId,
                        username,
                        tenantUser: `${tenantId}#${username}`,
                        updatedAt: now
                    }
                }
            }));

            const allWrites = [...deletes, ...puts];
            for (let i = 0; i < allWrites.length; i += 25) {
                const chunk = allWrites.slice(i, i + 25);
                if (chunk.length === 0) continue;
                await ddbDoc().send(
                    new BatchWriteCommand({
                        RequestItems: {
                            [tableName]: chunk as any
                        }
                    })
                );
            }

            return ok({ tenantId, useCaseId, usernames: Array.from(new Set(usernames)).sort() });
        }

        // Customer portal: list use cases supervised by current user (customer-user + customer-admin)
        if (routeKey === 'GET:/portal/my/supervised-use-cases') {
            const tenantId = getTenantIdFromAuthorizer(event);
            if (!tenantId) {
                return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Missing tenant context' }) };
            }

            const username = String((event.requestContext?.authorizer as any)?.UserId ?? '').trim();
            if (!username) {
                return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Missing user context' }) };
            }

            const tableName = process.env[SUPERVISOR_ASSIGNMENTS_TABLE_NAME_ENV_VAR]!;
            const tenantUser = `${tenantId}#${username}`;
            const resp = await ddbDoc().send(
                new QueryCommand({
                    TableName: tableName,
                    IndexName: 'TenantUserIndex',
                    KeyConditionExpression: 'tenantUser = :tu',
                    ExpressionAttributeValues: {
                        ':tu': tenantUser
                    }
                })
            );

            const useCaseIds = Array.from(
                new Set((resp.Items ?? []).map((i: any) => String(i?.useCaseId ?? '')).filter(Boolean))
            ).sort((a, b) => a.localeCompare(b));
            return ok({ tenantId, username, useCaseIds });
        }

        // Admin-only endpoints
        if (!isPlatformAdmin(event)) {
            return {
                statusCode: 403,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Forbidden' })
            };
        }

        if (routeKey === 'POST:/platform/tenants') {
            const body = parseEventBody(event);
            const name = String(body?.name ?? '').trim();
            const slug = String(body?.slug ?? '').trim().toLowerCase();
            if (!name || !slug) {
                return {
                    statusCode: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: 'name and slug are required' })
                };
            }

            const tenantId = randomUUID();
            const now = new Date().toISOString();
            await ddbDoc().send(
                new PutCommand({
                    TableName: process.env[TENANTS_TABLE_NAME_ENV_VAR]!,
                    Item: {
                        tenantId,
                        name,
                        slug,
                        status: 'ACTIVE',
                        createdAt: now,
                        updatedAt: now
                    },
                    ConditionExpression: 'attribute_not_exists(tenantId)'
                })
            );

            return ok({ tenantId, name, slug, status: 'ACTIVE', createdAt: now });
        }

        if (routeKey === 'GET:/platform/tenants') {
            const resp = await ddbDoc().send(
                new ScanCommand({
                    TableName: process.env[TENANTS_TABLE_NAME_ENV_VAR]!,
                    Limit: 100
                })
            );
            return ok({ items: resp.Items ?? [] });
        }

        if (routeKey === 'POST:/platform/tenants/{tenantId}/users') {
            const tenantId = event.pathParameters?.tenantId;
            if (!tenantId) {
                return badRequest('tenantId path parameter is required');
            }

            const body = parseEventBody(event);
            const email = String(body?.email ?? '').trim().toLowerCase();
            const role = String(body?.role ?? '').trim() as Role;
            const requestedUsername = body?.username ? String(body.username) : '';
            if (!email || !['customer_admin', 'customer_user'].includes(role)) {
                return badRequest('email and role (customer_admin|customer_user) are required');
            }

            const userPoolId = process.env[USER_POOL_ID_ENV_VAR]!;
            // Username cannot be an email when email aliases are enabled. Users will sign in with email.
            // We use a readable username derived from the email prefix by default, but admins can override it.
            let usernameBase = requestedUsername.trim().length > 0 ? requestedUsername : usernameFromEmailPrefix(email);
            if (usernameBase.includes('@')) {
                return badRequest('username must not be an email address');
            }
            usernameBase = sanitizeUsername(usernameBase);
            if (!usernameBase) {
                return badRequest('username is invalid');
            }

            try {
                // Handle rare collisions (same username requested for different emails).
                // Retry a couple times with a suffix.
                let createdUsername = usernameBase;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        await cognito().send(
                            new AdminCreateUserCommand({
                                UserPoolId: userPoolId,
                                Username: createdUsername,
                                DesiredDeliveryMediums: ['EMAIL'],
                                UserAttributes: [
                                    { Name: 'email', Value: email },
                                    { Name: 'email_verified', Value: 'true' }
                                ]
                            })
                        );
                        usernameBase = createdUsername;
                        break;
                    } catch (inner: any) {
                        const innerName = inner?.name ?? inner?.code;
                        if (innerName === 'UsernameExistsException') {
                            const suffix = randomUUID().split('-')[0];
                            createdUsername = sanitizeUsername(`${usernameBase}-${suffix}`);
                            continue;
                        }
                        throw inner;
                    }
                }
            } catch (e: any) {
                const name = e?.name ?? e?.code;
                // If this email already exists (email alias is unique), surface a clear response for the UI.
                if (name === 'AliasExistsException' || name === 'UsernameExistsException') {
                    return conflict('A user with this email already exists.');
                }
                if (name === 'InvalidParameterException') {
                    return badRequest(e?.message ?? 'Invalid request');
                }
                throw e;
            }

            await cognito().send(
                new AdminUpdateUserAttributesCommand({
                    UserPoolId: userPoolId,
                    Username: usernameBase,
                    UserAttributes: [{ Name: 'custom:tenant_id', Value: tenantId }]
                })
            );

            const groupName = role === 'customer_admin' ? CUSTOMER_ADMIN_GROUP_NAME : CUSTOMER_USER_GROUP_NAME;
            await cognito().send(
                new AdminAddUserToGroupCommand({
                    UserPoolId: userPoolId,
                    Username: usernameBase,
                    GroupName: groupName
                })
            );

            return ok({ username: usernameBase, email, tenantId, role, groupName });
        }

        return {
            statusCode: 404,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `No route for ${routeKey}` })
        };
    } catch (error: unknown) {
        const action = event.httpMethod && event.resource ? `${event.httpMethod}:${event.resource}` : 'unknown';
        return handleLambdaError(error, action, 'Tenant');
    }
};

export const tenantsHandler = middy(tenantsLambdaHandler).use([
    captureLambdaHandler(tracer),
    injectLambdaContext(logger),
    logMetrics(metrics)
]);


