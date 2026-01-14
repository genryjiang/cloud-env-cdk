# IAM Groups and Permissions

The CDK stacks attach policies to existing IAM groups. Create these groups before deployment.

## Required groups

### dev-embd-access (developers)

Purpose: developers who use devboxes and pull the dev container image.

Permissions attached by the stacks include:

- Start/terminate SSM sessions to instances tagged `ManagedBy=devbox-provisioner`
- Read EC2 instance status (describe)
- Read from the devbox user mapping table (DynamoDB)
- Invoke the devbox provisioner Lambda
- Read CloudFormation stack outputs
- Read/write the devbox artifacts bucket
- Pull the dev container image from ECR

Developers can:

- Provision, stop, and terminate their devbox
- Connect via SSM or VS Code
- Pull the dev container image
- Upload and download artifacts from the devbox bucket

Developers cannot:

- Access other users' devboxes (tag-based restriction)
- Modify infrastructure or IAM
- Deploy or delete stacks

### dev-all-access (admins)

Purpose: administrators who manage infrastructure.

The devbox stack attaches an allow-all inline policy to this group. Use this only for trusted admins and require MFA.

## Create groups

```bash
aws iam create-group --group-name dev-embd-access
aws iam create-group --group-name dev-all-access
```

## Add users to groups

```bash
aws iam add-user-to-group --user-name alice --group-name dev-embd-access
aws iam add-user-to-group --user-name bob --group-name dev-all-access
```

## Notes

- Access to the `sr8-embd-dev-env-*` bucket (used by the build pipeline) is not granted by default. Grant it separately if developers need it.

## Auditing

CloudTrail logs:

- SSM session starts and stops
- Lambda invocations for provisioning
- EC2 instance lifecycle actions
- S3 object access
