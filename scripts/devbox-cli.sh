#!/bin/bash
# Devbox CLI - Manage your cloud development environment

set -e

# Check for required dependencies
check_dependencies() {
  local missing=()
  
  if ! command -v jq &> /dev/null; then
    missing+=("jq")
  fi
  
  if ! command -v aws &> /dev/null; then
    missing+=("aws-cli")
  fi
  
  if [ ${#missing[@]} -ne 0 ]; then
    echo "Error: Missing required dependencies: ${missing[*]}"
    echo ""
    echo "Installation instructions:"
    if [[ " ${missing[*]} " =~ " jq " ]]; then
      echo "  jq:"
      echo "    macOS:  brew install jq"
      echo "    Ubuntu: sudo apt-get install jq"
    fi
    if [[ " ${missing[*]} " =~ " aws-cli " ]]; then
      echo "  aws-cli:"
      echo "    macOS:  brew install awscli"
      echo "    Ubuntu: sudo apt-get install awscli"
    fi
    exit 1
  fi
}

check_dependencies

REGION="${AWS_REGION:-ap-southeast-2}"
STACK_NAME="AsgardCloudEnvStack"

get_user_id() {
  local arn=""
  arn=$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null) || arn=""
  if [ -n "$arn" ] && [ "$arn" != "None" ]; then
    echo "$arn" | awk -F'[:/]' '{print $NF}'
  else
    echo "$USER"
  fi
}

get_api_url() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?contains(OutputKey,`DevboxApiUrl`)].OutputValue | [0]' \
    --output text \
    --region "$REGION"
}

provision() {
  local user_id="${1:-$(get_user_id)}"
  local api_url=$(get_api_url)
  
  echo "Provisioning devbox for $user_id..."
  
  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"provision\", \"userId\": \"$user_id\"}")
  
  echo "$response" | jq .
  
  instance_id=$(echo "$response" | jq -r '.instanceId')
  status=$(echo "$response" | jq -r '.status')
  
  if [ "$status" = "pending" ]; then
    echo ""
    echo "Waiting for instance to be ready (this takes ~2 minutes)..."
    sleep 120
    echo "=== DEVBOX READY ==="
    echo ""
    echo "Connect with: ./scripts/devbox-cli.sh connect $user_id"
  fi
}

status() {
  local user_id="${1:-$(get_user_id)}"
  local api_url=$(get_api_url)

  curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}" | jq .
}

stop() {
  local user_id="${1:-$(get_user_id)}"
  local api_url=$(get_api_url)
  
  echo "Stopping devbox for $user_id..."
  curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"stop\", \"userId\": \"$user_id\"}" | jq .
}

start() {
  local user_id="${1:-$(get_user_id)}"
  local api_url=$(get_api_url)

  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")

  instance_id=$(echo "$response" | jq -r '.instanceId')
  status=$(echo "$response" | jq -r '.status')

  if [ "$instance_id" = "null" ]; then
    echo "No devbox found for $user_id"
    exit 1
  fi

  if [ "$status" = "running" ]; then
    echo "Devbox is already running"
    exit 0
  fi

  echo "Starting devbox $instance_id..."
  aws ec2 start-instances --instance-ids "$instance_id" --region "$REGION" > /dev/null
  echo "Devbox starting. Wait 1-2 minutes before connecting."
}

terminate() {
  local user_id="${1:-$(get_user_id)}"
  
  read -p "This will DELETE the devbox and all data. Continue? (yes/no): " confirm
  if [ "$confirm" != "yes" ]; then
    echo "Cancelled."
    exit 0
  fi
  
  local api_url=$(get_api_url)
  echo "Terminating devbox for $user_id..."
  curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"terminate\", \"userId\": \"$user_id\"}" | jq .
}

logs() {
  local user_id="${1:-$(get_user_id)}"
  local api_url=$(get_api_url)

  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")

  instance_id=$(echo "$response" | jq -r '.instanceId')

  if [ "$instance_id" = "null" ]; then
    echo "No devbox found for $user_id"
    exit 1
  fi

  echo "Fetching system logs for $instance_id..."
  echo ""
  aws ec2 get-console-output --instance-id "$instance_id" --region "$REGION" --output text | tail -100
}

