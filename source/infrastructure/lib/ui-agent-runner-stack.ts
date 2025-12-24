#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { ApplicationSetup } from './framework/application-setup';
import { BaseStack, BaseStackProps, BaseParameters } from './framework/base-stack';
import { ApplicationAssetBundler } from './framework/bundler/asset-options-factory';
import { createCustomResourceForLambdaLogRetention, createDefaultLambdaRole } from './utils/common-utils';
import { COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME, LAMBDA_TIMEOUT_MINS, LOG_RETENTION_PERIOD } from './utils/constants';
import { VPCSetup } from './vpc/vpc-setup';

export class UiAgentRunnerParameters extends BaseParameters {
    constructor(stack: cdk.Stack) {
        super(stack);
    }

    protected setupUseCaseConfigTableParams(stack: cdk.Stack): void {
        // override: not needed for this stack
    }

    protected setupUUIDParams(stack: cdk.Stack): void {
        // override: not needed for this stack
    }
}

export class UiAgentRunnerStack extends BaseStack {
    public readonly queue: sqs.Queue;
    public readonly dlq: sqs.Queue;
    public readonly cluster: ecs.Cluster;
    public readonly taskDef: ecs.FargateTaskDefinition;
    public readonly repository: ecr.Repository;
    public readonly dispatcher: lambda.Function;
    public readonly githubPatSecret: secretsmanager.Secret;

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        // Dedicated VPC for runner tasks (public subnet + public IP for MVP).
        const vpc = new ec2.Vpc(this, 'UiAgentRunnerVpc', {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }]
        });

        const runnerSg = new ec2.SecurityGroup(this, 'UiAgentRunnerSecurityGroup', {
            vpc,
            description: 'Security group for UI Agent Runner Fargate tasks (egress-only)',
            allowAllOutbound: true
        });

        // VPC Flow Logs (required by cdk-nag AwsSolutions-VPC7)
        const vpcFlowLogs = new logs.LogGroup(this, 'UiAgentRunnerVpcFlowLogs', {
            retention: LOG_RETENTION_PERIOD,
            removalPolicy: cdk.RemovalPolicy.RETAIN
        });
        vpc.addFlowLog('UiAgentRunnerVpcFlowLog', {
            destination: ec2.FlowLogDestination.toCloudWatchLogs(vpcFlowLogs)
        });

        // Queue + DLQ
        this.dlq = new sqs.Queue(this, 'UiAgentRunsDLQ', {
            retentionPeriod: cdk.Duration.days(14),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true
        });

        this.queue = new sqs.Queue(this, 'UiAgentRunsQueue', {
            visibilityTimeout: cdk.Duration.minutes(30),
            retentionPeriod: cdk.Duration.days(4),
            deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true
        });

        // ECR repo for worker image
        this.repository = new ecr.Repository(this, 'UiAgentWorkerRepository', {
            repositoryName: 'gaab-ui-agent-worker',
            imageScanOnPush: true,
            encryption: ecr.RepositoryEncryption.AES_256
        });

        this.cluster = new ecs.Cluster(this, 'UiAgentWorkerCluster', { vpc, containerInsights: true });

        const taskRole = new iam.Role(this, 'UiAgentWorkerTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: 'Task role for UI Agent Worker (invoke AgentCore + access required secrets)'
        });

        taskRole.addToPolicy(
            new iam.PolicyStatement({
                sid: 'InvokeAgentCoreRuntime',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeForUser'],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`
                ]
            })
        );

        // GitHub PAT secret placeholder
        this.githubPatSecret = new secretsmanager.Secret(this, 'UiAgentGithubPatSecret', {
            secretName: 'gaab/ui-agent/github-pat',
            description: 'GitHub PAT for UI Agent Worker (MVP). Update the secret value after deployment.',
            generateSecretString: {
                secretStringTemplate: JSON.stringify({ token: 'CHANGE_ME' }),
                generateStringKey: 'ignored',
                excludePunctuation: true
            }
        });
        this.githubPatSecret.grantRead(taskRole);

        this.taskDef = new ecs.FargateTaskDefinition(this, 'UiAgentWorkerTaskDef', {
            cpu: 2048,
            memoryLimitMiB: 4096,
            taskRole
        });

        const logGroup = new logs.LogGroup(this, 'UiAgentWorkerLogGroup', {
            retention: LOG_RETENTION_PERIOD,
            removalPolicy: cdk.RemovalPolicy.RETAIN
        });

        const workerImageTag = new cdk.CfnParameter(this, 'UiAgentWorkerImageTag', {
            type: 'String',
            default: 'latest',
            description: 'Tag for the gaab-ui-agent-worker image in ECR.'
        });

        this.taskDef.addContainer('ui-agent-worker', {
            image: ecs.ContainerImage.fromEcrRepository(this.repository, workerImageTag.valueAsString),
            logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'worker' }),
            secrets: { GITHUB_PAT_JSON: ecs.Secret.fromSecretsManager(this.githubPatSecret) }
        });

        // Dispatcher Lambda (SQS -> ECS RunTask)
        const dispatcherRole = createDefaultLambdaRole(this, 'UiAgentDispatcherLambdaRole');
        this.dispatcher = new lambda.Function(this, 'UiAgentDispatcher', {
            description: 'SQS dispatcher that launches UI Agent Worker ECS tasks (one at a time)',
            code: lambda.Code.fromAsset(
                '../lambda/ui-agent-dispatcher',
                ApplicationAssetBundler.assetBundlerFactory()
                    .assetOptions(COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME)
                    .options(this, '../lambda/ui-agent-dispatcher')
            ),
            role: dispatcherRole,
            runtime: COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(LAMBDA_TIMEOUT_MINS),
            reservedConcurrentExecutions: 1,
            environment: {
                CLUSTER_ARN: this.cluster.clusterArn,
                TASK_DEF_ARN: this.taskDef.taskDefinitionArn,
                SUBNET_IDS: vpc.publicSubnets.map((s) => s.subnetId).join(','),
                SECURITY_GROUP_ID: runnerSg.securityGroupId,
                CONTAINER_NAME: 'ui-agent-worker',
                ASSIGN_PUBLIC_IP: 'ENABLED'
            }
        });

        createCustomResourceForLambdaLogRetention(
            this,
            'UiAgentDispatcherLogRetention',
            this.dispatcher.functionName,
            this.applicationSetup.customResourceLambda.functionArn
        );

        this.dispatcher.addEventSource(
            new lambdaEventSources.SqsEventSource(this.queue, {
                batchSize: 1,
                reportBatchItemFailures: true
            })
        );
        this.queue.grantConsumeMessages(this.dispatcher);

        this.dispatcher.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'EcsRunTask',
                effect: iam.Effect.ALLOW,
                actions: ['ecs:RunTask'],
                resources: [this.taskDef.taskDefinitionArn],
                conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } }
            })
        );
        this.dispatcher.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'PassEcsTaskRoles',
                effect: iam.Effect.ALLOW,
                actions: ['iam:PassRole'],
                resources: [this.taskDef.taskRole.roleArn, this.taskDef.executionRole!.roleArn],
                conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } }
            })
        );

        // Outputs
        new cdk.CfnOutput(this, 'UiAgentRunsQueueUrl', {
            value: this.queue.queueUrl,
            description: 'SQS queue URL for n8n to enqueue UI agent runs'
        });
        new cdk.CfnOutput(this, 'UiAgentRunsQueueArn', { value: this.queue.queueArn });
        new cdk.CfnOutput(this, 'UiAgentWorkerRepositoryUri', {
            value: this.repository.repositoryUri,
            description: 'ECR repository URI for the UI agent worker image'
        });
        new cdk.CfnOutput(this, 'UiAgentWorkerTaskDefinitionArn', { value: this.taskDef.taskDefinitionArn });
        new cdk.CfnOutput(this, 'UiAgentDispatcherLambdaArn', { value: this.dispatcher.functionArn });
        new cdk.CfnOutput(this, 'UiAgentGithubPatSecretArn', { value: this.githubPatSecret.secretArn });

        NagSuppressions.addResourceSuppressions(
            dispatcherRole,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'Dispatcher needs to pass task roles and run task definition; resources are constrained to known ARNs where possible.'
                }
            ],
            true
        );

        // cdk-nag suppressions for MVP tradeoffs
        NagSuppressions.addResourceSuppressions(
            taskRole,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'AgentCore runtime ARNs are generated per agent; wildcard runtime/* is required for MVP. Restrict in product version via specific runtime ARN allowlist.'
                }
            ],
            true
        );

        const execRole = this.taskDef.executionRole as unknown as iam.Role;
        if (execRole?.node) {
            NagSuppressions.addResourceSuppressions(
                execRole.node.tryFindChild('DefaultPolicy') as iam.Policy,
                [
                    {
                        id: 'AwsSolutions-IAM5',
                        reason:
                            'ECS execution role requires wildcard permissions for ECR + logs; standard for Fargate tasks.'
                    }
                ],
                true
            );
        }

        NagSuppressions.addResourceSuppressions(
            this.githubPatSecret,
            [
                {
                    id: 'AwsSolutions-SMG4',
                    reason:
                        'MVP secret rotation is deferred; will be replaced by GitHub App short-lived tokens in product version.'
                }
            ],
            true
        );
    }

    protected initializeCfnParameters(): void {
        this.stackParameters = new UiAgentRunnerParameters(this);
    }

    protected setupVPC(): VPCSetup {
        // Not used by this stack; keep BaseStack interface happy.
        return new VPCSetup(this, 'VPC', {
            stackType: 'deployment-platform',
            deployVpcCondition: this.deployVpcCondition,
            customResourceLambdaArn: this.applicationSetup.customResourceLambda.functionArn,
            customResourceRoleArn: this.applicationSetup.customResourceLambda.role!.roleArn,
            iPamPoolId: this.iPamPoolId.valueAsString,
            accessLogBucket: this.applicationSetup.accessLoggingBucket,
            ...this.baseStackProps
        });
    }

    protected createApplicationSetup(props: BaseStackProps): ApplicationSetup {
        return new ApplicationSetup(this, 'UiAgentRunnerSetup', {
            solutionID: props.solutionID,
            solutionVersion: props.solutionVersion
        });
    }
}

