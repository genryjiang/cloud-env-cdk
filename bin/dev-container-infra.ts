#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DevContainerBuildStack } from '../lib/dev-container-build-stack';
import { CloudDevEnvStack } from '../lib/cloud-dev-env';

const app = new cdk.App();
new DevContainerBuildStack(app, 'DevContainerBuildStack');
new CloudDevEnvStack(app, 'CloudDevEnvStack');