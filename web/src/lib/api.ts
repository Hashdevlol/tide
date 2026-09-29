export const TOKEN_KEY = 'tide_token';

/** Backend origin. Empty = same origin (dev proxy / server-hosted build). Set VITE_API_URL when the web app is hosted separately (e.g. Vercel). */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '');
/** Public origin of the API, for display (base_url, node --url). */
export const apiOrigin = () => API_URL || location.origin;

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};

const listeners = new Set<(t: string | null) => void>();
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
  listeners.forEach((l) => l(t));
}
export function onTokenChange(fn: (t: string | null) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: unknown) { super(message); }
}

/** fetch wrapper: JSON in/out, bearer token from localStorage, readable errors. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? getToken() : opts.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_URL + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data?.error === 'string' ? data.error : data?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
