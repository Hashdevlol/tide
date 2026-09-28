import { useEffect, useState } from 'react';
import { detectWallets, useAuth, type WalletOption } from '../lib/auth';
import { errMsg } from '../lib/api';
import { LogoMark } from './Logo';
import { IconX } from './Icons';

const WALLET_COLORS: Record<string, string> = { phantom: '#AB9FF2', solflare: '#FFEF46', backpack: '#E33E3F', solana: '#3DFFC2' };

export function SignInModal() {
  const { signInOpen, closeSignIn, signInReason, signInWithWallet, devLogin, devMode } = useAuth();
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('dev');

  useEffect(() => {
    if (!signInOpen) return;
    setError(null);
    setBusy(null);
    // Wallet extensions inject asynchronously; poll briefly.
    setWallets(detectWallets());
    const t = setTimeout(() => setWallets(detectWallets()), 600);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSignIn(); };
    addEventListener('keydown', onKey);
    return () => { clearTimeout(t); removeEventListener('keydown', onKey); };
  }, [signInOpen, closeSignIn]);

  if (!signInOpen) return null;

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try { await fn(); } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) closeSignIn(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="signin-title">
        <button className="icon-btn close" onClick={closeSignIn} aria-label="Close"><IconX /></button>
        <div style={{ marginBottom: 16 }}><LogoMark size={40} /></div>
        <h2 id="signin-title">Sign in to Tide</h2>
        <p className="muted small" style={{ marginBottom: 20 }}>
          {signInReason ?? 'Use your Solana wallet. Signing is free — no transaction is sent.'}
        </p>

        <div className="stack" style={{ gap: 8 }}>
          {wallets.map((w) => (
            <button key={w.id} className="wallet-btn" disabled={!!busy} onClick={() => run(w.id, () => signInWithWallet(w))}>
              <span className="wi" style={{ background: WALLET_COLORS[w.id] ?? 'var(--foam)' }}>{w.name[0]}</span>
              <span className="grow" style={{ textAlign: 'left' }}>{w.name}</span>
              {busy === w.id ? <span className="spinner" /> : <span className="badge foam">detected</span>}
            </button>
          ))}
          {wallets.length === 0 && (
            <div className="notice">
              <span>
                No Solana wallet found in this browser. Install{' '}
                <a className="link" href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a>,{' '}
                <a className="link" href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a> or{' '}
                <a className="link" href="https://backpack.app" target="_blank" rel="noreferrer">Backpack</a>, then reload.
                On mobile, open this site inside your wallet app's browser.
              </span>
            </div>
          )}
        </div>

        {devMode && (
          <>
            <div className="divider">DEV BUILD</div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); run('dev', () => devLogin(name)); }}>
              <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dev account name" maxLength={32} aria-label="Dev account name" />
              <button className="btn btn-ghost" disabled={!!busy}>{busy === 'dev' ? <span className="spinner" /> : 'Dev login'}</button>
            </form>
          </>
        )}

        {error && <div className="notice danger" style={{ marginTop: 14 }}>{error}</div>}
      </div>
    </div>
  );
}
