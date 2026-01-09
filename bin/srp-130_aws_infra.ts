#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Srp130AwsInfraStack } from '../lib/srp-130_aws_infra-stack';
import { AsgardCloudEnvStack } from '../lib/cloud-dev-env';

const app = new cdk.App();
new Srp130AwsInfraStack(app, 'Srp130AwsInfraStack');
new AsgardCloudEnvStack(app, 'AsgardCloudEnvStack');