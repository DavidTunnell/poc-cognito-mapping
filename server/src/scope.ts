import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { AwsCredentialIdentity } from '@aws-sdk/types';
import { config, allBuckets } from './config';
import { getCredentialsForIdToken } from './iam-credentials';
import { getCustomPermissions, getScheme, permForUser, Scheme } from './scheme-store';

export interface BucketScope {
  /**
   * Prefixes the user is allowed to list/read within this bucket.
   * An empty array means "whole bucket allowed" (unconditioned).
   */
  allowedPrefixes: string[];
}

export interface Scope {
  buckets: Record<string, BucketScope>;
  source: Scheme;
}

interface CacheEntry { scope: Scope; expiresAt: number; }

// In-memory cache keyed by hash of the ID token. Entries expire when the token
// would expire (ID tokens are 1h in this POC). For an IAM mode resolution this
// avoids re-probing on every request; for custom mode resolution is essentially
// free but we cache uniformly for simplicity.
const cache = new Map<string, CacheEntry>();
const TTL_MS = 55 * 60 * 1000; // just under the 1h token lifetime

function tokenHash(idToken: string): string {
  return crypto.createHash('sha256').update(idToken).digest('hex');
}

export async function resolveScope(username: string, idToken: string): Promise<Scope> {
  const key = tokenHash(idToken);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.scope;

  const scheme = await getScheme();
  const scope = scheme === 'iam'
    ? await resolveIamScope(idToken)
    : await resolveCustomScope(username);

  cache.set(key, { scope, expiresAt: Date.now() + TTL_MS });
  return scope;
}

async function resolveIamScope(idToken: string): Promise<Scope> {
  const creds = await getCredentialsForIdToken(idToken);
  const buckets: Record<string, BucketScope> = {};
  await Promise.all(allBuckets().map(async bucket => {
    const scope = await probeBucketScope(creds, bucket);
    if (scope) buckets[bucket] = scope;
  }));
  return { buckets, source: 'iam' };
}

/**
 * Probe what the user can actually list in a bucket.
 * 1. Try an unconditioned list — if it works, the whole bucket is in scope.
 * 2. If that fails (IAM policy has an s3:prefix condition), try each known
 *    candidate prefix. The ones that succeed define the allowed set.
 *
 * This is a POC heuristic. Production would use iam:SimulatePrincipalPolicy
 * against the user's role, which handles arbitrary conditions reliably.
 */
async function probeBucketScope(creds: AwsCredentialIdentity, bucket: string): Promise<BucketScope | null> {
  const s3 = new S3Client({ region: config.region, credentials: creds });

  try {
    await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    return { allowedPrefixes: [] };
  } catch {
    // fall through to prefix probes
  }

  const allowed: string[] = [];
  await Promise.all(config.probePrefixes.map(async prefix => {
    try {
      await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }));
      allowed.push(prefix);
    } catch { /* denied */ }
  }));
  return allowed.length > 0 ? { allowedPrefixes: allowed } : null;
}

async function resolveCustomScope(username: string): Promise<Scope> {
  const all = await getCustomPermissions();
  const perm = permForUser(all, username);
  const buckets: Record<string, BucketScope> = {};
  for (const [bucket, bp] of Object.entries(perm.buckets)) {
    buckets[bucket] = { allowedPrefixes: bp.prefixes };
  }
  return { buckets, source: 'custom' };
}

export function invalidateCache(): void { cache.clear(); }
