# SSO Multi-User Quick Reference

## For Administrators

### Deploy Stack
```bash
cdk deploy AsgardCloudEnvStack
```

### Create IAM Identity Center Permission Set
1. Name: `DevboxUserAccess`
2. Policy: See `docs/SSO_DEPLOYMENT.md`
3. Key condition: `"ssm:resourceTag/Owner": "${aws:username}"`

### Assign Users
IAM Identity Center → AWS accounts → Assign users → `DevboxUserAccess`

## For Users

### One-Time Setup
```bash
# 1. Configure SSO
aws configure sso
# Profile: devbox
# Start URL: https://your-org.awsapps.com/start

# 2. Login
aws sso login --profile devbox

# 3. Provision devbox
./scripts/devbox-sso.sh provision

# 4. Add SSH key
./scripts/devbox-sso.sh add-key

# 5. Add to SSH config
./scripts/devbox-sso.sh ssh-config
```

### Daily Use
```bash
# Login (when session expires)
aws sso login --profile devbox

# Connect via SSH
ssh devbox-<your-username>

# Or connect via VS Code
# F1 → Remote-SSH: Connect to Host → devbox-<your-username>
```

### VS Code Dev Containers
1. Connect to devbox via Remote-SSH
2. Open `/home/ec2-user/workspace`
3. Clone repo
4. `F1` → Dev Containers: Reopen in Container
5. IntelliSense works in container!

## Architecture

```
User → aws sso login → IAM Identity Center → Short-lived credentials
  ↓
VS Code → SSH → ProxyCommand → aws ssm start-session
  ↓
SSM Service (checks tags: Purpose=Devbox, Owner=<user>)
  ↓
SSM Agent on EC2 → SSH daemon (localhost only)
  ↓
Dev Container (Docker on EC2)
```

## Key Files

- `docs/SSO_SETUP.md` - Complete setup guide
- `docs/SSO_DEPLOYMENT.md` - Deployment summary
- `scripts/devbox-sso.sh` - User CLI tool
- `lib/constructs/devbox-shared-resources.ts` - CDK code

## Security Model

✅ No long-lived access keys  
✅ No inbound port 22  
✅ No public IPs  
✅ Tag-based isolation: `Owner=<username>`  
✅ IAM policy: `"ssm:resourceTag/Owner": "${aws:username}"`  
✅ Users can ONLY access instances where Owner tag matches their SSO username
