#!/bin/bash
# Devbox CLI - Manage your cloud development environment

set -e

REGION="${AWS_REGION:-ap-southeast-2}"
STACK_NAME="MjolnirCloudPlatformStack"

get_api_url() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`DevboxApiApiUrl`].OutputValue' \
    --output text \
    --region "$REGION"
}

provision() {
  local user_id="${1:-$USER}"
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
  local user_id="${1:-$USER}"
  local api_url=$(get_api_url)

  curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"status\", \"userId\": \"$user_id\"}" | jq .
}

stop() {
  local user_id="${1:-$USER}"
  local api_url=$(get_api_url)
  
  echo "Stopping devbox for $user_id..."
  curl -s -X POST "${api_url}devbox" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"stop\", \"userId\": \"$user_id\"}" | jq .
}

terminate() {
  local user_id="${1:-$USER}"
  
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

connect() {
  local user_id="${1:-$USER}"
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

case "${1:-help}" in
  provision)
    provision "$2"
    ;;
  status)
    status "$2"
    ;;
  stop)
    stop "$2"
    ;;
  terminate)
    terminate "$2"
    ;;
  connect)
    connect "$2"
    ;;
  *)
    echo "Devbox CLI - Manage your cloud development environment"
    echo ""
    echo "Usage: $0 <command> [user_id]"
    echo ""
    echo "Commands:"
    echo "  provision [user]   - Create a new devbox"
    echo "  status [user]      - Check devbox status"
    echo "  connect [user]     - Connect to devbox via SSM"
    echo "  stop [user]        - Stop devbox (preserves data)"
    echo "  terminate [user]   - Delete devbox (destroys data)"
    echo ""
    echo "If user_id is not provided, uses \$USER ($USER)"
    ;;
esac
