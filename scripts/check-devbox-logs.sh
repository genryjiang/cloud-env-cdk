#!/bin/bash
set -e

USER_ID=${1:-$(aws sts get-caller-identity --query Arn --output text | cut -d'/' -f2)}
STACK_NAME="AsgardCloudEnvStack"
mkdir -p scripts/logs
LOG_FILE="scripts/logs/devbox-${USER_ID}-$(date +%Y%m%d-%H%M%S).log"

exec > >(tee "$LOG_FILE") 2>&1

echo "=== Devbox Log Check ==="
echo "User: $USER_ID"
echo "Time: $(date)"
echo ""

TABLE_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='UserTable'].OutputValue" --output text)
INSTANCE_ID=$(aws dynamodb get-item --table-name $TABLE_NAME --key "{\"userId\": {\"S\": \"$USER_ID\"}}" --query "Item.instanceId.S" --output text)

if [ "$INSTANCE_ID" == "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "ERROR: No devbox found"
  exit 1
fi

echo "Instance: $INSTANCE_ID"
STATUS=$(aws ec2 describe-instances --instance-ids $INSTANCE_ID --query "Reservations[0].Instances[0].State.Name" --output text)
echo "Status: $STATUS"
echo ""

echo "=== Console Output (last 100 lines) ==="
aws ec2 get-console-output --instance-id $INSTANCE_ID --output text | tail -100
echo ""

if [ "$STATUS" == "running" ]; then
  echo "=== Docker Images ==="
  CMD_ID=$(aws ssm send-command --instance-ids $INSTANCE_ID --document-name "AWS-RunShellScript" --parameters 'commands=["docker images"]' --query "Command.CommandId" --output text)
  sleep 3
  aws ssm get-command-invocation --command-id $CMD_ID --instance-id $INSTANCE_ID --query "StandardOutputContent" --output text
  echo ""
  
  echo "=== Cloud-Init Output Log ==="
  CMD_ID=$(aws ssm send-command --instance-ids $INSTANCE_ID --document-name "AWS-RunShellScript" --parameters 'commands=["cat /var/log/cloud-init-output.log | tail -100"]' --query "Command.CommandId" --output text)
  sleep 3
  aws ssm get-command-invocation --command-id $CMD_ID --instance-id $INSTANCE_ID --query "StandardOutputContent" --output text
  echo ""
  
  echo "=== User Data Log ==="
  CMD_ID=$(aws ssm send-command --instance-ids $INSTANCE_ID --document-name "AWS-RunShellScript" --parameters 'commands=["cat /var/log/user-data.log 2>/dev/null || echo No user-data.log found"]' --query "Command.CommandId" --output text)
  sleep 3
  aws ssm get-command-invocation --command-id $CMD_ID --instance-id $INSTANCE_ID --query "StandardOutputContent" --output text
fi

echo ""
echo "Log saved to: $LOG_FILE"
