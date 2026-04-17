/**
 * Pure helpers for parsing IAM policy documents and extracting the pieces
 * that matter for scope resolution:
 *
 *   - Which buckets the user might have access to
 *   - Which s3:prefix values the admin referenced (to probe via Simulate)
 *   - Which s3:ExistingObjectTag conditions are in play (for tag-aware filtering)
 *
 * We don't try to fully evaluate the policy — iam:SimulatePrincipalPolicy
 * does that. These helpers just find the candidate inputs to feed it.
 *
 * Testable without AWS.
 */

export type Effect = 'Allow' | 'Deny';
export type StringOrArray = string | string[];

export interface PolicyStatement {
  Effect: Effect;
  Action?: StringOrArray;
  NotAction?: StringOrArray;
  Resource?: StringOrArray;
  NotResource?: StringOrArray;
  Condition?: Record<string, Record<string, StringOrArray>>;
  Sid?: string;
}

export interface PolicyDocument {
  Version?: string;
  Statement?: PolicyStatement | PolicyStatement[];
}

export interface BucketCandidates {
  /** Prefix values to probe via Simulate. '' means "no s3:prefix condition". */
  prefixes: Set<string>;
  /** Tag key → candidate values (from s3:ExistingObjectTag/<key> conditions). */
  tags: Record<string, Set<string>>;
}

function toArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function isS3Action(action: string): boolean {
  return action === '*' || action === 's3:*' || action.startsWith('s3:');
}

interface ParsedArn { bucket: string; path: string; }

export function parseS3Arn(arn: string): ParsedArn | null {
  if (arn === '*') return { bucket: '*', path: '*' };
  if (!arn.startsWith('arn:aws:s3:::')) return null;
  const rest = arn.slice('arn:aws:s3:::'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return { bucket: rest, path: '' };
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/**
 * `Dogs1/*` → `Dogs1/`, `foo` → `foo`, `*` → `''` (whole-bucket).
 * For Simulate we want literal prefix values, not glob patterns — IAM's
 * StringLike operator handles the wildcard semantics on its side.
 */
export function stripTrailingWildcard(value: string): string {
  if (value === '*') return '';
  return value.replace(/\*+$/, '');
}

export function extractBucketCandidates(
  docs: PolicyDocument[],
  knownBuckets: string[],
): Record<string, BucketCandidates> {
  const out: Record<string, BucketCandidates> = {};
  const knownSet = new Set(knownBuckets);

  const ensure = (bucket: string): BucketCandidates => {
    if (!out[bucket]) out[bucket] = { prefixes: new Set<string>(), tags: {} };
    return out[bucket];
  };

  const addToAllKnown = () => {
    for (const b of knownBuckets) ensure(b).prefixes.add('');
  };

  for (const doc of docs) {
    for (const stmt of toArray(doc.Statement)) {
      if (!stmt) continue;
      const actions = toArray(stmt.Action);
      const notActions = toArray(stmt.NotAction);
      // Only consider statements that could affect S3. NotAction statements
      // are hard to enumerate exhaustively — we treat them as "possibly
      // relevant" if no explicit S3 action is excluded.
      const touchesS3 = actions.some(isS3Action) || (notActions.length > 0 && !notActions.some(isS3Action));
      if (!touchesS3) continue;

      const resources = toArray(stmt.Resource);
      const notResources = toArray(stmt.NotResource);
      const resourceArns = resources.length > 0 ? resources : notResources; // best effort
      const hasWildcardResource = resourceArns.some(r => r === '*' || r === 'arn:aws:s3:::*');

      if (hasWildcardResource) {
        // Admin granted S3 access on all resources — could apply to any bucket.
        // Add every known bucket with the empty-prefix candidate.
        addToAllKnown();
      }

      for (const resource of resourceArns) {
        const parsed = parseS3Arn(resource);
        if (!parsed) continue;
        if (parsed.bucket === '*') continue;          // covered above
        if (!knownSet.has(parsed.bucket)) continue;   // not a bucket we care about
        const c = ensure(parsed.bucket);
        if (parsed.path === '' || parsed.path === '*') {
          c.prefixes.add('');
        } else {
          c.prefixes.add(stripTrailingWildcard(parsed.path));
        }
      }

      if (stmt.Condition) {
        for (const opName of Object.keys(stmt.Condition)) {
          const clause: Record<string, StringOrArray> = stmt.Condition[opName] ?? {};
          for (const contextKey of Object.keys(clause)) {
            const values: string[] = toArray<string>(clause[contextKey]);
            if (contextKey === 's3:prefix') {
              const applyTo = hasWildcardResource ? knownBuckets : resourceArns
                .map(parseS3Arn)
                .filter((p): p is ParsedArn => !!p && p.bucket !== '*' && knownSet.has(p.bucket))
                .map(p => p.bucket);
              for (const b of applyTo) {
                const c = ensure(b);
                for (const v of values) c.prefixes.add(stripTrailingWildcard(v));
              }
            } else if (contextKey.startsWith('s3:ExistingObjectTag/')) {
              const tagKey = contextKey.slice('s3:ExistingObjectTag/'.length);
              const applyTo = hasWildcardResource ? knownBuckets : resourceArns
                .map(parseS3Arn)
                .filter((p): p is ParsedArn => !!p && p.bucket !== '*' && knownSet.has(p.bucket))
                .map(p => p.bucket);
              for (const b of applyTo) {
                const c = ensure(b);
                if (!c.tags[tagKey]) c.tags[tagKey] = new Set<string>();
                for (const v of values) c.tags[tagKey].add(v);
              }
            }
          }
        }
      }
    }
  }

  return out;
}
