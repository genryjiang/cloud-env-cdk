#!/bin/bash
# Devbox CLI for SSO Users

set -e

PROFILE="${AWS_PROFILE:-devbox}"
REGION="${AWS_REGION:-ap-southeast-2}"
STACK_NAME="AsgardCloudEnvStack"

echo "Using AWS profile: $PROFILE"

# Get SSO username
get_sso_username() {
  aws sts get-caller-identity --profile "$PROFILE" --query 'Arn' --output text | awk -F'/' '{print $NF}'
}

# Get API URL from CloudFormation
get_api_url() {
  aws cloudformation describe-stacks \
    --profile "$PROFILE" \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?contains(OutputKey,`DevboxApiUrl`)].OutputValue | [0]' \
    --output text \
    --region "$REGION"
}

# Provision devbox
provision() {
  local user_id=$(get_sso_username)
  local api_url=$(get_api_url)
  
  echo "Provisioning devbox for $user_id..."
  
  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"provision\", \"userId\": \"$user_id\"}")
  
  echo "$response" | jq .
  
  instance_id=$(echo "$response" | jq -r '.instanceId')
  
  if [ "$instance_id" != "null" ]; then
    echo ""
    echo "✅ Devbox provisioned: $instance_id"
    echo ""
    echo "Next steps:"
    echo "  1. Wait 2-3 minutes for setup to complete"
    echo "  2. Add SSH key: $0 add-key"
    echo "  3. Add to SSH config: $0 ssh-config"
    echo "  4. Connect: ssh devbox-$user_id"
  fi
}

# Get status
status() {
  local user_id=$(get_sso_username)
  local api_url=$(get_api_url)
  
  curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}" | jq .
}

# Add SSH key to instance
add_key() {
  local user_id=$(get_sso_username)
  local api_url=$(get_api_url)
  
  # Get instance ID
  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")
  
  instance_id=$(echo "$response" | jq -r '.instanceId')
  
  if [ "$instance_id" = "null" ]; then
    echo "❌ No devbox found. Provision one first: $0 provision"
    exit 1
  fi
  
  # Find SSH key
  if [ -f "$HOME/.ssh/id_ed25519.pub" ]; then
    pub_key=$(cat "$HOME/.ssh/id_ed25519.pub")
  elif [ -f "$HOME/.ssh/id_rsa.pub" ]; then
    pub_key=$(cat "$HOME/.ssh/id_rsa.pub")
  else
    echo "❌ No SSH key found. Generate one:"
    echo "   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519"
    exit 1
  fi
  
  echo "Adding SSH key to $instance_id..."
  
  aws ssm send-command \
    --profile "$PROFILE" \
    --instance-ids "$instance_id" \
    --document-name "AWS-RunShellScript" \
    --parameters "commands=[\"mkdir -p /home/ec2-user/.ssh\",\"echo '$pub_key' >> /home/ec2-user/.ssh/authorized_keys\",\"chmod 700 /home/ec2-user/.ssh\",\"chmod 600 /home/ec2-user/.ssh/authorized_keys\",\"chown -R ec2-user:ec2-user /home/ec2-user/.ssh\",\"sort -u /home/ec2-user/.ssh/authorized_keys -o /home/ec2-user/.ssh/authorized_keys\"]" \
    --region "$REGION" \
    --output text >/dev/null
  
  echo "✅ SSH key added. Wait 2 seconds, then connect with: ssh devbox-$user_id"
}

# Add to SSH config
ssh_config() {
  local user_id=$(get_sso_username)
  local api_url=$(get_api_url)
  
  # Get instance ID
  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")
  
  instance_id=$(echo "$response" | jq -r '.instanceId')
  
  if [ "$instance_id" = "null" ]; then
    echo "❌ No devbox found. Provision one first: $0 provision"
    exit 1
  fi
  
  config_entry="
Host devbox-$user_id
    HostName $instance_id
    User ec2-user
    ProxyCommand sh -c \"aws --profile $PROFILE ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region $REGION\"
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    ForwardAgent yes
"
  
  # Check if entry exists
  if [ -f "$HOME/.ssh/config" ] && grep -q "Host devbox-$user_id" "$HOME/.ssh/config"; then
    echo "⚠️  SSH config for devbox-$user_id already exists"
    read -p "Overwrite? (y/n): " confirm
    if [ "$confirm" = "y" ]; then
      sed -i.bak "/Host devbox-$user_id/,/^$/d" "$HOME/.ssh/config"
      echo "$config_entry" >> "$HOME/.ssh/config"
      echo "✅ Updated SSH config"
    fi
  else
    mkdir -p "$HOME/.ssh"
    echo "$config_entry" >> "$HOME/.ssh/config"
    echo "✅ Added SSH config"
  fi
  
  echo ""
  echo "Connect with: ssh devbox-$user_id"
  echo "Or use VS Code Remote-SSH extension"
}

# Connect via SSM terminal
connect() {
  local user_id=$(get_sso_username)
  local api_url=$(get_api_url)
  
  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")
  
  instance_id=$(echo "$response" | jq -r '.instanceId')
  
  if [ "$instance_id" = "null" ]; then
    echo "❌ No devbox found. Provision one first: $0 provision"
    exit 1
  fi
  
  echo "Connecting to $instance_id via SSM..."
  aws ssm start-session --profile "$PROFILE" --target "$instance_id" --region "$REGION"
}

case "${1:-help}" in
  provision)
    provision
    ;;
  status)
    status
    ;;
  add-key)
    add_key
    ;;
  ssh-config)
    ssh_config
    ;;
  connect)
    connect
    ;;
  *)
    echo "Devbox CLI for SSO Users"
    echo ""
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  provision    - Create your devbox"
    echo "  status       - Check devbox status"
    echo "  add-key      - Add your SSH key to the devbox"
    echo "  ssh-config   - Add devbox to ~/.ssh/config"
    echo "  connect      - Connect via SSM terminal"
    echo ""
    echo "Environment:"
    echo "  AWS_PROFILE  - SSO profile name (default: devbox)"
    echo "  AWS_REGION   - AWS region (default: ap-southeast-2)"
    echo ""
    echo "Quick start:"
    echo "  1. aws sso login --profile devbox"
    echo "  2. $0 provision"
    echo "  3. $0 add-key"
    echo "  4. $0 ssh-config"
    echo "  5. ssh devbox-<your-username>"
    ;;
esac
