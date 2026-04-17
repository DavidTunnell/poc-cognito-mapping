import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class S3Stack extends cdk.Stack {
  public readonly bucketA: s3.Bucket;
  public readonly bucketB: s3.Bucket;
  public readonly bucketC: s3.Bucket;
  public readonly deployBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const accountSuffix = cdk.Stack.of(this).account;

    const common: Partial<s3.BucketProps> = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    };

    this.bucketA = new s3.Bucket(this, 'BucketA', {
      bucketName: `poc-csd-bucket-a-${accountSuffix}`,
      ...common,
    });

    this.bucketB = new s3.Bucket(this, 'BucketB', {
      bucketName: `poc-csd-bucket-b-${accountSuffix}`,
      ...common,
    });

    this.bucketC = new s3.Bucket(this, 'BucketC', {
      bucketName: `poc-csd-bucket-c-${accountSuffix}`,
      ...common,
    });

    this.deployBucket = new s3.Bucket(this, 'DeployBucket', {
      bucketName: `poc-csd-deploy-${accountSuffix}`,
      ...common,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });

    new cdk.CfnOutput(this, 'BucketAName', { value: this.bucketA.bucketName });
    new cdk.CfnOutput(this, 'BucketBName', { value: this.bucketB.bucketName });
    new cdk.CfnOutput(this, 'BucketCName', { value: this.bucketC.bucketName });
    new cdk.CfnOutput(this, 'DeployBucketName', { value: this.deployBucket.bucketName });
  }
}
