function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  region: process.env.AWS_REGION ?? 'us-east-1',
  userPoolId: required('USER_POOL_ID'),
  userPoolClientId: required('USER_POOL_CLIENT_ID'),
  identityPoolId: required('IDENTITY_POOL_ID'),
  buckets: {
    a: required('BUCKET_A'),
    b: required('BUCKET_B'),
    c: required('BUCKET_C'),
  },
  port: Number(process.env.PORT ?? 3000),
  dataDir: process.env.DATA_DIR ?? './data',
  webDistDir: process.env.WEB_DIST_DIR ?? '../web/dist',
};

export function allBuckets(): string[] {
  return [config.buckets.a, config.buckets.b, config.buckets.c];
}

export function loginsKey(): string {
  return `cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
}
