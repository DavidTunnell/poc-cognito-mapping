import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, respondToNewPassword, setToken } from '../api';

export function Login({ onLoggedIn }: { onLoggedIn: () => void | Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [session, setSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (session) {
        const res = await respondToNewPassword(email, newPassword, session);
        setToken(res.idToken);
        await onLoggedIn();
        nav('/browse');
      } else {
        const res = await login(email, password);
        if (res.kind === 'challenge' && res.challengeName === 'NEW_PASSWORD_REQUIRED') {
          setSession(res.session);
          setError('First login — set a new password.');
        } else if (res.kind === 'tokens') {
          setToken(res.idToken);
          await onLoggedIn();
          nav('/browse');
        } else {
          setError(`Unexpected challenge: ${(res as any).challengeName}`);
        }
      }
    } catch (e: any) {
      setError(e.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 420, margin: '48px auto' }}>
      <h2>Sign in</h2>
      <form onSubmit={onSubmit} className="col">
        <input placeholder="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
        {!session && (
          <input type="password" placeholder="password" value={password} onChange={e => setPassword(e.target.value)} required />
        )}
        {session && (
          <input type="password" placeholder="new password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
        )}
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? '…' : session ? 'Set password & continue' : 'Sign in'}</button>
      </form>
      <p className="muted" style={{ marginTop: 16 }}>
        Demo users: <code>alice@poc.local</code>, <code>bob@poc.local</code>, <code>carol@poc.local</code>, <code>admin@poc.local</code>
      </p>
    </div>
  );
}
