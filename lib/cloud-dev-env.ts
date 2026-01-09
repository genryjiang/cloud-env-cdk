import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { DevboxNetwork } from './constructs/devbox-network';
import { DevboxSharedResources } from './constructs/devbox-shared-resources';
import { DevboxProvisioner } from './constructs/devbox-provisioner';
import { DevboxLifecycle } from './constructs/devbox-lifecycle';
import { DevboxApi } from './constructs/devbox-api';

export class AsgardCloudEnvStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

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

    // Attach policies to existing groups using CFN
    const dev_embd = iam.Group.fromGroupName(this, 'dev-embd', 'dev-embd-access');

    devboxUserPolicy.attachToGroup(dev_embd);
    shared.artifactsBucket.grantReadWrite(dev_embd);

    new iam.CfnGroupPolicy(this, 'AllAccessAdmin', {
      groupName: 'dev-all-access',
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