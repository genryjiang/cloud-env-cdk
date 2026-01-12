#!/bin/bash
# Devbox Connection Helper Script

set -e

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

echo "🔍 Looking up devbox for user: $USER_ID"

# Get instance ID from DynamoDB
TABLE_NAME=$(aws cloudformation describe-stacks \
  --stack-name AsgardCloudEnvStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UserTable`].OutputValue' \
  --output text \
  --region $REGION)

INSTANCE_ID=$(aws dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "{\"userId\": {\"S\": \"$USER_ID\"}}" \
  --query 'Item.instanceId.S' \
  --output text \
  --region $REGION)

if [ "$INSTANCE_ID" == "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "No devbox found for user $USER_ID"
  echo "Provision one first using the Lambda function"
  exit 1
fi

echo "Found instance: $INSTANCE_ID"
echo " Connecting via SSM Session Manager..."
echo ""

# Connect via SSM
aws ssm start-session \
  --target "$INSTANCE_ID" \
  --region $REGION
