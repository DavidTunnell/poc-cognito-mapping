import crypto from 'crypto';
import { config, allBuckets } from './config';
import { TokenClaims } from './auth';
import { getScheme, getCustomPermissions, permForUser, Scheme } from './scheme-store';
import { extractBucketCandidates } from './iam-policy';
import { fetchRolePolicies, simulateListBucketPrefixes } from './iam-simulate';

export interface BucketScope {
  /**
   * Prefixes the user is allowed to list/read within this bucket.
   * An empty array means "whole bucket allowed" (unconditioned).
   */
  allowedPrefixes: string[];
  /**
   * Tag-key → values conditions derived from s3:ExistingObjectTag in the
   * user's policy. Only used by the scope filter when the OpenSearch index
   * actually carries tag fields (controlled by config.tagFieldTemplate).
   */
  allowedTags?: Record<string, string[]>;
}

export interface Scope {
  buckets: Record<string, BucketScope>;
  source: Scheme;
}

interface CacheEntry { scope: Scope; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 55 * 60 * 1000; // just under the 1h ID-token lifetime

function tokenHash(idToken: string): string {
  return crypto.createHash('sha256').update(idToken).digest('hex');
}

export async function resolveScope(user: TokenClaims, idToken: string): Promise<Scope> {
  const key = tokenHash(idToken);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.scope;

  const scheme = await getScheme();
  const scope = scheme === 'iam'
    ? await resolveIamScopeViaSimulation(user)
    : await resolveCustomScope(user.username);

  cache.set(key, { scope, expiresAt: Date.now() + TTL_MS });
  return scope;
}

/**
 * Resolve IAM-mode scope by asking AWS directly. Two stages:
 *   1. Fetch the user's role policies and mine them for candidate prefixes
 *      and tag conditions — this is just to know what to ask Simulate.
 *   2. For every known bucket, call SimulatePrincipalPolicy for s3:ListBucket
 *      with each candidate as the s3:prefix context. Whatever Simulate returns
 *      `allowed` is the user's real scope.
 *
 * This removes the "fixed candidate prefix list" limitation — any admin policy
 * that references known buckets now resolves correctly, including Deny overlays,
 * NotResource, and managed-policy attachments.
 */
async function resolveIamScopeViaSimulation(user: TokenClaims): Promise<Scope> {
  const roleArn = user.preferredRole;
  if (!roleArn) {
    // No IAM role mapped (e.g., admin group has no roleArn) — fallback role
    // denies everything, so empty scope is correct.
    return { buckets: {}, source: 'iam' };
  }

  const policies = await fetchRolePolicies(roleArn);
  const candidates = extractBucketCandidates(policies, allBuckets());

  const buckets: Record<string, BucketScope> = {};
  await Promise.all(allBuckets().map(async bucket => {
    const bucketArn = `arn:aws:s3:::${bucket}`;
    // Always probe empty (whole-bucket) so we don't miss wildcard grants
    // that didn't surface as explicit candidates.
    const prefixSet = new Set<string>(['']);
    const extracted = candidates[bucket];
    if (extracted) for (const p of extracted.prefixes) prefixSet.add(p);

    const allowed = await simulateListBucketPrefixes(roleArn, bucketArn, Array.from(prefixSet));
    if (allowed.length === 0) return;

    const hasWholeBucket = allowed.includes('');
    const allowedPrefixes = hasWholeBucket ? [] : allowed.filter(p => p !== '');

    const allowedTags: Record<string, string[]> = {};
    if (extracted) {
      for (const [k, vs] of Object.entries(extracted.tags)) allowedTags[k] = Array.from(vs);
    }

    buckets[bucket] = {
      allowedPrefixes,
      ...(Object.keys(allowedTags).length > 0 ? { allowedTags } : {}),
    };
  }));

  return { buckets, source: 'iam' };
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
