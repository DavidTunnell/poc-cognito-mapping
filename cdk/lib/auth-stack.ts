import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface AuthStackProps extends cdk.StackProps {
  bucketA: s3.Bucket;
  bucketB: s3.Bucket;
  bucketC: s3.Bucket;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPool: cognito.CfnIdentityPool;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
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

    // Per-group IAM roles
    const readonlyAllRole = new iam.Role(this, 'ReadonlyAllRole', {
      roleName: 'poc-csd-readonly-all',
      assumedBy: this.federatedPrincipal(this.identityPool.ref),
      description: 'Read-only access to all POC buckets',
    });
    this.attachS3Readonly(readonlyAllRole, [props.bucketA, props.bucketB, props.bucketC]);

    const rwBucketARole = new iam.Role(this, 'RwBucketARole', {
      roleName: 'poc-csd-rw-bucket-a',
      assumedBy: this.federatedPrincipal(this.identityPool.ref),
      description: 'Full read/write on bucket A only',
    });
    rwBucketARole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [props.bucketA.bucketArn],
    }));
    rwBucketARole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`${props.bucketA.bucketArn}/*`],
    }));

    const readonlyPrefixXRole = new iam.Role(this, 'ReadonlyPrefixXRole', {
      roleName: 'poc-csd-readonly-prefix-x',
      assumedBy: this.federatedPrincipal(this.identityPool.ref),
      description: 'Read-only access to bucket B, restricted to prefix x/',
    });
    readonlyPrefixXRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [props.bucketB.bucketArn],
      conditions: {
        StringLike: { 's3:prefix': ['x/*', 'x/'] },
      },
    }));
    readonlyPrefixXRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${props.bucketB.bucketArn}/x/*`],
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

  private attachS3Readonly(role: iam.Role, buckets: s3.Bucket[]): void {
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: buckets.map(b => b.bucketArn),
    }));
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: buckets.map(b => `${b.bucketArn}/*`),
    }));
  }
}
