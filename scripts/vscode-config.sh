#!/bin/bash
# Generate VS Code SSH config for devbox via SSM

get_user_id() {
  local arn=""
  arn=$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null) || arn=""
  if [ -n "$arn" ] && [ "$arn" != "None" ]; then
    echo "$arn" | awk -F'[:/]' '{print $NF}'
  else
    echo "$USER"
  fi
}

USER_ID="${1:-$(get_user_id)}"
REGION="${AWS_REGION:-ap-southeast-2}"
STACK_NAME="AsgardCloudEnvStack"
SSH_USER="${SSH_USER:-ubuntu}"

TABLE_NAME=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserTable`].OutputValue' \
  --output text \
  --region "$REGION")

INSTANCE_ID=$(aws dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "{\"userId\": {\"S\": \"$USER_ID\"}}" \
  --query 'Item.instanceId.S' \
  --output text \
  --region "$REGION")

if [ "$INSTANCE_ID" == "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "❌ No devbox found"
  exit 1
fi

cat << EOF

Add this to your ~/.ssh/config:

Host devbox-$USER_ID
    HostName $INSTANCE_ID
    User $SSH_USER
    ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region $REGION"
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null

Then in VS Code:
1. Install "Remote - SSH" extension
2. Press F1 → "Remote-SSH: Connect to Host"
3. Select "devbox-$USER_ID"

Tip: override the SSH user with SSH_USER=ec2-user if needed.

EOF
