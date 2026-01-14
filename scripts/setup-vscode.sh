#!/bin/bash
# Setup VS Code Remote-SSH for devbox

set -e

REGION="${AWS_REGION:-ap-southeast-2}"
STACK_NAME="AsgardCloudEnvStack"

get_user_id() {
  arn=$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null)
  echo "$arn" | awk -F'[:/]' '{print $NF}'
}

get_api_url() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?contains(OutputKey,`DevboxApiUrl`)].OutputValue | [0]' \
    --output text \
    --region "$REGION"
}

user_id=$(get_user_id)
api_url=$(get_api_url)

response=$(curl -s -X POST "${api_url}devbox" \
  -H "Content-Type: application/json" \
  -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")

instance_id=$(echo "$response" | jq -r '.instanceId')

if [ "$instance_id" = "null" ]; then
  echo "No devbox found. Run: bash scripts/devbox-cli.sh provision"
  exit 1
fi

echo "✅ Devbox found: $instance_id"
echo ""
echo "Connect via SSM (terminal only):"
echo "  bash scripts/devbox-cli.sh connect"
echo ""
echo "For VS Code Remote-SSH + Dev Containers:"
echo "1. Terminal 1 (keep running):"
echo "   aws ssm start-session --target $instance_id --document-name AWS-StartPortForwardingSession --parameters 'portNumber=22,localPortNumber=2222' --region $REGION"
echo ""
echo "2. Add to ~/.ssh/config:"
echo "   Host devbox"
echo "       HostName localhost"
echo "       User ec2-user"
echo "       Port 2222"
echo "       StrictHostKeyChecking no"
echo "       UserKnownHostsFile /dev/null"
echo ""
echo "3. Generate temporary SSH key (valid 60 seconds):"
echo "   aws ec2-instance-connect send-ssh-public-key --instance-id $instance_id --instance-os-user ec2-user --ssh-public-key file://~/.ssh/id_ed25519.pub --region $REGION"
echo ""
echo "4. Within 60 seconds, connect:"
echo "   ssh devbox"
echo "   OR VS Code: F1 → Remote-SSH: Connect to Host → devbox"
echo ""
echo "5. Clone repo in /home/ec2-user/workspace, then F1 → Dev Containers: Reopen in Container"
