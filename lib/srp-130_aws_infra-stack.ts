import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
// Cloudwatch pipe
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class Srp130AwsInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // SAMPLE - DELETE LATER
    /*
    const queue = new sqs.Queue(this, 'Srp130AwsInfraQueue', {
      visibilityTimeout: Duration.seconds(300)
    });

    const topic = new sns.Topic(this, 'Srp130AwsInfraTopic');

    topic.addSubscription(new subs.SqsSubscription(queue));
    */

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
    });
    const user = new iam.User(this, 'User');
    ecr.AuthorizationToken.grantRead(user);

    /*const dev_env_codebuild = new codebuild.Project(this, 'SR8-EMBD-Dev', {
      buildSpec: // ADD BUILDSPEC to build docker container

    });
    */
  }
}
