import { Router } from 'express';
import { requireAuth } from '../middleware';
import { resolveScope } from '../scope';
import { buildSearchQuery, scopeFilter } from '../search-query';
import { osCall, indexName } from '../opensearch';
import { config } from '../config';

export const searchRouter = Router();

searchRouter.use(requireAuth);

interface OsSearchHit {
  _id: string;
  _score: number;
  _source: { bucket: string; key: string; prefix?: string; size?: number; lastModified?: string };
}
interface OsSearchResponse {
  hits: { total: { value: number }; hits: OsSearchHit[] };
}

searchRouter.get('/search', async (req, res) => {
  const q = (req.query.q as string | undefined) ?? '';
  try {
    const scope = await resolveScope(req.user!.username, req.idToken!);

    const query = config.searchBypassScope
      ? bypassedQuery(q)
      : buildSearchQuery(scope, q, 50);

    const r = await osCall<OsSearchResponse>({
      method: 'POST',
      path: `/${indexName()}/_search`,
      body: query,
    });

    if (r.status !== 200) {
      return res.status(r.status).json({ error: 'OpenSearch', status: r.status, body: r.body }) as any;
    }
    res.json({
      scheme: scope.source,
      bypassedScope: config.searchBypassScope,
      scope: scope.buckets,
      total: r.body.hits?.total?.value ?? 0,
      hits: (r.body.hits?.hits ?? []).map(h => ({
        id: h._id,
        score: h._score,
        ...h._source,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.name ?? 'SearchFailed', message: e.message });
  }
});

function bypassedQuery(q: string): Record<string, unknown> {
  return {
    size: 50,
    _source: ['bucket', 'key', 'prefix', 'size', 'lastModified'],
    query: q
      ? { multi_match: { query: q, fields: ['key^3', 'prefix^2', 'bucket'] } }
      : { match_all: {} },
    sort: [{ _score: 'desc' }, { 'key.keyword': 'asc' }],
  };
}

// Debug: return the resolved scope for the current user (no search).
searchRouter.get('/scope', async (req, res) => {
  try {
    const scope = await resolveScope(req.user!.username, req.idToken!);
    res.json(scope);
  } catch (e: any) {
    res.status(500).json({ error: e.name, message: e.message });
  }
});

// Use the same scope filter against OpenSearch's _count endpoint — useful for
// debugging and for verifying the filter matches what the UI shows.
searchRouter.get('/search-count', async (req, res) => {
  try {
    const scope = await resolveScope(req.user!.username, req.idToken!);
    const filter = scopeFilter(scope);
    const body = filter
      ? { query: { bool: { filter: [filter] } } }
      : { query: { match_all: {} } };
    const r = await osCall<{ count: number }>({
      method: 'POST',
      path: `/${indexName()}/_count`,
      body,
    });
    res.status(r.status).json(r.body);
  } catch (e: any) {
    res.status(500).json({ error: e.name, message: e.message });
  }
});
