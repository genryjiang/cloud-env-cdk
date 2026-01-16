import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { DevboxNetwork } from './constructs/devbox-network';
import { DevboxSharedResources } from './constructs/devbox-shared-resources';
import { DevboxProvisioner } from './constructs/devbox-provisioner';
import { DevboxLifecycle } from './constructs/devbox-lifecycle';
import { DevboxApi } from './constructs/devbox-api';

export class CloudDevEnvStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create IAM groups
    const devAccessGroup = new iam.Group(this, 'DevAccessGroup', {
      groupName: 'dev-access-group',
    });

    const devAllAccessGroup = new iam.Group(this, 'DevAllAccessGroup', {
      groupName: 'dev-all-access',
    });

    const network = new DevboxNetwork(this, 'Network');

    const shared = new DevboxSharedResources(this, 'Shared', {
      vpc: network.vpc,
      securityGroup: network.securityGroup,
    });

    const provisioner = new DevboxProvisioner(this, 'Provisioner', {
      vpc: network.vpc,
      userTable: shared.userTable,
      launchTemplate: shared.launchTemplate,
      devboxRole: shared.devboxRole,
    });

    new DevboxLifecycle(this, 'Lifecycle');

    const api = new DevboxApi(this, 'Api', {
      provisionerFunction: provisioner.function,
    });

    // Create managed policy for devbox users
    const devboxUserPolicy = new iam.ManagedPolicy(this, 'DevboxUserPolicy', {
      managedPolicyName: 'DevboxUserAccess',
      statements: [
        new iam.PolicyStatement({
          actions: [
            'ssm:StartSession',
            'ssm:TerminateSession',
            'ssm:ResumeSession',
            'ssm:DescribeSessions',
            'ssm:GetConnectionStatus',
          ],
          resources: [
            `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            `arn:aws:ssm:${this.region}:${this.account}:session/\${aws:username}-*`,
          ],
          conditions: {
            StringEquals: {
              'ssm:resourceTag/ManagedBy': 'devbox-provisioner',
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ['execute-api:Invoke'],
          resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/POST/devbox`, `arn:aws:execute-api:${this.region}:${this.account}:*/*/GET/devbox`],
        }),
        new iam.PolicyStatement({
          actions: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:Query'],
          resources: [shared.userTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [provisioner.function.functionArn],
        }),
        new iam.PolicyStatement({
          actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStacks'],
          resources: ['*'],
        }),
      ],
    });

    // TODO: Update IAM group name to match your organization's group
    devboxUserPolicy.attachToGroup(devAccessGroup);
    shared.artifactsBucket.grantReadWrite(devAccessGroup);
    
    // Grant ECR permissions
    devAccessGroup.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
      ],
      resources: ['*'],
    }));

    new iam.CfnGroupPolicy(this, 'AllAccessAdmin', {
      groupName: devAllAccessGroup.groupName,
      policyName: 'AdminAccess',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: '*',
          Resource: '*',
        }],
      },
    });

    new CfnOutput(this, 'ProvisionerArn', { value: provisioner.function.functionArn });
    new CfnOutput(this, 'ArtifactsBucket', { value: shared.artifactsBucket.bucketName });
    new CfnOutput(this, 'UserTable', { value: shared.userTable.tableName });
  }
}