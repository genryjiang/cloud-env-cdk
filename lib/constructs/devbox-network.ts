import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class DevboxNetwork extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{
        name: 'Private',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: 24,
      }],
    });

    // SSM endpoints for Session Manager
    this.vpc.addInterfaceEndpoint('Ssm', { service: ec2.InterfaceVpcEndpointAwsService.SSM });
    this.vpc.addInterfaceEndpoint('SsmMessages', { service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES });
    this.vpc.addInterfaceEndpoint('Ec2Messages', { service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES });

    // ECR endpoints for Docker images
    this.vpc.addInterfaceEndpoint('Ecr', { service: ec2.InterfaceVpcEndpointAwsService.ECR });
    this.vpc.addInterfaceEndpoint('EcrDocker', { service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER });
    this.vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    this.securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc: this.vpc,
      description: 'Devbox security group',
      allowAllOutbound: true,
    });
  }
}
