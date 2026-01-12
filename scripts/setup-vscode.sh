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

echo "Configuring SSH for devbox $instance_id..."

mkdir -p ~/.ssh
touch ~/.ssh/config

if grep -q "Host devbox" ~/.ssh/config; then
  sed -i.bak "/Host devbox/,/ProxyCommand/d" ~/.ssh/config
fi

cat >> ~/.ssh/config << EOF

Host devbox
    HostName $instance_id
    User ec2-user
    ForwardAgent yes
    ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region $REGION"
EOF

echo "✅ SSH config updated!"
echo ""
echo "Next steps:"
echo "1. Install VS Code extensions:"
echo "   code --install-extension ms-vscode-remote.remote-ssh"
echo "   code --install-extension ms-vscode-remote.remote-containers"
echo ""
echo "2. Add your GitHub SSH key to agent:"
echo "   ssh-add ~/.ssh/id_rsa"
echo ""
echo "3. Connect in VS Code:"
echo "   F1 → Remote-SSH: Connect to Host → devbox"
echo ""
echo "4. Clone repo in /home/ec2-user/workspace"
echo ""
echo "5. Reopen in Dev Container:"
echo "   F1 → Dev Containers: Reopen in Container"
