import { useEffect, useState } from 'react';
import { Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Browse } from './pages/Browse';
import { Admin } from './pages/Admin';
import { getMe, getToken, setToken, Me } from './api';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  async function refreshMe() {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try {
      const m = await getMe();
      setMe(m);
    } catch {
      setToken(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refreshMe(); }, []);

  function logout() {
    setToken(null);
    setMe(null);
    nav('/login');
  }

  if (loading) return <div className="container">Loading…</div>;

  return (
    <>
      <header className="header">
        <h1>POC CSD — Cognito ⟶ IAM</h1>
        <div className="header-right">
          {me ? (
            <>
              <span className={`badge ${me.scheme}`}>{me.scheme.toUpperCase()}</span>
              <span>{me.email}</span>
              <Link to="/browse">Browse</Link>
              {me.groups.includes('admin') && <Link to="/admin">Admin</Link>}
              <a href="#" onClick={e => { e.preventDefault(); logout(); }}>Logout</a>
            </>
          ) : (
            <Link to="/login">Login</Link>
          )}
        </div>
      </header>
      <div className="container">
        <Routes>
          <Route path="/" element={me ? <Navigate to="/browse" /> : <Navigate to="/login" />} />
          <Route path="/login" element={<Login onLoggedIn={refreshMe} />} />
          <Route path="/browse" element={me ? <Browse me={me} refreshMe={refreshMe} /> : <Navigate to="/login" />} />
          <Route path="/admin" element={me?.groups.includes('admin') ? <Admin refreshMe={refreshMe} /> : <Navigate to="/browse" />} />
        </Routes>
      </div>
    </>
  );
}
