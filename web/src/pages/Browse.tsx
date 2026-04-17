import { useEffect, useState } from 'react';
import { Me, listBuckets, listObjects, presignGet, presignPut } from '../api';

export function Browse({ me, refreshMe }: { me: Me; refreshMe: () => Promise<void> | void }) {
  const [buckets, setBuckets] = useState<string[] | null>(null);
  const [bucket, setBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [listing, setListing] = useState<Awaited<ReturnType<typeof listObjects>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);

  async function reloadBuckets() {
    setError(null);
    try {
      const res = await listBuckets();
      setBuckets(res.buckets);
      if (res.buckets.length && !bucket) setBucket(res.buckets[0]);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function reloadObjects() {
    if (!bucket) return;
    setError(null);
    try {
      const res = await listObjects(bucket, prefix || undefined);
      setListing(res);
    } catch (e: any) {
      setError(e.message);
      setListing(null);
    }
  }

  useEffect(() => { reloadBuckets(); }, [me.scheme]);
  useEffect(() => { reloadObjects(); }, [bucket, prefix]);

  async function onDownload(key: string) {
    try {
      const { url } = await presignGet(bucket!, key);
      window.open(url, '_blank');
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function onUpload(file: File) {
    if (!bucket) return;
    setUploadBusy(true);
    setError(null);
    try {
      const key = (prefix ?? '') + file.name;
      const { url } = await presignPut(bucket, key, file.type);
      const res = await fetch(url, { method: 'PUT', body: file, headers: file.type ? { 'content-type': file.type } : {} });
      if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      await reloadObjects();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploadBusy(false);
    }
  }

  const crumbs = prefix.split('/').filter(Boolean);

  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <strong>Buckets</strong>
            <span className="muted">— {me.scheme === 'iam' ? 'what IAM allows you to see' : 'what the custom permissions table grants'}</span>
          </div>
          <button className="secondary" onClick={reloadBuckets}>Refresh</button>
        </div>
        {buckets === null && <div className="muted">Loading…</div>}
        {buckets && buckets.length === 0 && <div className="muted">No buckets visible in {me.scheme} mode.</div>}
        {buckets && buckets.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', marginTop: 12 }}>
            {buckets.map(b => (
              <button
                key={b}
                className={b === bucket ? '' : 'secondary'}
                onClick={() => { setBucket(b); setPrefix(''); }}
              >{b}</button>
            ))}
          </div>
        )}
      </div>

      {bucket && (
        <div className="panel">
          <div className="breadcrumb">
            <a href="#" onClick={e => { e.preventDefault(); setPrefix(''); }}>{bucket}</a>
            {crumbs.map((c, i) => (
              <span key={i}>
                <span className="sep">/</span>
                <a href="#" onClick={e => { e.preventDefault(); setPrefix(crumbs.slice(0, i + 1).join('/') + '/'); }}>{c}</a>
              </span>
            ))}
          </div>

          <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <input type="file" onChange={e => e.target.files?.[0] && onUpload(e.target.files[0])} disabled={uploadBusy} />
            {uploadBusy && <span className="muted">Uploading…</span>}
            <input
              placeholder="jump to prefix (e.g. x/)"
              defaultValue={prefix}
              onKeyDown={e => {
                if (e.key === 'Enter') setPrefix((e.target as HTMLInputElement).value);
              }}
              style={{ minWidth: 220 }}
            />
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              (useful when your IAM role restricts listing to a specific prefix)
            </span>
          </div>

          {error && <div className="error">{error}</div>}

          {listing && (
            <table>
              <thead>
                <tr><th>Key</th><th>Size</th><th>Modified</th><th></th></tr>
              </thead>
              <tbody>
                {listing.prefixes.map(p => (
                  <tr key={p}>
                    <td><a href="#" onClick={e => { e.preventDefault(); setPrefix(p); }}>📁 {p.replace(prefix, '')}</a></td>
                    <td className="muted">—</td>
                    <td></td>
                    <td></td>
                  </tr>
                ))}
                {listing.objects.map(o => (
                  <tr key={o.key}>
                    <td>{o.key.replace(prefix, '')}</td>
                    <td className="muted">{o.size}</td>
                    <td className="muted">{o.lastModified?.slice(0, 19).replace('T', ' ')}</td>
                    <td><button className="secondary" onClick={() => onDownload(o.key)}>Download</button></td>
                  </tr>
                ))}
                {listing.prefixes.length === 0 && listing.objects.length === 0 && (
                  <tr><td colSpan={4} className="muted">(empty)</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
