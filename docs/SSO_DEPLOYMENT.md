# SSO Multi-User Deployment Summary

## Changes Made

### 1. CDK Code Updates

#### `lib/constructs/devbox-shared-resources.ts`
- ✅ Added `ecrRepositoryUri` and `ecrImageTag` parameters for deterministic ECR image selection
- ✅ Updated UserData to use explicit ECR image URI (no more "discover by name")
- ✅ Removed `ec2-instance-connect` package (not needed for SSM)
- ✅ Removed insecure `git credential.helper store`
- ✅ Incremented template version to `v9-sso`

#### `lambda/provisioner/provision.js`
- ✅ Added `Purpose=Devbox` tag (for IAM policy filtering)
- ✅ Added `Owner=<userId>` tag (for tag-based access control)

#### Network (Already Correct)
- ✅ Private isolated subnets (no NAT, no public IPs)
- ✅ VPC endpoints: SSM, ECR, S3, STS, EC2, DynamoDB
- ✅ Security group: No inbound rules, all outbound allowed

### 2. New Documentation

- ✅ `docs/SSO_SETUP.md` - Complete IAM Identity Center setup guide
- ✅ `scripts/devbox-sso.sh` - SSO-specific CLI for users

## Deployment Steps

### 1. Update CDK Stack

```bash
# Install dependencies
npm install
cd lambda/provisioner && npm install && cd ../..

# Deploy with ECR repository URI
cdk deploy AsgardCloudEnvStack \
  --context ecrRepositoryUri="123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/embd-dev" \
  --context ecrImageTag="linux-amd64-latest"
```

Or update `lib/cloud-dev-env.ts` to pass parameters:

```typescript
const shared = new DevboxSharedResources(this, 'Shared', {
  vpc: network.vpc,
  securityGroup: network.securityGroup,
  ecrRepositoryUri: '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/embd-dev',
  ecrImageTag: 'linux-amd64-latest',
});
```

### 2. Configure IAM Identity Center

Follow `docs/SSO_SETUP.md` section 1:

1. Create permission set `DevboxUserAccess`
2. Add the IAM policy (tag-based SSM access)
3. Assign users to the permission set

### 3. User Onboarding

Each user runs:

```bash
# Configure SSO
aws configure sso
# Profile name: devbox

# Login
aws sso login --profile devbox

# Provision devbox
./scripts/devbox-sso.sh provision

# Add SSH key
./scripts/devbox-sso.sh add-key

# Add to SSH config
./scripts/devbox-sso.sh ssh-config

# Connect
ssh devbox-<username>
```

### 4. VS Code Setup

1. Install **Remote - SSH** extension
2. Press `F1` → **Remote-SSH: Connect to Host**
3. Select `devbox-<username>`
4. Once connected: `F1` → **Dev Containers: Reopen in Container**

## IAM Policy (Copy-Paste Ready)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SSMSessionToOwnDevbox",
      "Effect": "Allow",
      "Action": ["ssm:StartSession"],
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
      "Action": ["ssm:StartSession"],
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
      "Action": ["lambda:InvokeFunction"],
      "Resource": "arn:aws:lambda:*:*:function/*Provisioner*"
    },
    {
      "Sid": "DynamoDBReadOwnDevbox",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:*:*:table/*DevboxUsers*"
    }
  ]
}
```

## SSH Config Template (Copy-Paste Ready)

```
Host devbox-<username>
    HostName <instance-id>
    User ec2-user
    ProxyCommand sh -c "aws --profile devbox ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region ap-southeast-2"
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    ForwardAgent yes
```

## How Tag-Based Access Works

1. User `alice` provisions a devbox → Instance tagged `Owner=alice`
2. User `alice` runs: `aws ssm start-session --target i-alice-instance`
3. IAM checks: Does instance have `Purpose=Devbox` AND `Owner=alice`? ✅ Allow
4. User `alice` tries: `aws ssm start-session --target i-bob-instance`
5. IAM checks: Does instance have `Owner=alice`? ❌ Deny (it has `Owner=bob`)

## Security Features

✅ No long-lived IAM access keys (SSO only)  
✅ No inbound port 22 (SSH over SSM)  
✅ No public IPs (private subnets)  
✅ Tag-based isolation (users can't access others' devboxes)  
✅ No plaintext git credentials (SSH agent forwarding)  
✅ Short-lived credentials (SSO session duration)  
✅ Audit trail (CloudTrail logs all SSM sessions)

## Testing Access Control

```bash
# As user alice
aws sso login --profile devbox

# Provision alice's devbox
./scripts/devbox-sso.sh provision
# Instance i-alice tagged Owner=alice

# Connect to own devbox ✅
aws ssm start-session --profile devbox --target i-alice

# Try to connect to bob's devbox ❌
aws ssm start-session --profile devbox --target i-bob
# Error: User is not authorized to perform: ssm:StartSession
```

## Troubleshooting

### "User is not authorized to perform: ssm:StartSession"

Check instance tags match your username:
```bash
aws ec2 describe-instances --profile devbox --instance-ids <instance-id> \
  --query 'Reservations[0].Instances[0].Tags'
```

### SSO session expired

Re-authenticate:
```bash
aws sso login --profile devbox
```

### SSH key not working

Re-add key:
```bash
./scripts/devbox-sso.sh add-key
```

## Next Steps

1. Deploy CDK changes
2. Configure IAM Identity Center
3. Onboard users with `devbox-sso.sh`
4. Test tag-based access control
5. Document git authentication method (SSH agent forwarding recommended)
