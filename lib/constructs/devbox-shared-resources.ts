import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface DevboxSharedResourcesProps {
  vpc: ec2.IVpc;
  securityGroup: ec2.SecurityGroup;
}

export class DevboxSharedResources extends Construct {
  public readonly artifactsBucket: s3.Bucket;
  public readonly userTable: dynamodb.Table;
  public readonly devboxRole: iam.Role;
  public readonly launchTemplate: ec2.LaunchTemplate;

  constructor(scope: Construct, id: string, props: DevboxSharedResourcesProps) {
    super(scope, id);

    // S3 for build artifacts
    this.artifactsBucket = new s3.Bucket(this, 'Artifacts', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    // DynamoDB for user mappings
    this.userTable = new dynamodb.Table(this, 'Users', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // IAM role for devbox instances
    this.devboxRole = new iam.Role(this, 'DevboxRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    this.artifactsBucket.grantReadWrite(this.devboxRole);
    this.devboxRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
        'ecr:DescribeRepositories',
      ],
      resources: ['*'],
    }));

    // Launch template
    this.launchTemplate = new ec2.LaunchTemplate(this, 'Template', {
      launchTemplateName: 'DevboxTemplate-v6',
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: this.devboxRole,
      securityGroup: props.securityGroup,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(50, { encrypted: true }),
      }],
      userData: ec2.UserData.forLinux(),
      requireImdsv2: true,
    });

    this.launchTemplate.userData?.addCommands(
      '#!/bin/bash',
      'exec > >(tee /var/log/user-data.log) 2>&1',
      'yum install -y docker git jq ec2-instance-connect',
      'systemctl start docker',
      'systemctl enable docker',
      'usermod -aG docker ec2-user',
      'systemctl start sshd',
      'systemctl enable sshd',
      'REGION=$(TOKEN=`curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"` && curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
      'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
      'ECR_REPO=$(aws ecr describe-repositories --region $REGION --query "repositories[?contains(repositoryName, \'embddevecr\')].repositoryName" --output text | head -1)',
      'aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com',
      'docker pull $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO:linux-amd64-latest',
      'mkdir -p /home/ec2-user/workspace',
      'chown ec2-user:ec2-user /home/ec2-user/workspace',
      'sudo -u ec2-user git config --global credential.helper store',
    );
  }
}
