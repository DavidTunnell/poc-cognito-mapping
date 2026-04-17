import { osCall, indexName } from './opensearch';
import { Scope } from './scope';
import { scopeFilter } from './search-query';

export interface Obj {
  key: string;
  size: number;
  lastModified?: string;
}

export interface FolderListing {
  prefixes: string[];  // full-path subfolder keys (may be relative to input prefix)
  objects: Obj[];
}

interface OsHit {
  _source: {
    BucketName: string;
    Key: string;
    Parent?: string;
    IsFolder?: boolean;
    Size?: number;
    LastModified?: string;
  };
}

interface OsSearchResponse { hits: { total: { value: number }; hits: OsHit[] } }

/**
 * Folder-level listing of a bucket, served from OpenSearch (not S3).
 *
 * Mirrors what the Browse UI used to get from ListObjectsV2 with a delimiter,
 * but the gating is now in the OpenSearch query: both a hard `BucketName`
 * term (so we never scan the 58M-doc index) and the scope filter (so users
 * only see what their IAM-derived scope allows).
 *
 * Parent semantics in CSD's index are inconsistent — root may appear as "/"
 * and nested paths with or without a leading slash (e.g., "Dogs1/" and
 * "/Dogs1/" both occur). We match both variants per request.
 */
export async function listFolder(scope: Scope, bucket: string, prefix: string): Promise<FolderListing> {
  // If the bucket isn't in scope at all, return empty deterministically —
  // don't even send a query. Shields the demo from any filter-logic bug.
  if (!scope.buckets[bucket]) return { prefixes: [], objects: [] };

  const parentVariants = prefix === ''
    ? ['/']
    : [prefix, '/' + prefix, prefix.replace(/\/$/, ''), '/' + prefix.replace(/\/$/, '')];

  const body = {
    size: 1000,
    _source: ['BucketName', 'Key', 'Parent', 'IsFolder', 'Size', 'LastModified'],
    query: {
      bool: {
        must: [
          { term: { 'BucketName.keyword': bucket } },
          { terms: { 'Parent.keyword': Array.from(new Set(parentVariants)) } },
        ],
        filter: [scopeFilter(scope)],
      },
    },
    sort: [
      { IsFolder: 'desc' },
      { 'Key.keyword': 'asc' },
    ],
  };

  const r = await osCall<OsSearchResponse>({
    method: 'POST',
    path: `/${indexName()}/_search`,
    body,
  });
  if (r.status !== 200) {
    const detail = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    throw Object.assign(new Error(`OpenSearch listing failed [${r.status}]: ${detail.slice(0, 500)}`), { status: r.status });
  }

  const prefixes: string[] = [];
  const objects: Obj[] = [];
  for (const h of r.body.hits?.hits ?? []) {
    const s = h._source;
    if (s.IsFolder) {
      prefixes.push(s.Key);
    } else {
      objects.push({
        key: s.Key,
        size: s.Size ?? 0,
        lastModified: s.LastModified,
      });
    }
  }
  return { prefixes, objects };
}

/**
 * The set of buckets the user actually has scope over — what /api/buckets
 * returns. Simpler than the old S3-direct behavior and more honest: if IAM
 * gives you zero access to a bucket, you don't see it in the list.
 */
export function bucketsInScope(scope: Scope): string[] {
  return Object.keys(scope.buckets).sort();
}
