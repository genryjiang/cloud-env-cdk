# Devbox Platform Overview

The devbox platform (AsgardCloudEnvStack) creates per-user EC2 instances for development. Access is through AWS SSM Session Manager, so there are no inbound SSH ports or keys.

## Core components

- VPC with private isolated subnets and VPC endpoints for SSM, ECR, and S3
- Launch template: Amazon Linux 2023, t3.medium, 50 GB EBS, Docker installed
- DynamoDB table that maps userId -> instanceId
- Lambda provisioner that creates, stops, and terminates instances
- API Gateway endpoint at `/devbox` for provisioning and status
- S3 bucket for devbox build artifacts
- Scheduled cleanup Lambda (hourly)
- Dev container image pulled from ECR `embd_dev_ecr` (built by Srp130AwsInfraStack)

## Lifecycle behavior

- Idle stop: running instances with average CPU below 5 percent over the last 2 hours are stopped.
- Age cleanup: running instances older than 7 days are terminated (if not already stopped).

## Typical workflow

1. Provision a devbox (CLI or API)
2. Wait 2 to 3 minutes for first boot
3. Connect via SSM or VS Code Remote-SSH
4. Open your repo and use Dev Containers
5. Stop or terminate the devbox when finished

## Architecture (text)

Developer laptop -> SSM Session Manager -> EC2 devbox (Docker, workspace)
EC2 devbox -> ECR (dev container image)
EC2 devbox -> S3 (artifacts)

## Files to know

- lib/cloud-dev-env.ts
- lib/constructs/devbox-network.ts
- lib/constructs/devbox-shared-resources.ts
- lib/constructs/devbox-provisioner.ts
- lib/constructs/devbox-lifecycle.ts
- lib/constructs/devbox-api.ts
- lambda/provisioner/index.js
- scripts/devbox-cli.sh
- scripts/connect-devbox.sh
- scripts/vscode-config.sh

## Cost notes

- Default instance type is t3.medium with a 50 GB EBS root volume.
- Stopped instances still incur EBS storage charges.
- The cleanup job is designed to reduce cost for idle environments.
