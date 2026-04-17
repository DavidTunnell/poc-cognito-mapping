function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const DEFAULT_REAL_BUCKETS = [
  'cloudsee-demo',
  'cloudsee-demo-1',
  'cloudsee-demo-2',
  's3-file-1000k',
  'henry-drive-test-1000k',
];

// Candidate prefixes to probe when a user's IAM role conditions s3:ListBucket
// on s3:prefix. POC heuristic; covers the handful of folder roots in the
// demo buckets (Dogs1/ and Puppies/ in cloudsee-demo-1, plus a few common ones).
const DEFAULT_PROBE_PREFIXES = ['Dogs1/', 'Puppies/', 'shared/', 'proj/', 'x/', 'y/'];

export const config = {
  region: process.env.AWS_REGION ?? 'us-east-1',
  userPoolId: required('USER_POOL_ID'),
  userPoolClientId: required('USER_POOL_CLIENT_ID'),
  identityPoolId: required('IDENTITY_POOL_ID'),
  realBuckets: (process.env.REAL_BUCKETS ?? DEFAULT_REAL_BUCKETS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean),
  opensearchEndpoint: process.env.OPENSEARCH_ENDPOINT ?? '',
  opensearchIndex: process.env.OPENSEARCH_INDEX ?? 'aws_account_592920047652_uat_active',
  probePrefixes: (process.env.PROBE_PREFIXES ?? DEFAULT_PROBE_PREFIXES.join(','))
    .split(',').map(s => s.trim()).filter(Boolean),
  searchBypassScope: process.env.SEARCH_BYPASS_SCOPE === '1',
  port: Number(process.env.PORT ?? 3000),
  dataDir: process.env.DATA_DIR ?? './data',
  webDistDir: process.env.WEB_DIST_DIR ?? '../web/dist',
};

export function allBuckets(): string[] {
  return config.realBuckets;
}

export function loginsKey(): string {
  return `cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
}
