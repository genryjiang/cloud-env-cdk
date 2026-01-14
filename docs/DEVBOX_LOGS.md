# Devbox Log Checking

## Quick Check

To check if your devbox pulled the Docker image correctly:

```bash
./scripts/check-devbox-logs.sh <userId>
```

Example:
```bash
./scripts/check-devbox-logs.sh henryjiang
```

## What it checks

1. **Instance Status** - Verifies the devbox is running
2. **Console Output** - Shows user-data script execution logs
3. **Docker Images** - Lists pulled Docker images
4. **Cloud-init Logs** - Shows detailed Docker-related logs

## Troubleshooting

If the image wasn't pulled:

1. Check ECR repository exists and has images
2. Verify IAM role has ECR permissions
3. Check VPC endpoints for ECR (ecr.api and ecr.dkr)
4. Review the console output for errors

## After fixing

After deploying the fix:

```bash
# Deploy the updated stack
cdk deploy AsgardCloudEnvStack

# Terminate old devbox
aws lambda invoke --function-name <provisioner-arn> \
  --payload '{"action":"terminate","userId":"<userId>"}' /dev/stdout

# Provision new devbox with updated launch template
aws lambda invoke --function-name <provisioner-arn> \
  --payload '{"action":"provision","userId":"<userId>"}' /dev/stdout

# Wait 2-3 minutes, then check logs
./scripts/check-devbox-logs.sh <userId>
```
