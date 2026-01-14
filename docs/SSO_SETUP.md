# IAM Identity Center (SSO) Multi-User Setup

This guide configures IAM Identity Center for multi-user devbox access with tag-based isolation.

## Architecture

- Users authenticate via `aws sso login` (no long-lived access keys)
- Each user can only start SSM sessions to instances tagged `Owner=<their-username>`
- SSH tunneled through SSM (no inbound port 22)
- VS Code Remote-SSH + Dev Containers work normally

## 1. IAM Identity Center Setup

### Create Permission Set

1. Go to **IAM Identity Center** → **Permission sets** → **Create permission set**
2. Name: `DevboxUserAccess`
3. Session duration: 8 hours (or as needed)
4. Create custom policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SSMSessionToOwnDevbox",
      "Effect": "Allow",
      "Action": [
        "ssm:StartSession"
      ],
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": {
        "StringEquals": {
          "ssm:resourceTag/Purpose": "Devbox",
          "ssm:resourceTag/Owner": "${aws:username}"
        }
      }
    },
    {
      "Sid": "SSMSessionDocument",
      "Effect": "Allow",
      "Action": [
        "ssm:StartSession"
      ],
      "Resource": [
        "arn:aws:ssm:*:*:document/AWS-StartSSHSession",
        "arn:aws:ssm:*:*:document/SSM-SessionManagerRunShell"
      ]
    },
    {
      "Sid": "SSMSessionManagement",
      "Effect": "Allow",
      "Action": [
        "ssm:TerminateSession",
        "ssm:ResumeSession",
        "ssm:DescribeSessions",
        "ssm:GetConnectionStatus"
      ],
      "Resource": "arn:aws:ssm:*:*:session/${aws:username}-*"
    },
    {
      "Sid": "DescribeInstances",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus"
      ],
      "Resource": "*"
    },
    {
      "Sid": "InvokeLambdaProvisioner",
      "Effect": "Allow",
      "Action": [
        "lambda:InvokeFunction"
      ],
      "Resource": "arn:aws:lambda:*:*:function/*Provisioner*"
    },
    {
      "Sid": "DynamoDBReadOwnDevbox",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/*DevboxUsers*"
    }
  ]
}
```

### Key Policy Features

- **Tag-based isolation**: `"ssm:resourceTag/Owner": "${aws:username}"` ensures users can only connect to instances where `Owner` tag matches their SSO username
- **SSM documents**: Allows AWS-StartSSHSession (for Remote-SSH) and SSM-SessionManagerRunShell (for terminal)
- **Session management**: Users can only manage their own sessions (`${aws:username}-*`)

### Assign Users

1. Go to **AWS accounts** → Select your account
2. **Assign users or groups**
3. Select users → Assign `DevboxUserAccess` permission set

## 2. User Onboarding

### Initial Setup (One-time per user)

```bash
# Configure SSO profile
aws configure sso
# SSO start URL: https://your-org.awsapps.com/start
# SSO region: us-east-1 (or your Identity Center region)
# Account: <your-account-id>
# Role: DevboxUserAccess
# CLI default region: ap-southeast-2
# Profile name: devbox

# Login
aws sso login --profile devbox

# Verify access
aws sts get-caller-identity --profile devbox
```

### Provision Devbox

```bash
# Get your SSO username
USER_ID=$(aws sts get-caller-identity --profile devbox --query 'Arn' --output text | awk -F'/' '{print $NF}')

# Provision devbox (via API or Lambda)
aws lambda invoke \
  --profile devbox \
  --function-name <ProvisionerFunctionName> \
  --payload "{\"action\":\"provision\",\"userId\":\"$USER_ID\"}" \
  response.json

# Get instance ID
INSTANCE_ID=$(cat response.json | jq -r '.body' | jq -r '.instanceId')
echo "Your devbox: $INSTANCE_ID"
```

## 3. SSH Configuration

### Add to `~/.ssh/config`

```
Host devbox
    HostName <your-instance-id>
    User ec2-user
    ProxyCommand sh -c "aws --profile devbox ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p'"
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    ForwardAgent yes
```

### Add SSH Key to Instance

Since EC2 Instance Connect doesn't work in private subnets, inject your key via SSM:

```bash
# Generate SSH key if needed
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519

# Add key to instance
PUB_KEY=$(cat ~/.ssh/id_ed25519.pub)
aws ssm send-command \
  --profile devbox \
  --instance-ids $INSTANCE_ID \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[\"mkdir -p /home/ec2-user/.ssh\",\"echo '$PUB_KEY' >> /home/ec2-user/.ssh/authorized_keys\",\"chmod 700 /home/ec2-user/.ssh\",\"chmod 600 /home/ec2-user/.ssh/authorized_keys\",\"chown -R ec2-user:ec2-user /home/ec2-user/.ssh\"]" \
  --region ap-southeast-2

# Wait 2 seconds, then connect
sleep 2
ssh devbox
```

## 4. VS Code Remote-SSH

### Connect to Devbox

1. Install **Remote - SSH** extension in VS Code
2. Press `F1` → **Remote-SSH: Connect to Host**
3. Select `devbox`
4. VS Code connects via SSM tunnel (no inbound port 22!)

### Use Dev Containers

Once connected:

1. Open `/home/ec2-user/workspace`
2. Clone your repo or open existing code
3. Press `F1` → **Dev Containers: Reopen in Container**
4. VS Code uses the Docker image from ECR
5. IntelliSense, debugging, and extensions work normally inside the container

## 5. Git Authentication (Secure Methods)

### Option 1: SSH Agent Forwarding (Recommended)

Already configured in `~/.ssh/config` with `ForwardAgent yes`.

Use SSH URLs:
```bash
git clone git@github.com:your-org/your-repo.git
```

Your local SSH keys are forwarded to the devbox securely.

### Option 2: GitHub CLI

```bash
# On devbox
sudo yum install -y gh
gh auth login
# Follow device flow prompts
```

### Option 3: GitHub App Token (Temporary)

```bash
# Set for session only
export GH_TOKEN=<your-token>
git clone https://$GH_TOKEN@github.com/your-org/your-repo.git
```

**DO NOT use `git config --global credential.helper store`** (stores plaintext credentials).

## 6. Tag-Based Access Control Details

### How It Works

When a user runs:
```bash
aws ssm start-session --target i-xxxxx
```

IAM evaluates:
1. Does the instance have tag `Purpose=Devbox`? ✓
2. Does the instance have tag `Owner=<user's-sso-username>`? ✓
3. If both match, allow session. Otherwise, deny.

### Username Mapping

The policy uses `${aws:username}` which resolves to:
- For SSO users: The username from Identity Center (e.g., `john.doe`)
- For assumed roles: The role session name

When provisioning, ensure the `Owner` tag matches the SSO username:
```javascript
{ Key: 'Owner', Value: userId } // userId must match SSO username
```

### Testing Access Control

```bash
# User alice can connect to her devbox (Owner=alice)
aws ssm start-session --target i-alice-instance --profile devbox
# ✓ Success

# User alice tries to connect to bob's devbox (Owner=bob)
aws ssm start-session --target i-bob-instance --profile devbox
# ✗ AccessDeniedException: User is not authorized to perform: ssm:StartSession
```

## 7. Troubleshooting

### "User is not authorized to perform: ssm:StartSession"

Check instance tags:
```bash
aws ec2 describe-instances \
  --profile devbox \
  --instance-ids $INSTANCE_ID \
  --query 'Reservations[0].Instances[0].Tags'
```

Verify:
- `Purpose=Devbox` exists
- `Owner=<your-sso-username>` matches your username

### "Session Manager plugin not found"

Install the plugin:
```bash
# macOS
brew install --cask session-manager-plugin

# Linux
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
sudo dpkg -i session-manager-plugin.deb
```

### SSO session expired

Re-authenticate:
```bash
aws sso login --profile devbox
```

## 8. Alternative: Broker Lambda (Optional)

If direct tag-based access is too complex, create a broker Lambda:

```typescript
// Lambda that validates user and starts session
export const handler = async (event: any) => {
  const userId = event.requestContext.authorizer.claims.sub; // From SSO
  
  // Look up user's instance from DynamoDB
  const instance = await getInstanceForUser(userId);
  
  // Start session on their behalf
  const session = await ssm.startSession({
    Target: instance.instanceId,
    DocumentName: 'AWS-StartSSHSession'
  });
  
  return { sessionId: session.SessionId };
};
```

Users call the Lambda instead of directly calling SSM. The Lambda enforces ownership.

## Summary

✅ No long-lived access keys (SSO only)  
✅ Tag-based isolation (users can only access their own devbox)  
✅ No inbound port 22 (SSH over SSM)  
✅ VS Code Remote-SSH + Dev Containers work  
✅ IntelliSense runs in Docker container on EC2  
✅ Secure git authentication (SSH agent forwarding or GitHub CLI)
