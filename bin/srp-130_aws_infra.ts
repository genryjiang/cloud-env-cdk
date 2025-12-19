#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Srp130AwsInfraStack } from '../lib/srp-130_aws_infra-stack';

const app = new cdk.App();
new Srp130AwsInfraStack(app, 'Srp130AwsInfraStack');
