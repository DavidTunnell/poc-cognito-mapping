import { Scope } from './scope';

/**
 * Build an OpenSearch query that (a) matches the user's search term across
 * the CSD document fields, and (b) is filtered down to exactly what their
 * Scope allows. The filter is the whole point: it's what makes IAM the
 * source of truth for a data store (OpenSearch) that doesn't know about IAM.
 *
 * Field names match CSD's Fast Buckets schema (PascalCase).
 */
export function buildSearchQuery(scope: Scope, q: string, size = 50): Record<string, unknown> {
  const must = q
    ? [{
        dis_max: {
          queries: [
            { match: { Key: q } },
            { wildcard: { 'Key.keyword': { value: `*${q}*`, case_insensitive: true } } },
          ],
        },
      }]
    : [{ match_all: {} }];

  const filter = scopeFilter(scope);
  return {
    size,
    _source: ['BucketName', 'Key', 'Parent', 'IsFolder', 'Size', 'LastModified'],
    query: { bool: filter ? { must, filter: [filter] } : { must } },
    sort: [{ _score: 'desc' }, { 'Key.keyword': 'asc' }],
  };
}

/**
 * Convert a Scope into an OpenSearch bool filter clause targeting CSD's schema.
 *
 * - Empty scope (no buckets): match_none. If the user's IAM scope is empty they
 *   should see zero hits, not accidental ones.
 * - Bucket with no allowedPrefixes: whole-bucket access. `term: BucketName`.
 * - Bucket with allowedPrefixes: `BucketName AND (Key.keyword startsWith any)`.
 */
export function scopeFilter(scope: Scope): Record<string, unknown> {
  const entries = Object.entries(scope.buckets);
  if (entries.length === 0) {
    return { match_none: {} };
  }
  const should = entries.map(([bucket, s]) => {
    if (s.allowedPrefixes.length === 0) {
      return { term: { 'BucketName.keyword': bucket } };
    }
    return {
      bool: {
        must: [
          { term: { 'BucketName.keyword': bucket } },
          {
            bool: {
              should: s.allowedPrefixes.map(p => ({ prefix: { 'Key.keyword': p } })),
              minimum_should_match: 1,
            },
          },
        ],
      },
    };
  });
  return { bool: { should, minimum_should_match: 1 } };
}
