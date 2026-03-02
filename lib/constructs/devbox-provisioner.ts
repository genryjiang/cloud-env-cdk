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
  securityGroup: ec2.SecurityGroup;
}

export class DevboxProvisioner extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: DevboxProvisionerProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'FunctionLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'provision.handler',
      code: lambda.Code.fromAsset('lambda/provisioner'),
      timeout: Duration.minutes(5),
      vpc: props.vpc,
      environment: {
        USER_TABLE: props.userTable.tableName,
        LAUNCH_TEMPLATE_ID: props.launchTemplate.launchTemplateId!,
        SUBNET_IDS: props.vpc.privateSubnets.map(s => s.subnetId).join(','),
        SECURITY_GROUP_ID: props.securityGroup.securityGroupId,
      },
      logGroup,
      description: `Provisioner v${Date.now()}`,
    });

    props.userTable.grantReadWriteData(this.function);

    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:RunInstances',
        'ec2:DescribeInstances',
        'ec2:CreateTags',
        'ec2:StopInstances',
        'ec2:TerminateInstances',
        'ec2:StartInstances',
        'ec2:DescribeVolumes',
        'ec2:CreateVolume',
        'ec2:AttachVolume',
        'ec2:DescribeSnapshots',
      ],
      resources: ['*'],
    }));

    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [props.devboxRole.roleArn],
    }));

    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['arn:aws:iam::*:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot'],
      conditions: {
        StringLike: {
          'iam:AWSServiceName': 'spot.amazonaws.com',
        },
      },
    }));
  }
}