check() {
  local user_id="${1:-$(get_user_id)}"
  local api_url=$(get_api_url)

  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")

  instance_id=$(echo "$response" | jq -r '.instanceId')
  status=$(echo "$response" | jq -r '.status')

  if [ "$instance_id" = "null" ]; then
    echo "No devbox found for $user_id"
    exit 1
  fi

  if [ "$status" != "running" ]; then
    echo "Devbox is $status, not running. Cannot check."
    exit 1
  fi

  echo "Checking Docker and ECR image on $instance_id..."
  echo ""

  cmd_id=$(aws ssm send-command \
    --instance-ids "$instance_id" \
    --document-name "AWS-RunShellScript" \
    --parameters 'commands=["echo ===DOCKER STATUS===","sudo systemctl status docker --no-pager","echo","echo ===DOCKER VERSION===","docker --version","echo","echo ===DOCKER IMAGES===","docker images","echo","echo ===WORKSPACE===","ls -la /home/ec2-user/workspace"]' \
    --region "$REGION" \
    --output text \
    --query 'Command.CommandId')

  echo "Waiting for command to complete..."
  sleep 3

  aws ssm get-command-invocation \
    --command-id "$cmd_id" \
    --instance-id "$instance_id" \
    --region "$REGION" \
    --query 'StandardOutputContent' \
    --output text
}

connect() {
  local user_id="${1:-$(get_user_id)}"
  local api_url=$(get_api_url)

  echo "Looking up devbox for $user_id..."

  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")

  instance_id=$(echo "$response" | jq -r '.instanceId')
  status=$(echo "$response" | jq -r '.status')

  if [ "$instance_id" = "null" ]; then
    echo "devbox found. Provision one first:"
    echo "   ./scripts/devbox-cli.sh provision $user_id"
    exit 1
  fi
  
  if [ "$status" != "running" ]; then
    echo "Devbox is $status, not running"
    exit 1
  fi
  
  echo "Found instance: $instance_id"
  echo "Connecting via SSM..."
  echo ""
  
  aws ssm start-session --target "$instance_id" --region "$REGION"
}

find_ssh_pubkey() {
  if [ -n "$SSH_PUBKEY_PATH" ] && [ -f "$SSH_PUBKEY_PATH" ]; then
    echo "$SSH_PUBKEY_PATH"
    return 0
  fi

  if [ -n "$SSH_KEY_PATH" ] && [ -f "${SSH_KEY_PATH}.pub" ]; then
    echo "${SSH_KEY_PATH}.pub"
    return 0
  fi

  if [ -f "$HOME/.ssh/id_ed25519.pub" ]; then
    echo "$HOME/.ssh/id_ed25519.pub"
    return 0
  fi

  if [ -f "$HOME/.ssh/id_rsa.pub" ]; then
    echo "$HOME/.ssh/id_rsa.pub"
    return 0
  fi

  return 1
}

ssh_connect() {
  local user_id="${1:-$(get_user_id)}"
  local api_url=$(get_api_url)
  local ssh_user="${SSH_USER:-ec2-user}"

  echo "Looking up devbox for $user_id..."

  response=$(curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}")

  instance_id=$(echo "$response" | jq -r '.instanceId')
  status=$(echo "$response" | jq -r '.status')

  if [ "$instance_id" = "null" ]; then
    echo "No devbox found. Provision one first:"
    echo "   ./scripts/devbox-cli.sh provision $user_id"
    exit 1
  fi

  if [ "$status" != "running" ]; then
    echo "Devbox is $status, not running"
    exit 1
  fi

  local pubkey_path
  pubkey_path=$(find_ssh_pubkey) || true
  if [ -z "$pubkey_path" ]; then
    echo "No SSH public key found. Generate one with:"
    echo "  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519"
    exit 1
  fi

  local private_key="${pubkey_path%.pub}"
  if [ ! -f "$private_key" ]; then
    echo "Private key not found for $pubkey_path"
    exit 1
  fi

  echo "Found instance: $instance_id"
  echo "Adding SSH key via SSM (EC2 Instance Connect not available in private subnet)..."
  
  local pub_key=$(cat "$pubkey_path")
  aws ssm send-command \
    --instance-ids "$instance_id" \
    --document-name "AWS-RunShellScript" \
    --parameters "commands=[\"mkdir -p /home/$ssh_user/.ssh\",\"echo '$pub_key' >> /home/$ssh_user/.ssh/authorized_keys\",\"chmod 700 /home/$ssh_user/.ssh\",\"chmod 600 /home/$ssh_user/.ssh/authorized_keys\",\"chown -R $ssh_user:$ssh_user /home/$ssh_user/.ssh\",\"sort -u /home/$ssh_user/.ssh/authorized_keys -o /home/$ssh_user/.ssh/authorized_keys\"]" \
    --region "$REGION" \
    --output text >/dev/null

  echo "Waiting for key to be added..."
  sleep 2

  echo "Connecting via SSH over SSM..."
  ssh -i "$private_key" \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o "ProxyCommand=aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region $REGION" \
    "$ssh_user@$instance_id"
}

