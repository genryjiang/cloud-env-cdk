import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class Srp130AwsInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const sdp_s3 = new s3.Bucket(this,'embd-high-level-infra', {
      bucketName: `sr8-embd-dev-env-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false
    });

    // easy reference bucket name (from tutorial)
    new CfnOutput(this, "SRP8-130_Bucket", {
      value: sdp_s3.bucketName,
      description: 'S3 Bucket to store cloud infra for SRP8-130'
    })

    // No docker image scanning needed - this isn't an application that isn't exposed to the public (just a dev environment)
    const embd_ecr = new ecr.Repository(this, "embd_dev_ecr", {
        imageTagMutability: ecr.TagMutability.IMMUTABLE_WITH_EXCLUSION,
        imageTagMutabilityExclusionFilters: [
          ecr.ImageTagMutabilityExclusionFilter.wildcard('latest-*'),
          ecr.ImageTagMutabilityExclusionFilter.wildcard('test-*'),
          ecr.ImageTagMutabilityExclusionFilter.wildcard('dev-*')
        ],
    });

    // Create policy that allows for reading and writing, then attach this policy to a group then add this group
    // Authenticate group for ecr pulling
    const groupAccess = iam.Group.fromGroupName(this, 'dev-embd-access', 'Embd-Read');
    ecr.AuthorizationToken.grantRead(groupAccess);
    const codebuild_enable = new iam.Role(this, 'codebuild-ecr-push', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    embd_ecr.grantPullPush(codebuild_enable)

    // Build spec for docker container
    /*const dev_env_codebuild = new codebuild.Project(this, 'SR8-EMBD-Dev', {
      buildSpec: // ADD BUILDSPEC to build docker container
    });
    */
  }
}
