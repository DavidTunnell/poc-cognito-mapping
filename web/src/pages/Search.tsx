import { FormEvent, useEffect, useState } from 'react';
import { Me, search, SearchResponse, presignGet, getScope } from '../api';

export function Search({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [scope, setScope] = useState<Awaited<ReturnType<typeof getScope>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reloadScope() {
    try { setScope(await getScope()); } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { reloadScope(); }, [me.scheme]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await search(q);
      setRes(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function openObject(bucket: string, key: string) {
    try {
      const { url } = await presignGet(bucket, key);
      window.open(url, '_blank');
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="panel">
        <h2 style={{ margin: '0 0 8px' }}>Your scope</h2>
        <p className="muted" style={{ margin: '0 0 8px' }}>
          Derived from your {me.scheme === 'iam' ? 'IAM role via prefix-probing at login' : 'custom permission table'}.
          This is the <em>only</em> thing that filters search results — OpenSearch itself doesn't know about IAM.
        </p>
        {scope && (
          <table>
            <thead><tr><th>Bucket</th><th>Allowed prefixes</th></tr></thead>
            <tbody>
              {Object.entries(scope.buckets).map(([b, s]) => (
                <tr key={b}>
                  <td><code>{b}</code></td>
                  <td>{s.allowedPrefixes.length === 0 ? <em className="muted">(whole bucket)</em> : s.allowedPrefixes.map(p => <code key={p} style={{ marginRight: 4 }}>{p}</code>)}</td>
                </tr>
              ))}
              {Object.keys(scope.buckets).length === 0 && (
                <tr><td colSpan={2} className="muted">(no buckets in scope)</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <form onSubmit={onSubmit} className="row">
          <input
            placeholder="search: readme, permitted, shared..."
            value={q}
            onChange={e => setQ(e.target.value)}
            autoFocus
            style={{ flex: 1, minWidth: 260 }}
          />
          <button type="submit" disabled={busy}>{busy ? '…' : 'Search'}</button>
        </form>

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

        {res && (
          <>
            <div className="muted" style={{ margin: '12px 0 4px' }}>
              {res.total} hit{res.total === 1 ? '' : 's'}
              {res.bypassedScope && <span style={{ color: 'var(--danger)', marginLeft: 8 }}> (scope bypassed — SEARCH_BYPASS_SCOPE=1)</span>}
            </div>
            <table>
              <thead>
                <tr><th>Bucket</th><th>Key</th><th>Size</th><th>Modified</th><th></th></tr>
              </thead>
              <tbody>
                {res.hits.map(h => (
                  <tr key={`${h.bucket}/${h.key}`}>
                    <td className="muted">{h.bucket}</td>
                    <td>{h.key}</td>
                    <td className="muted">{h.size ?? ''}</td>
                    <td className="muted">{h.lastModified?.slice(0, 19).replace('T', ' ')}</td>
                    <td><button className="secondary" onClick={() => openObject(h.bucket, h.key)}>Open</button></td>
                  </tr>
                ))}
                {res.hits.length === 0 && <tr><td colSpan={5} className="muted">(no results)</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}
