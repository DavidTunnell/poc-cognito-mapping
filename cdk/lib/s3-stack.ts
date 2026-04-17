import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * S3 stack for the POC.
 *
 * v1 of this POC also provisioned three demo buckets (poc-csd-bucket-a/b/c)
 * for seeding sample data. In v2 the POC uses real CSD demo buckets, so the
 * only stack-owned bucket is the deploy bucket for shipping the app tarball
 * to EC2 and staging bootstrap payloads.
 */
export class S3Stack extends cdk.Stack {
  public readonly deployBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const accountSuffix = cdk.Stack.of(this).account;

    this.deployBucket = new s3.Bucket(this, 'DeployBucket', {
      bucketName: `poc-csd-deploy-${accountSuffix}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });

    new cdk.CfnOutput(this, 'DeployBucketName', { value: this.deployBucket.bucketName });
  }
}
