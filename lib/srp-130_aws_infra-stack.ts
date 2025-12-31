import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codeconnections from 'aws-cdk-lib/aws-codeconnections';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
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
    const group_access = iam.Group.fromGroupName(this, 'Embd-Read', 'dev-embd-access');
    ecr.AuthorizationToken.grantRead(group_access);
    const codebuild_enable = new iam.Role(this, 'codebuild-ecr-push', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    embd_ecr.grantPullPush(codebuild_enable)

    // S3 Bucket for codepipline artifacts
   const artifacts_bucket = new s3.Bucket(this, 'PipelineArtifacts', {
      bucketName: `my-pipeline-artifacts-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY, // Use RETAIN for production
      autoDeleteObjects: true, // Use false for production
      lifecycleRules: [
        {
          id: 'DeleteOldArtifacts',
          enabled: true,
          expiration: Duration.days(30), // Clean up artifacts after 30 days
        },
      ],
    });

      const pipeline_role = new iam.Role(this, 'PipelineServiceRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });

    // Add permissions for CodeStar connections and CodeBuild
    pipeline_role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
        actions: [
          'codestar-connections:UseConnection',
          'codebuild:BatchGetBuilds',
          'codebuild:StartBuild',
          'codepipeline:StartPipelineExecution',
          'codepipeline:ListPipelineExecutions',
          'codepipeline:GetPipelineExecution',
          'codepipeline:ListActionExecutions',
        ],
        resources: ['*'],
    }));

    // Grant S3 permissions to pipeline role
    artifacts_bucket.grantReadWrite(pipeline_role);
    const source_artifact = new codepipeline.Artifact('SourceArtifact');
    // Build spec for docker container
    const dev_env_codebuild = new codebuild.Project(this, 'SR8-EMBD-Dev', {
      buildSpec: codebuild.BuildSpec.fromSourceFilename('docker/buildspec.yml'),
      source: codebuild.Source.gitHub({
        owner: 'UNSW-Sunswift',
        repo: 'EMBD-High-Dev-Infra'
      }),
      projectName: 'embd-dev-env',
      role: codebuild_enable,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          'AWS_DEFAULT_REGION': { value: 'ap-southeast-2' },
          'AWS_ACCOUNT_ID': { value: this.account },
          'IMAGE_REPO_NAME': { value: embd_ecr.repositoryName },
          'ECR_URL': { value: `${this.account}.dkr.ecr.ap-southeast-2.amazonaws.com` },
          'GIT_HASH': {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '${CODEBUILD_RESOLVED_SOURCE_VERSION}'
          },
        }
      }
    });

    // setup codeconnections (aws connector)
    const github_connector = new codeconnections.CfnConnection(this, 'GithubConnection', {
      connectionName: 'srp8-130-github-connection',
      providerType: 'GitHub'
    });

       const githubOidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'], // GitHub's thumbprint
    });

      const githubActionRunCodebuildPolicy = new iam.ManagedPolicy(this, 'GithubActionRunCodebuild', {
      managedPolicyName: 'GithubActionRunCodebuild',
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'codebuild:StartBuild',
            'codebuild:BatchGetBuilds'
          ],
          resources: [
            `arn:aws:codebuild:${this.region}:${this.account}:project/embd-dev-env`,
            `arn:aws:codepipeline:${this.region}:${this.account}:EMBD-High-Level-Infra-Pipeline`,
            `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/embd-dev-env:*`,
            dev_env_codebuild.projectArn,

          ]
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'logs:GetLogEvents'
          ],
          resources: [
            `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/embd-dev-env:*`,
          ]
        })
      ]
    });

     const githubActionCodebuildRole = new iam.Role(this, 'GithubActionCodebuildRole', {
      roleName: 'GithubActionCodebuildRole',
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          'StringEquals': {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': 'repo:UNSW-Sunswift/EMBD-High-Dev-Infra:ref:refs/heads/main'
          },
          'StringLike': {
            'token.actions.githubusercontent.com:sub': [
              'repo:UNSW-Sunswift/EMBD-High-Dev-Infra:*',
            ]
          }
        }
      ),
      maxSessionDuration: Duration.hours(1),
      managedPolicies: [githubActionRunCodebuildPolicy]
    });

    new CfnOutput(this, 'GithubActionCodebuildRoleArn', {
      value: githubActionCodebuildRole.roleArn,
      description: 'ARN of the GitHub Actions CodeBuild Role'
    });

    const dev_build_pipeline = new codepipeline.Pipeline(this, 'EMBD-High-Level-Infra-Pipeline', {
      pipelineName: 'EMBD-High-Level-Infra-Pipeline',
      role: pipeline_role,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.CodeStarConnectionsSourceAction({
              actionName: 'Source',
              owner: 'UNSW-Sunswift',
              repo: 'EMBD-High-Dev-Infra',
              branch: 'main',
              output: source_artifact,
              connectionArn: github_connector.attrConnectionArn,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Build',
              project: dev_env_codebuild,
              input: source_artifact,
            }),
          ],
        },
      ],
    });
    // Update policies/grant permissions
   sdp_s3.grantRead(dev_env_codebuild);
   dev_env_codebuild.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:GetAuthorizationToken',
      ],
      resources: ['*'],
   }));

  githubActionCodebuildRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['codepipeline:StartPipelineExecution'],
    resources: [dev_build_pipeline.pipelineArn],
  }));

   // Output logs
   new CfnOutput(this, 'ConnectionARN', {
      value: github_connector.attrConnectionArn,
      description: 'CodeStar Connection ARN for SRP8-130'
    })



  }
}