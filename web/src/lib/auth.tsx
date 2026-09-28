import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, getToken, setToken } from './api';
import { base58Encode } from './base58';
import type { Me, PricingConfig, SolanaProvider } from './types';

const REF_KEY = 'tide_ref';
const REF_TTL = 30 * 86_400_000;

/** Capture ?ref=CODE into localStorage for 30 days. */
export function captureReferral() {
  try {
    const ref = new URLSearchParams(location.search).get('ref');
    if (ref && /^[a-z0-9]{4,12}$/.test(ref)) localStorage.setItem(REF_KEY, JSON.stringify({ ref, at: Date.now() }));
  } catch { /* ignore */ }
}
function storedReferral(): string | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(REF_KEY) ?? 'null') as { ref: string; at: number } | null;
    if (v && Date.now() - v.at < REF_TTL) return v.ref;
  } catch { /* ignore */ }
  return undefined;
}

export interface WalletOption { id: string; name: string; provider: SolanaProvider }

export function detectWallets(): WalletOption[] {
  const out: WalletOption[] = [];
  const phantom = window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : undefined);
  if (phantom) out.push({ id: 'phantom', name: 'Phantom', provider: phantom });
  if (window.solflare) out.push({ id: 'solflare', name: 'Solflare', provider: window.solflare });
  if (window.backpack) out.push({ id: 'backpack', name: 'Backpack', provider: window.backpack });
  if (!out.length && window.solana) out.push({ id: 'solana', name: 'Solana wallet', provider: window.solana });
  return out;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  signedIn: boolean;
  devMode: boolean;
  pricing: PricingConfig | null;
  refresh(): Promise<Me | null>;
  ensureSession(): Promise<string>;
  signInWithWallet(w: WalletOption): Promise<void>;
  devLogin(name: string): Promise<void>;
  logout(): Promise<void>;
  signInOpen: boolean;
  signInReason: string | null;
  openSignIn(reason?: string): void;
  closeSignIn(): void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState<PricingConfig | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInReason, setSignInReason] = useState<string | null>(null);
  const anonPromise = useRef<Promise<string> | null>(null);

  const refresh = useCallback(async () => {
    if (!getToken()) { setMe(null); return null; }
    try {
      const m = await api<Me>('/api/me');
      setMe(m);
      setPricing(m.config);
      return m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setToken(null); setMe(null); }
      return null;
    }
  }, []);

  useEffect(() => {
    captureReferral();
    api<PricingConfig>('/api/pricing', { token: null }).then(setPricing).catch(() => {});
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const ensureSession = useCallback(async () => {
    const t = getToken();
    if (t) return t;
    anonPromise.current ??= api<{ token: string }>('/api/auth/anon', { body: {} })
      .then((r) => { setToken(r.token); return r.token; })
      .finally(() => { anonPromise.current = null; });
    const token = await anonPromise.current;
    await refresh();
    return token;
  }, [refresh]);

  const finishLogin = useCallback(async (token: string) => {
    setToken(token);
    await refresh();
    setSignInOpen(false);
  }, [refresh]);

  const signInWithWallet = useCallback(async (w: WalletOption) => {
    const res = await w.provider.connect();
    const pk = (res && 'publicKey' in res ? res.publicKey : w.provider.publicKey)?.toString();
    if (!pk) throw new Error('Wallet did not return a public key');
    const { nonce, message } = await api<{ nonce: string; message: string }>(`/api/auth/nonce?wallet=${encodeURIComponent(pk)}`, { token: null });
    const signed = await w.provider.signMessage(new TextEncoder().encode(message), 'utf8');
    const sig = signed instanceof Uint8Array ? signed : signed.signature;
    const r = await api<{ token: string }>('/api/auth/wallet', {
      token: null,
      body: { wallet: pk, nonce, signature: base58Encode(new Uint8Array(sig)), ref: storedReferral() },
    });
    await finishLogin(r.token);
  }, [finishLogin]);

  const devLogin = useCallback(async (name: string) => {
    const r = await api<{ token: string }>('/api/auth/dev', { token: null, body: { name: name.trim() || 'dev', ref: storedReferral() } });
    await finishLogin(r.token);
  }, [finishLogin]);

  const logout = useCallback(async () => {
    try { await api('/api/auth/logout', { body: {} }); } catch { /* ignore */ }
    setToken(null);
    setMe(null);
  }, []);

  const value = useMemo<AuthCtx>(() => ({
    me,
    loading,
    signedIn: !!me && me.user.kind !== 'anon',
    devMode: (me?.config.devCredits ?? pricing?.devCredits ?? false) || import.meta.env.DEV,
    pricing: me?.config ?? pricing,
    refresh,
    ensureSession,
    signInWithWallet,
    devLogin,
    logout,
    signInOpen,
    signInReason,
    openSignIn: (reason?: string) => { setSignInReason(reason ?? null); setSignInOpen(true); },
    closeSignIn: () => setSignInOpen(false),
  }), [me, loading, pricing, refresh, ensureSession, signInWithWallet, devLogin, logout, signInOpen, signInReason]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