# AI GEN (and used for testing; final will be different)
#   Final Ver: CLI that lives in devbox, call to push

get_artifacts_bucket() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`ArtifactsBucket`].OutputValue' \
    --output text \
    --region "$REGION"
}

upload() {
  local file="$1"
  local user_id="${2:-$(get_user_id)}"
  
  if [ -z "$file" ]; then
    echo "Usage: $0 upload <file> [user_id]"
    exit 1
  fi
  
  if [ ! -f "$file" ]; then
    echo "File not found: $file"
    exit 1
  fi
  
  local bucket=$(get_artifacts_bucket)
  local filename=$(basename "$file")
  
  echo "Uploading $file to s3://$bucket/$user_id/$filename..."
  aws s3 cp "$file" "s3://$bucket/$user_id/$filename" --region "$REGION"
  echo "✅ Uploaded to s3://$bucket/$user_id/$filename"
}

download() {
  local user_id="${1:-$(get_user_id)}"
  local bucket=$(get_artifacts_bucket)
  
  echo "Artifacts for $user_id:"
  aws s3 ls "s3://$bucket/$user_id/" --region "$REGION" --human-readable
  
  if [ -n "$2" ]; then
    local file="$2"
    echo ""
    echo "Downloading $file..."
    aws s3 cp "s3://$bucket/$user_id/$file" "./$file" --region "$REGION"
    echo "✅ Downloaded to ./$file"
  else
    echo ""
    echo "To download: $0 download [user_id] <filename>"
  fi
}

list_artifacts() {
  local user_id="${1:-$(get_user_id)}"
  local bucket=$(get_artifacts_bucket)
  
  echo "Artifacts for $user_id:"
  aws s3 ls "s3://$bucket/$user_id/" --region "$REGION" --human-readable --recursive
}

case "${1:-help}" in
  provision)
    provision "$2"
    ;;
  status)
    status "$2"
    ;;
  logs)
    logs "$2"
    ;;
  check)
    check "$2"
    ;;
  stop)
    stop "$2"
    ;;
  start)
    start "$2"
    ;;
  terminate)
    terminate "$2"
    ;;
  connect)
    connect "$2"
    ;;
  ssh)
    ssh_connect "$2"
    ;;
  upload)
    upload "$2" "$3"
    ;;
  download)
    download "$2" "$3"
    ;;
  artifacts)
    list_artifacts "$2"
    ;;
  *)
    echo "Devbox CLI - Manage your cloud development environment"
    echo ""
    echo "Usage: $0 <command> [user_id]"
    echo ""
    echo "Commands:"
    echo "  provision [user]   - Create a new devbox"
    echo "  status [user]      - Check devbox status"
    echo "  logs [user]        - View instance boot logs (check Docker setup)"
    echo "  check [user]       - Check Docker status and ECR images on running instance"
    echo "  connect [user]     - Connect to devbox via SSM"
    echo "  ssh [user]         - SSH via SSM (pushes SSH key)"
    echo "  ssh-config [user]  - Add devbox to ~/.ssh/config for VS Code"
    echo "  start [user]       - Start a stopped devbox"
    echo "  stop [user]        - Stop devbox (preserves data)"
    echo "  terminate [user]   - Delete devbox (destroys data)"
    echo ""
    echo "Artifact Management:"
    echo "  upload <file> [user]      - Upload build artifact to S3"
    echo "  download [user] <file>    - Download artifact from S3"
    echo "  artifacts [user]          - List all artifacts for user"
    echo ""
    echo "SSH options:"
    echo "  SSH_USER=ubuntu           - OS user for SSH (default: ubuntu)"
    echo "  SSH_PUBKEY_PATH=...       - Public key to push (default: ~/.ssh/id_ed25519.pub)"
    echo "  SSH_KEY_PATH=...          - Private key path (uses <path>.pub)"
    echo ""
    echo "If user_id is not provided, uses STS caller ARN username (fallback: \$USER)"
    ;;
esac
