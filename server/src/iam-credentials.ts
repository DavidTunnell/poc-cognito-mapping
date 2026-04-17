import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { AwsCredentialIdentity } from '@aws-sdk/types';
import { config, loginsKey } from './config';

const cognitoIdentity = new CognitoIdentityClient({ region: config.region });

/**
 * Exchange a Cognito ID token for short-lived AWS credentials scoped to the
 * IAM role that the user's Cognito group maps to (via Identity Pool role attachment).
 *
 * This is the core of "IAM-inherited mode": the resulting creds let S3 enforce
 * the user's permissions natively, with no application-layer translation.
 */
export async function getCredentialsForIdToken(idToken: string): Promise<AwsCredentialIdentity> {
  const logins = { [loginsKey()]: idToken };

  const idRes = await cognitoIdentity.send(new GetIdCommand({
    IdentityPoolId: config.identityPoolId,
    Logins: logins,
  }));
  if (!idRes.IdentityId) throw new Error('Identity Pool returned no IdentityId');

  const credsRes = await cognitoIdentity.send(new GetCredentialsForIdentityCommand({
    IdentityId: idRes.IdentityId,
    Logins: logins,
  }));
  const c = credsRes.Credentials;
  if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken) {
    throw new Error('Identity Pool returned incomplete credentials');
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
}
