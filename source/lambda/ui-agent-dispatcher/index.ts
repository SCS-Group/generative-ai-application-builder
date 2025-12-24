import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

const ecs = new ECSClient({});

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var ${name}`);
    return v;
}

const CLUSTER_ARN = requireEnv('CLUSTER_ARN');
const TASK_DEF_ARN = requireEnv('TASK_DEF_ARN');
const SUBNET_IDS = requireEnv('SUBNET_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const SECURITY_GROUP_ID = requireEnv('SECURITY_GROUP_ID');
const CONTAINER_NAME = requireEnv('CONTAINER_NAME');
const ASSIGN_PUBLIC_IP = (process.env.ASSIGN_PUBLIC_IP ?? 'ENABLED') as 'ENABLED' | 'DISABLED';

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

    // Batch size is configured to 1, but handle multiple defensively.
    for (const record of event.Records) {
        try {
            const jobJson = record.body ?? '';
            if (!jobJson.trim()) throw new Error('Empty SQS message body');

            const cmd = new RunTaskCommand({
                cluster: CLUSTER_ARN,
                taskDefinition: TASK_DEF_ARN,
                launchType: 'FARGATE',
                networkConfiguration: {
                    awsvpcConfiguration: {
                        assignPublicIp: ASSIGN_PUBLIC_IP,
                        subnets: SUBNET_IDS,
                        securityGroups: [SECURITY_GROUP_ID]
                    }
                },
                overrides: {
                    containerOverrides: [
                        {
                            name: CONTAINER_NAME,
                            environment: [{ name: 'JOB_JSON', value: jobJson }]
                        }
                    ]
                }
            });

            const res = await ecs.send(cmd);
            if (!res.tasks?.length) {
                throw new Error(`RunTask returned no tasks: ${JSON.stringify(res.failures ?? [])}`);
            }
        } catch (err: any) {
            console.error('Failed to dispatch job', {
                messageId: record.messageId,
                err: err?.message ?? String(err)
            });
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }

    return { batchItemFailures };
};
