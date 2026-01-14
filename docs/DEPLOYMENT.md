# Deployment Guide

This repo deploys two CDK stacks. You can deploy either or both:

- Srp130AwsInfraStack: dev container image build pipeline (ECR, CodeBuild, CodePipeline, artifacts bucket)
- AsgardCloudEnvStack: devbox platform (VPC, EC2 devboxes, API, DynamoDB, lifecycle)

## Prerequisites

1. AWS CLI configured with admin or infrastructure credentials
2. Node.js 18+ and npm
3. AWS CDK installed: `npm install -g aws-cdk`
4. Session Manager plugin (only required for devbox usage)

## Install dependencies

```bash
npm install
cd lambda/provisioner && npm install && cd ../..
```

## Deploy the dev container build pipeline (Srp130AwsInfraStack)

```bash
cdk bootstrap  # first time per account/region
cdk deploy Srp130AwsInfraStack
```

### Post-deploy manual steps

1. Approve the CodeStar connection in the AWS console:
   - Service: CodeStar Connections
   - Connection name: `srp8-130-github-connection`
2. Upload required artifacts to the S3 bucket from the `SRP8-130_Bucket` output:
   - `qnx/qnx-sdp.tar.gz`
   - `rti/rti_connext.tar`
3. Optional: Use the `GithubActionCodebuildRoleArn` output to allow GitHub Actions to start the pipeline and read logs.

## Deploy the devbox platform (AsgardCloudEnvStack)

### Ensure IAM groups exist

The stack attaches policies to existing IAM groups. Create them if they do not exist:

```bash
aws iam create-group --group-name dev-embd-access
aws iam create-group --group-name dev-all-access
```

### Deploy

```bash
cdk deploy AsgardCloudEnvStack
```

### Outputs to note

- `ApiUrl` - base URL for the devbox API
- `ProvisionerArn` - Lambda provisioner ARN
- `UserTable` - DynamoDB table for user mappings
- `ArtifactsBucket` - S3 bucket for devbox artifacts

## After deployment

- Use DEVBOX_CONNECTION.md for provisioning and connection steps.
- If the helper scripts cannot find stack outputs, check the stack name and output keys in `scripts/devbox-cli.sh`, `scripts/connect-devbox.sh`, and `scripts/vscode-config.sh`.

## Region notes

The buildspec uses `ap-southeast-2` for ECR login and the artifacts bucket. If you deploy to another region, update `docker/buildspec.yml` and re-deploy.
