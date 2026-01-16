import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as DevContainerInfra from '../lib/dev-container-build-stack';

test('SQS Queue and SNS Topic Created', () => {
  const app = new cdk.App();
  const stack = new DevContainerInfra.DevContainerBuildStack(app, 'MyTestStack');

  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::SQS::Queue', {
    VisibilityTimeout: 300
  });
  template.resourceCountIs('AWS::SNS::Topic', 1);
});
