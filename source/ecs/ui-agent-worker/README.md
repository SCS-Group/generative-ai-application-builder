# UI Agent Worker (ECS Fargate)

Minimal Python worker container for the GAAB **UiAgentRunnerStack**.

## What it does (current)

- Reads `JOB_JSON` (from the dispatcher Lambda).
- Reads `GITHUB_PAT_JSON` (from AWS Secrets Manager via ECS secrets injection).
- Logs a safe, non-secret summary and exits `0`.

This is intentionally minimal so we can validate the SQS → Lambda → ECS wiring end-to-end.


