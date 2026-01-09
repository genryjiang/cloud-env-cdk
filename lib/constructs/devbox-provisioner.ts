import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface DevboxProvisionerProps {
  vpc: ec2.IVpc;
  userTable: dynamodb.Table;
  launchTemplate: ec2.LaunchTemplate;
  devboxRole: iam.Role;
}

export class DevboxProvisioner extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: DevboxProvisionerProps) {
    super(scope, id);

    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/provisioner'),
      timeout: Duration.minutes(5),
      vpc: props.vpc,
      environment: {
        USER_TABLE: props.userTable.tableName,
        LAUNCH_TEMPLATE_ID: props.launchTemplate.launchTemplateId!,
        SUBNET_IDS: props.vpc.privateSubnets.map(s => s.subnetId).join(','),
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    props.userTable.grantReadWriteData(this.function);
    
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:RunInstances',
        'ec2:DescribeInstances',
        'ec2:CreateTags',
        'ec2:StopInstances',
        'ec2:TerminateInstances',
      ],
      resources: ['*'],
    }));

    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [props.devboxRole.roleArn],
    }));
  }
}
