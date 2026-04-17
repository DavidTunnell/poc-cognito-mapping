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
  opensearchEndpoint: process.env.OPENSEARCH_ENDPOINT ?? '',
  opensearchIndex: process.env.OPENSEARCH_INDEX ?? 'poc-csd-objects',
  // Candidate prefixes to probe when the user's IAM role conditions s3:ListBucket
  // on s3:prefix. Kept tiny and predictable on purpose — POC heuristic, not production.
  probePrefixes: (process.env.PROBE_PREFIXES ?? 'x/,y/,proj/,shared/').split(',').filter(Boolean),
  // Disables scope filter injection on /api/search — proves the filter is what
  // makes the difference. Leave off in normal operation.
  searchBypassScope: process.env.SEARCH_BYPASS_SCOPE === '1',
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
