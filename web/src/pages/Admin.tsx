import { useEffect, useState } from 'react';
import {
  getScheme, setScheme,
  getCustomPermissions, setCustomPermissions,
  listUsers, listGroups, listAllBuckets,
} from '../api';

type UserRow = { username: string; email: string; enabled: boolean; status: string; groups: string[] };
type GroupRow = { name: string; description: string; roleArn: string | null; precedence: number | null };

export function Admin({ refreshMe }: { refreshMe: () => Promise<void> | void }) {
  const [scheme, setSchemeState] = useState<'iam' | 'custom' | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [buckets, setBuckets] = useState<string[]>([]);
  const [perms, setPerms] = useState<string>('{}');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function reload() {
    setError(null);
    try {
      const [s, u, g, b, p] = await Promise.all([
        getScheme(), listUsers(), listGroups(), listAllBuckets(), getCustomPermissions(),
      ]);
      setSchemeState(s.scheme);
      setUsers(u);
      setGroups(g);
      setBuckets(b.buckets);
      setPerms(JSON.stringify(p, null, 2));
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => { reload(); }, []);

  async function toggleScheme(s: 'iam' | 'custom') {
    try {
      await setScheme(s);
      setSchemeState(s);
      await refreshMe();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function savePerms() {
    setSaving(true); setError(null);
    try {
      const parsed = JSON.parse(perms);
      const saved = await setCustomPermissions(parsed);
      setPerms(JSON.stringify(saved, null, 2));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const sampleTemplate = () => {
    const sample: any = {};
    users.filter(u => !u.groups.includes('admin')).forEach(u => {
      sample[u.username] = {
        buckets: Object.fromEntries(buckets.map(b => [b, { prefixes: [], access: 'r' }])),
      };
    });
    setPerms(JSON.stringify(sample, null, 2));
  };

  return (
    <>
      <div className="panel">
        <h2 style={{ margin: '0 0 8px' }}>Permission scheme</h2>
        <p className="muted" style={{ margin: '0 0 12px' }}>
          <strong>IAM</strong>: app federates the Cognito user to their mapped IAM role via Identity Pool.
          S3 enforces permissions natively.<br />
          <strong>Custom</strong>: app uses its own instance role and filters results against the JSON table below.
          Mirrors CSD today.
        </p>
        <div className="scheme-toggle">
          <button
            className={scheme === 'iam' ? 'active' : 'inactive'}
            onClick={() => toggleScheme('iam')}
          >IAM-inherited</button>
          <button
            className={scheme === 'custom' ? 'active' : 'inactive'}
            onClick={() => toggleScheme('custom')}
          >Custom</button>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ margin: '0 0 8px' }}>Cognito groups & IAM role mapping</h2>
        <table>
          <thead><tr><th>Group</th><th>Precedence</th><th>Mapped IAM role</th><th>Description</th></tr></thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.name}>
                <td><code>{g.name}</code></td>
                <td className="muted">{g.precedence ?? '—'}</td>
                <td><code className="muted" style={{ fontSize: '0.8rem' }}>{g.roleArn ? g.roleArn.split('/').pop() : '(none)'}</code></td>
                <td className="muted">{g.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ margin: '0 0 8px' }}>Users</h2>
        <table>
          <thead><tr><th>Email</th><th>Username</th><th>Status</th><th>Groups</th></tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.username}>
                <td>{u.email}</td>
                <td className="muted">{u.username}</td>
                <td className="muted">{u.status}</td>
                <td>{u.groups.map(g => <code key={g} style={{ marginRight: 4 }}>{g}</code>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ margin: '0 0 8px' }}>Custom permission table</h2>
        <p className="muted" style={{ margin: '0 0 12px' }}>
          Only applied when scheme = <code>custom</code>. Shape:
          {' '}<code>{`{ "<username>": { "buckets": { "<bucket>": { "prefixes": [], "access": "r"|"rw" } } } }`}</code>
        </p>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="secondary" onClick={sampleTemplate}>Generate template from current users & buckets</button>
          <button onClick={savePerms} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
        <textarea className="json" value={perms} onChange={e => setPerms(e.target.value)} />
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </>
  );
}
