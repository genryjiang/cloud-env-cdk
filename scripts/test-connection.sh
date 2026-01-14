#!/bin/bash
# Test devbox connectivity - SSM and SSH

set -e

REGION="${AWS_REGION:-ap-southeast-2}"
STACK_NAME="AsgardCloudEnvStack"

echo "=== Devbox Connection Test ==="
echo ""

# Get user ID
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
echo "User: $USER_ID"

# Get instance ID
API_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?contains(OutputKey,`DevboxApiUrl`)].OutputValue | [0]' \
  --output text \
  --region "$REGION")

response=$(curl -s -X POST "${API_URL}devbox" \
  -H "Content-Type: application/json" \
  -d "{\"action\": \"status\", \"userId\": \"$USER_ID\"}")

INSTANCE_ID=$(echo "$response" | jq -r '.instanceId')
STATUS=$(echo "$response" | jq -r '.status')

if [ "$INSTANCE_ID" = "null" ]; then
  echo "❌ No devbox found. Provision one first:"
  echo "   ./scripts/devbox-cli.sh provision"
  exit 1
fi

echo "Instance: $INSTANCE_ID"
echo "Status: $STATUS"
echo ""

if [ "$STATUS" != "running" ]; then
  echo "❌ Instance is not running. Start it first:"
  echo "   ./scripts/devbox-cli.sh start"
  exit 1
fi

# Test 1: SSM connectivity
echo "=== Test 1: SSM Session Manager ==="
echo "Testing basic SSM connection..."

CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["echo SSM_TEST_SUCCESS"]' \
  --region "$REGION" \
  --output text \
  --query 'Command.CommandId')

echo "Waiting for command to complete..."
sleep 3

OUTPUT=$(aws ssm get-command-invocation \
  --command-id "$CMD_ID" \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'StandardOutputContent' \
  --output text)

if [[ "$OUTPUT" == *"SSM_TEST_SUCCESS"* ]]; then
  echo "✅ SSM connection working"
else
  echo "❌ SSM connection failed"
  exit 1
fi
echo ""

# Test 2: SSH daemon
echo "=== Test 2: SSH Daemon ==="
echo "Checking if SSH is running..."

CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["systemctl is-active sshd"]' \
  --region "$REGION" \
  --output text \
  --query 'Command.CommandId')

sleep 3

SSH_STATUS=$(aws ssm get-command-invocation \
  --command-id "$CMD_ID" \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'StandardOutputContent' \
  --output text | tr -d '\n')

if [ "$SSH_STATUS" = "active" ]; then
  echo "✅ SSH daemon is running"
else
  echo "❌ SSH daemon is not active: $SSH_STATUS"
fi
echo ""

# Test 3: Session Manager Plugin
echo "=== Test 3: Session Manager Plugin ==="
if command -v session-manager-plugin &> /dev/null; then
  echo "✅ Session Manager plugin installed"
else
  echo "❌ Session Manager plugin not found"
  echo "   Install from: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"
fi
echo ""

# Test 4: SSH key
echo "=== Test 4: SSH Key ==="
if [ -f "$HOME/.ssh/id_ed25519.pub" ]; then
  echo "✅ SSH key found: ~/.ssh/id_ed25519.pub"
  SSH_KEY="$HOME/.ssh/id_ed25519"
elif [ -f "$HOME/.ssh/id_rsa.pub" ]; then
  echo "✅ SSH key found: ~/.ssh/id_rsa.pub"
  SSH_KEY="$HOME/.ssh/id_rsa"
else
  echo "❌ No SSH key found. Generate one:"
  echo "   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519"
  SSH_KEY=""
fi
echo ""

# Test 5: Interactive SSM session
echo "=== Test 5: Interactive SSM Session ==="
echo "Starting interactive SSM session..."
echo "Type 'whoami' then 'exit' to test"
echo ""
aws ssm start-session --target "$INSTANCE_ID" --region "$REGION"

echo ""
echo "=== Test 6: SSH over SSM (optional) ==="
if [ -n "$SSH_KEY" ]; then
  echo "Would you like to test SSH over SSM? (y/n)"
  read -r answer
  if [ "$answer" = "y" ]; then
    echo "Pushing SSH key..."
    aws ec2-instance-connect send-ssh-public-key \
      --instance-id "$INSTANCE_ID" \
      --instance-os-user "ec2-user" \
      --ssh-public-key "file://${SSH_KEY}.pub" \
      --region "$REGION"
    
    echo "Connecting via SSH over SSM..."
    ssh -i "$SSH_KEY" \
      -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o "ProxyCommand=aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region $REGION" \
      "ec2-user@$INSTANCE_ID"
  fi
fi

echo ""
echo "=== Connection Test Complete ==="
