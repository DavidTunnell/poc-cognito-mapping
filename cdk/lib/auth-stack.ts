import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// Real CSD demo buckets the POC targets. All live in account 592920047652.
const BUCKET_ALL = 'cloudsee-demo';            // bob gets full RW here
const BUCKET_PREFIX = 'cloudsee-demo-1';       // carol reads only under Dogs1/
const BUCKET_PREFIX_SCOPE = 'Dogs1/';          // the prefix carol is scoped to
const ALL_BUCKETS = [
  'cloudsee-demo',
  'cloudsee-demo-1',
  'cloudsee-demo-2',
  's3-file-1000k',
  'henry-drive-test-1000k',
];

function bucketArn(name: string): string { return `arn:aws:s3:::${name}`; }
function objectsArn(name: string): string { return `arn:aws:s3:::${name}/*`; }

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPool: cognito.CfnIdentityPool;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // User Pool — email+password, admin-created users only
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'poc-csd-users',
      signInAliases: { email: true, username: true },
      selfSignUpEnabled: false,
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
        requireUppercase: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: 'poc-csd-app',
      authFlows: { userPassword: true, adminUserPassword: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Identity Pool — federates User Pool tokens to IAM roles
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: 'poc_csd_identity_pool',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{
        clientId: this.userPoolClient.userPoolClientId,
        providerName: this.userPool.userPoolProviderName,
        serverSideTokenCheck: true,
      }],
    });

    // Default authenticated role (fallback — denies everything except whoami)
    const defaultAuthRole = new iam.Role(this, 'DefaultAuthRole', {
      roleName: 'poc-csd-default-authenticated',
      assumedBy: this.federatedPrincipal(this.identityPool.ref),
      description: 'Fallback role for authenticated Cognito users not in any group',
      inlinePolicies: {
        deny: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            actions: ['s3:*'],
            resources: ['*'],
          })],
        }),
      },
    });

    // Per-group IAM roles — now targeting REAL CSD demo buckets.
    // (Previously pointed at our own poc-csd-bucket-* test buckets.)

    const readonlyAllRole = new iam.Role(this, 'ReadonlyAllRole', {
      roleName: 'poc-csd-readonly-all',
      assumedBy: this.federatedPrincipal(this.identityPool.ref),
      description: 'Read-only on all 5 real CSD demo buckets',
    });
    readonlyAllRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: ALL_BUCKETS.map(bucketArn),
    }));
    readonlyAllRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: ALL_BUCKETS.map(objectsArn),
    }));

    const rwBucketARole = new iam.Role(this, 'RwBucketARole', {
      roleName: 'poc-csd-rw-bucket-a',
      assumedBy: this.federatedPrincipal(this.identityPool.ref),
      description: `Full RW on ${BUCKET_ALL} only`,
    });
    rwBucketARole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [bucketArn(BUCKET_ALL)],
    }));
    rwBucketARole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [objectsArn(BUCKET_ALL)],
    }));

    const readonlyPrefixXRole = new iam.Role(this, 'ReadonlyPrefixXRole', {
      roleName: 'poc-csd-readonly-prefix-x',
      assumedBy: this.federatedPrincipal(this.identityPool.ref),
      description: `Read-only on ${BUCKET_PREFIX}, restricted to ${BUCKET_PREFIX_SCOPE}`,
    });
    readonlyPrefixXRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [bucketArn(BUCKET_PREFIX)],
      conditions: {
        StringLike: { 's3:prefix': [`${BUCKET_PREFIX_SCOPE}*`, BUCKET_PREFIX_SCOPE] },
      },
    }));
    readonlyPrefixXRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${BUCKET_PREFIX}/${BUCKET_PREFIX_SCOPE}*`],
    }));

    // Cognito groups → role ARNs
    new cognito.CfnUserPoolGroup(this, 'GroupReadonlyAll', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'readonly-all',
      description: 'Read-only access to all POC buckets',
      roleArn: readonlyAllRole.roleArn,
      precedence: 10,
    });

    new cognito.CfnUserPoolGroup(this, 'GroupRwBucketA', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'rw-bucket-a',
      description: 'Read/write bucket A only',
      roleArn: rwBucketARole.roleArn,
      precedence: 20,
    });

    new cognito.CfnUserPoolGroup(this, 'GroupReadonlyPrefixX', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'readonly-prefix-x',
      description: 'Read-only bucket B prefix x/',
      roleArn: readonlyPrefixXRole.roleArn,
      precedence: 30,
    });

    // Admin group — no IAM role mapping; used only for app-level admin checks
    new cognito.CfnUserPoolGroup(this, 'GroupAdmin', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Can toggle permission scheme and edit custom permissions',
      precedence: 5,
    });

    // Identity Pool role attachment — use the role in the ID token (cognito:preferred_role).
    // The map key is `cognito-idp.<region>.amazonaws.com/<userPoolId>:<clientId>`, which
    // contains deploy-time-resolved tokens. CloudFormation can't use tokens as map keys,
    // so we build the whole roleMappings object via CfnJson which defers resolution.
    const providerName = `cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}:${this.userPoolClient.userPoolClientId}`;
    const roleMappings = new cdk.CfnJson(this, 'RoleMappings', {
      value: {
        [providerName]: {
          Type: 'Token',
          AmbiguousRoleResolution: 'AuthenticatedRole',
          IdentityProvider: providerName,
        },
      },
    });
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoles', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: defaultAuthRole.roleArn,
      },
      roleMappings: roleMappings as unknown as { [key: string]: cognito.CfnIdentityPoolRoleAttachment.RoleMappingProperty },
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: this.identityPool.ref });
    new cdk.CfnOutput(this, 'ReadonlyAllRoleArn', { value: readonlyAllRole.roleArn });
    new cdk.CfnOutput(this, 'RwBucketARoleArn', { value: rwBucketARole.roleArn });
    new cdk.CfnOutput(this, 'ReadonlyPrefixXRoleArn', { value: readonlyPrefixXRole.roleArn });
  }

  private federatedPrincipal(identityPoolId: string): iam.IPrincipal {
    return new iam.FederatedPrincipal(
      'cognito-identity.amazonaws.com',
      {
        StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPoolId },
        'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
      },
      'sts:AssumeRoleWithWebIdentity',
    );
  }

}
