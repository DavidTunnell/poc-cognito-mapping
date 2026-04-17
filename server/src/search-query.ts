import { Scope } from './scope';
import { config } from './config';

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
    const clauses: Record<string, unknown>[] = [{ term: { 'BucketName.keyword': bucket } }];

    if (s.allowedPrefixes.length > 0) {
      clauses.push({
        bool: {
          should: s.allowedPrefixes.map(p => ({ prefix: { 'Key.keyword': p } })),
          minimum_should_match: 1,
        },
      });
    }

    // Tag-based condition — only emitted when the index actually has tag fields
    // (controlled by config.tagFieldTemplate). Without the template, tag
    // conditions in the IAM policy are carried on the Scope for truthfulness
    // but don't narrow search results; S3 still enforces at presign time.
    if (s.allowedTags && config.tagFieldTemplate) {
      for (const [tagKey, values] of Object.entries(s.allowedTags)) {
        if (values.length === 0) continue;
        const field = config.tagFieldTemplate.replace(/\{key\}/g, tagKey);
        clauses.push({
          bool: {
            should: values.map(v => ({ term: { [field]: v } })),
            minimum_should_match: 1,
          },
        });
      }
    }

    return clauses.length === 1 ? clauses[0] : { bool: { must: clauses } };
  });
  return { bool: { should, minimum_should_match: 1 } };
}
