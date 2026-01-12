# Devbox Connection Guide

This guide covers provisioning and connecting to a devbox. For deployment, see DEPLOYMENT.md.

## Prerequisites

- AWS CLI configured for your account
- Session Manager plugin
- jq (required by scripts/devbox-cli.sh)

## Quick start (CLI)

```bash
./scripts/devbox-cli.sh provision
./scripts/devbox-cli.sh connect
```

If you omit the userId argument, the scripts default to the caller ARN username (last segment of the ARN) from `aws sts get-caller-identity` (fallback: `$USER`). To override, pass a userId explicitly.

If the CLI cannot find the API URL, check the stack name and output key in `scripts/devbox-cli.sh`. The devbox stack outputs `ApiUrl` from `AsgardCloudEnvStack`.

## Provision via API (manual)

```bash
API_URL=$(aws cloudformation describe-stacks \
  --stack-name AsgardCloudEnvStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
  --output text)

USER_ID=$(aws sts get-caller-identity --query 'Arn' --output text | awk -F'[:/]' '{print $NF}')

curl -X POST "${API_URL}devbox" \
  -H "Content-Type: application/json" \
  -d '{"action": "provision", "userId": "'"$USER_ID"'"}'
```

## Connect via terminal

```bash
./scripts/connect-devbox.sh
```

or, if you already know the instance ID:

```bash
aws ssm start-session --target i-xxxxxxxx --region ap-southeast-2
```

## VS Code Remote-SSH

1. Generate SSH config:

   ```bash
   ./scripts/vscode-config.sh >> ~/.ssh/config
   ```

2. In VS Code:
   - Install the "Remote - SSH" extension
   - Run "Remote-SSH: Connect to Host"
   - Select `devbox-<userId>`

## Dev Containers

The build pipeline publishes the dev container image to ECR as:

- `embd_dev_ecr:linux-amd64-latest`
- `embd_dev_ecr:linux-amd64-<gitsha>`

If the image is not already on the devbox, pull it manually:

```bash
REGION=ap-southeast-2
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

docker pull "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/embd_dev_ecr:linux-amd64-latest"
```

Then in VS Code, run "Dev Containers: Reopen in Container" in the repo.

## Troubleshooting

- "No devbox found": provision first, or check the user entry in DynamoDB.
- SSM connection timeout: confirm the instance is running and has the SSM agent.
- VS Code cannot connect: verify the Session Manager plugin and AWS credentials.
