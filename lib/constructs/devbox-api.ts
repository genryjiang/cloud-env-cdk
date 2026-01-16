import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { CfnOutput } from 'aws-cdk-lib';

export interface DevboxApiProps {
  provisionerFunction: lambda.Function;
}

export class DevboxApi extends Construct {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: DevboxApiProps) {
    super(scope, id);

    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'Devbox API',
      description: 'API for devbox provisioning',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'GET'],
      },
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.IAM
      }
    });

    const integration = new apigateway.LambdaIntegration(props.provisionerFunction);

    const devbox = this.api.root.addResource('devbox');
    devbox.addMethod('POST', integration); // Provision
    devbox.addMethod('GET', integration);  // Status

    new CfnOutput(this, 'DevboxApiUrl', {
      value: this.api.url,
      description: 'Devbox API endpoint',
      exportName: 'DevboxApiUrl',
    });
  }
}
