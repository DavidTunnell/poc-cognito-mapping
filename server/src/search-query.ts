import { Scope } from './scope';

/**
 * Build an OpenSearch query that (a) matches the user's search term across
 * key/prefix/bucket fields, and (b) is filtered down to exactly what their
 * Scope allows. The filter is the whole point: it's what makes IAM the
 * source of truth for a data store (OpenSearch) that doesn't know about IAM.
 */
export function buildSearchQuery(scope: Scope, q: string, size = 50): Record<string, unknown> {
  const must = q
    ? [{
        multi_match: {
          query: q,
          fields: ['key^3', 'prefix^2', 'bucket'],
          type: 'best_fields',
        },
      }]
    : [{ match_all: {} }];

  const filter = scopeFilter(scope);
  return {
    size,
    _source: ['bucket', 'key', 'prefix', 'size', 'lastModified'],
    query: { bool: filter ? { must, filter: [filter] } : { must } },
    sort: [{ _score: 'desc' }, { 'key.keyword': 'asc' }],
  };
}

/**
 * Convert a Scope into an OpenSearch bool filter clause.
 *
 * - Empty scope (no buckets): a filter that matches nothing. Intentional — if
 *   the user's IAM scope is empty they should see zero hits, not accidental ones.
 * - A bucket with no allowedPrefixes: whole-bucket access. Just `term: { bucket }`.
 * - A bucket with allowedPrefixes: `bucket AND (prefix startsWith any)`.
 *
 * Returns null if the caller has explicitly opted out of scope filtering
 * (see SEARCH_BYPASS_SCOPE in routes/search.ts).
 */
export function scopeFilter(scope: Scope): Record<string, unknown> {
  const entries = Object.entries(scope.buckets);
  if (entries.length === 0) {
    return { match_none: {} };
  }
  const should = entries.map(([bucket, s]) => {
    if (s.allowedPrefixes.length === 0) {
      return { term: { bucket } };
    }
    return {
      bool: {
        must: [
          { term: { bucket } },
          {
            bool: {
              should: s.allowedPrefixes.map(p => ({ prefix: { key: p } })),
              minimum_should_match: 1,
            },
          },
        ],
      },
    };
  });
  return { bool: { should, minimum_should_match: 1 } };
}
