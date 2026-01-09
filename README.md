# EMBD High Dev Infra

This repository defines the AWS infrastructure for the embedded development environment. It contains two CDK stacks:

- Srp130AwsInfraStack: builds and publishes the dev container image to ECR and manages build artifacts.
- AsgardCloudEnvStack: provisions per-user EC2 devboxes and the API used to manage them.

If you only want the big picture, start with the system rundown below.

## System rundown

1. CodePipeline watches this repo via a CodeStar connection and runs CodeBuild.
2. CodeBuild builds the dev container image from `docker/Dockerfile`. It pulls licensed blobs (QNX/RTI) from the S3 bucket `sr8-embd-dev-env-<region>`.
3. The image is pushed to ECR as `embd_dev_ecr:linux-amd64-*`.
4. The devbox API (API Gateway + Lambda) receives provisioning requests and stores userId -> instanceId in DynamoDB.
5. The Lambda launches an EC2 instance from a launch template inside a private VPC that only has SSM/ECR/S3 endpoints.
6. On first boot the instance installs Docker, creates `/home/ec2-user/workspace`, and attempts to pre-pull the dev container image.
7. Developers connect via SSM (terminal or VS Code Remote-SSH) and open the repo in a Dev Container.
8. A scheduled cleanup Lambda stops idle instances and terminates long-running ones.

## Where to start

- DEPLOYMENT.md - deploy both stacks and required manual steps
- DEVBOX_README.md - devbox platform overview
- DEVBOX_CONNECTION.md - connect and use VS Code
- IAM_GROUPS.md - IAM groups and access model

## Repo layout

- bin/ - CDK app entrypoint and stack names
- lib/srp-130_aws_infra-stack.ts - dev container build pipeline
- lib/cloud-dev-env.ts and lib/constructs/ - devbox platform
- lambda/provisioner/ - devbox provisioning Lambda
- docker/ - dev container build files
- scripts/ - helper scripts for devbox connection

## Quick start

See DEPLOYMENT.md for full steps. In short:

```bash
npm install
cd lambda/provisioner && npm install && cd ../..
cdk deploy Srp130AwsInfraStack
cdk deploy AsgardCloudEnvStack
```

Stack names are set in `bin/srp-130_aws_infra.ts`. If you rename them, update any scripts that read CloudFormation outputs.
