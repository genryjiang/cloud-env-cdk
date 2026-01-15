import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class DevboxNetwork extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // SSM endpoints for Session Manager
    this.vpc.addInterfaceEndpoint('Ssm', { service: ec2.InterfaceVpcEndpointAwsService.SSM });
    this.vpc.addInterfaceEndpoint('SsmMessages', { service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES });
    this.vpc.addInterfaceEndpoint('Ec2Messages', { service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES });

    // ECR endpoints for Docker images
    this.vpc.addInterfaceEndpoint('Ecr', { service: ec2.InterfaceVpcEndpointAwsService.ECR });
    this.vpc.addInterfaceEndpoint('EcrDocker', { service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER });
    this.vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // STS endpoint for AWS CLI authentication
    this.vpc.addInterfaceEndpoint('Sts', { service: ec2.InterfaceVpcEndpointAwsService.STS });

    // DynamoDB and EC2 endpoints for Lambda provisioner
    this.vpc.addGatewayEndpoint('DynamoDB', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
    this.vpc.addInterfaceEndpoint('Ec2', { service: ec2.InterfaceVpcEndpointAwsService.EC2 });

    this.securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc: this.vpc,
      description: 'Devbox security group',
      allowAllOutbound: true,
    });
  }
}
