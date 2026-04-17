const TOKEN_KEY = 'poc-csd-id-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch { /* ignore */ }
    const err = new Error(body.message ?? body.error ?? res.statusText) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export interface LoginTokens { kind: 'tokens'; idToken: string; accessToken: string; refreshToken?: string; }
export interface LoginChallenge { kind: 'challenge'; challengeName: string; session: string; }
export async function login(email: string, password: string): Promise<LoginTokens | LoginChallenge> {
  return req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}
export async function respondToNewPassword(email: string, newPassword: string, session: string): Promise<LoginTokens> {
  return req('/auth/new-password', { method: 'POST', body: JSON.stringify({ email, newPassword, session }) });
}

export interface Me { username: string; email: string; groups: string[]; preferredRole: string | null; scheme: 'iam' | 'custom'; }
export const getMe = () => req<Me>('/api/me');

export interface BucketList { scheme: 'iam' | 'custom'; buckets: string[]; }
export const listBuckets = () => req<BucketList>('/api/buckets');

export interface Obj { key: string; size: number; lastModified?: string; }
export interface Listing { scheme: 'iam' | 'custom'; bucket: string; prefix: string; prefixes: string[]; objects: Obj[]; }
export const listObjects = (bucket: string, prefix?: string) =>
  req<Listing>(`/api/buckets/${encodeURIComponent(bucket)}/objects${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`);

export const presignGet = (bucket: string, key: string) =>
  req<{ url: string }>(`/api/buckets/${encodeURIComponent(bucket)}/presigned-get?key=${encodeURIComponent(key)}`);

export const presignPut = (bucket: string, key: string, contentType?: string) =>
  req<{ url: string }>(`/api/buckets/${encodeURIComponent(bucket)}/presigned-put`, {
    method: 'POST',
    body: JSON.stringify({ key, contentType }),
  });

// admin
export const getScheme = () => req<{ scheme: 'iam' | 'custom' }>('/api/admin/scheme');
export const setScheme = (scheme: 'iam' | 'custom') =>
  req<{ scheme: 'iam' | 'custom' }>('/api/admin/scheme', { method: 'PUT', body: JSON.stringify({ scheme }) });
export const getCustomPermissions = () => req<any>('/api/admin/custom-permissions');
export const setCustomPermissions = (body: any) =>
  req<any>('/api/admin/custom-permissions', { method: 'PUT', body: JSON.stringify(body) });
export const listUsers = () =>
  req<Array<{ username: string; email: string; enabled: boolean; status: string; groups: string[] }>>('/api/admin/users');
export const listGroups = () =>
  req<Array<{ name: string; description: string; roleArn: string | null; precedence: number | null }>>('/api/admin/groups');
export const listAllBuckets = () => req<{ buckets: string[] }>('/api/admin/buckets');
