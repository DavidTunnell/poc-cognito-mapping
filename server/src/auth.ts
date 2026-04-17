import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from './config';

const idp = new CognitoIdentityProviderClient({ region: config.region });

const verifier = CognitoJwtVerifier.create({
  userPoolId: config.userPoolId,
  tokenUse: 'id',
  clientId: config.userPoolClientId,
});

export interface AuthResult {
  kind: 'tokens';
  idToken: string;
  accessToken: string;
  refreshToken?: string;
}

export interface ChallengeResult {
  kind: 'challenge';
  challengeName: string;
  session: string;
}

export async function login(email: string, password: string): Promise<AuthResult | ChallengeResult> {
  const res = await idp.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: config.userPoolClientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  if (res.ChallengeName) {
    return { kind: 'challenge', challengeName: res.ChallengeName, session: res.Session ?? '' };
  }
  const auth = res.AuthenticationResult;
  if (!auth?.IdToken || !auth?.AccessToken) throw new Error('Cognito returned no tokens');
  return {
    kind: 'tokens',
    idToken: auth.IdToken,
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken,
  };
}

export async function respondToNewPassword(
  email: string,
  newPassword: string,
  session: string,
): Promise<AuthResult> {
  const res = await idp.send(new RespondToAuthChallengeCommand({
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: config.userPoolClientId,
    Session: session,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
  }));
  const auth = res.AuthenticationResult;
  if (!auth?.IdToken || !auth?.AccessToken) throw new Error('Cognito returned no tokens after challenge');
  return { kind: 'tokens', idToken: auth.IdToken, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken };
}

export interface TokenClaims {
  sub: string;
  email: string;
  username: string;
  groups: string[];
  preferredRole?: string;
}

export async function verifyIdToken(idToken: string): Promise<TokenClaims> {
  const claims = await verifier.verify(idToken);
  return {
    sub: claims.sub,
    email: (claims.email as string) ?? '',
    username: (claims['cognito:username'] as string) ?? (claims.sub as string),
    groups: ((claims['cognito:groups'] as string[]) ?? []),
    preferredRole: claims['cognito:preferred_role'] as string | undefined,
  };
}

export async function adminListGroupsForUser(username: string): Promise<string[]> {
  const res = await idp.send(new AdminListGroupsForUserCommand({
    UserPoolId: config.userPoolId,
    Username: username,
  }));
  return (res.Groups ?? []).map(g => g.GroupName ?? '').filter(Boolean);
}
