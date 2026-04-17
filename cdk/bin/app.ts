#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { S3Stack } from '../lib/s3-stack';
import { AuthStack } from '../lib/auth-stack';
import { Ec2Stack } from '../lib/ec2-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '592920047652',
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const prefix = 'PocCsd';

const s3 = new S3Stack(app, `${prefix}-S3`, { env });

const auth = new AuthStack(app, `${prefix}-Auth`, {
  env,
  bucketA: s3.bucketA,
  bucketB: s3.bucketB,
  bucketC: s3.bucketC,
});
auth.addDependency(s3);

new Ec2Stack(app, `${prefix}-Ec2`, {
  env,
  bucketA: s3.bucketA,
  bucketB: s3.bucketB,
  bucketC: s3.bucketC,
  deployBucket: s3.deployBucket,
  userPoolId: auth.userPool.userPoolId,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  identityPoolId: auth.identityPool.ref,
}).addDependency(auth);

app.synth();
