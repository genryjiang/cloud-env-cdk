import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codeconnections from 'aws-cdk-lib/aws-codeconnections';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import { Construct } from 'constructs';

export class DevContainerBuildStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const sdp_s3 = new s3.Bucket(this,'dev-artifacts-bucket', {
      bucketName: `dev-container-artifacts-${this.region}`,  // TODO: Update bucket name for your project
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false
    });

    new CfnOutput(this, "ArtifactsBucket", {
      value: sdp_s3.bucketName,
      description: 'S3 Bucket to store dev container build artifacts'
    })

    const dev_ecr = new ecr.Repository(this, "dev_container_ecr", {
        imageTagMutability: ecr.TagMutability.IMMUTABLE_WITH_EXCLUSION,
        imageTagMutabilityExclusionFilters: [
          ecr.ImageTagMutabilityExclusionFilter.wildcard('latest-*'),
          ecr.ImageTagMutabilityExclusionFilter.wildcard('test-*'),
          ecr.ImageTagMutabilityExclusionFilter.wildcard('dev-*')
        ],
    });

    // Reference IAM group created by CloudDevEnvStack
    const devAccessGroup = iam.Group.fromGroupName(this, 'DevAccessGroup', 'dev-access-group');
    ecr.AuthorizationToken.grantRead(devAccessGroup);
    const codebuild_enable = new iam.Role(this, 'codebuild-ecr-push', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    dev_ecr.grantPullPush(codebuild_enable)

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
          'codepipeline:GetPipelineState',
          'codepipeline:GetPipeline',
          'codepipeline:ListPipelines',
          'codepipeline:ListTagsForResource',
          'codepipeline:TagResource',
          'codepipeline:UntagResource'
        ],
        resources: ['*'],
    }));

    artifacts_bucket.grantReadWrite(pipeline_role);
    const source_artifact = new codepipeline.Artifact('SourceArtifact');
    const dev_env_codebuild = new codebuild.Project(this, 'DevContainerBuild', {
      buildSpec: codebuild.BuildSpec.fromSourceFilename('docker/buildspec.yml'),
      source: codebuild.Source.gitHub({
        owner: 'YOUR_GITHUB_ORG',  // TODO: Update with your GitHub organization
        repo: 'YOUR_REPO_NAME'     // TODO: Update with your repository name
      }),
      projectName: 'dev-container-build',
      role: codebuild_enable,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          'AWS_DEFAULT_REGION': { value: this.region },
          'AWS_ACCOUNT_ID': { value: this.account },
          'IMAGE_REPO_NAME': { value: dev_ecr.repositoryName },
          'ECR_URL': { value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com` },
          'GIT_HASH': {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '${CODEBUILD_RESOLVED_SOURCE_VERSION}'
          },
        }
      }
    });

    const github_connector = new codeconnections.CfnConnection(this, 'GithubConnection', {
      connectionName: 'dev-container-github-connection',
      providerType: 'GitHub'
    });

       const githubOidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'], // GitHub's thumbprint
    });

      const githubStartCodePipelinePolicy = new iam.ManagedPolicy(this, 'GithubActionRunCodebuild', {
      managedPolicyName: 'GithubActionStartPipeline',
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'codepipeline:StartPipelineExecution',
            'codepipeline:GetPipelineExecution',
            'codepipeline:ListPipelineExecutions',
            'codepipeline:ListActionExecutions',
            'codepipeline:GetPipelineState',
            'codebuild:BatchGetBuilds',
            'codebuild:ListBuildsForProject',
            'logs:GetLogEvents',
            'logs:FilterLogEvents'
          ],
          resources: [
            `arn:aws:codebuild:${this.region}:${this.account}:project/dev-container-build`,
            `arn:aws:codepipeline:${this.region}:${this.account}:DevContainerBuildPipeline`,
            `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/dev-container-build:*`,
            `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/dev-container-build:log-stream:*`,
            dev_env_codebuild.projectArn
          ]
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'logs:GetLogEvents'
          ],
          resources: [
            `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/dev-container-build:*`,
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
            // TODO: Update with your GitHub org and repo
            'token.actions.githubusercontent.com:sub': 'repo:YOUR_GITHUB_ORG/YOUR_REPO_NAME:ref:refs/heads/main'
          },
          'StringLike': {
            'token.actions.githubusercontent.com:sub': [
              // TODO: Update with your GitHub org and repo
              'repo:YOUR_GITHUB_ORG/YOUR_REPO_NAME:*',
            ]
          }
        }
      ),
      maxSessionDuration: Duration.hours(1),
      managedPolicies: [githubStartCodePipelinePolicy]
    });

    new CfnOutput(this, 'GithubActionCodebuildRoleArn', {
      value: githubActionCodebuildRole.roleArn,
      description: 'ARN of the GitHub Actions CodeBuild Role'
    });

    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'Source',
      owner: 'YOUR_GITHUB_ORG',  // TODO: Update with your GitHub organization
      repo: 'YOUR_REPO_NAME',    // TODO: Update with your repository name
      branch: 'main',
      output: source_artifact,
      connectionArn: github_connector.attrConnectionArn,
    });

    const dev_build_pipeline = new codepipeline.Pipeline(this, 'DevContainerBuildPipeline', {
      pipelineName: 'DevContainerBuildPipeline',
      role: pipeline_role,
      pipelineType: codepipeline.PipelineType.V2,
      triggers: [{
        providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: {
          sourceAction: sourceAction,
          pushFilter: [{
            tagsExcludes: [],
            tagsIncludes: [],
            branchesIncludes: ['main'],
            filePathsIncludes: ['docker/**'],
          }],
        },
      }],
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
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

   new CfnOutput(this, 'ConnectionARN', {
      value: github_connector.attrConnectionArn,
      description: 'CodeStar Connection ARN for GitHub'
    })



  }
}