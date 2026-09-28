import { useState } from 'react';
import { errMsg } from '../lib/api';
import { checkDeposit, clusterLabel, describeCheck, explorerAddr, type DepositCheck } from '../lib/solana';
import { CopyButton } from './CopyButton';

/** Deposit address + "Check deposit" button. */
export function DepositBox({ address, cluster, mint, onChecked, cta = 'Check deposit' }: {
  address: string; cluster: string; mint: string; onChecked?(r: DepositCheck): void; cta?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const check = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await checkDeposit();
      setMsg({ ok: true, text: describeCheck(r), url: r.sweptUrl });
      onChecked?.(r);
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="small muted">Send <b style={{ color: 'var(--pearl)' }}>USDC</b> on <b style={{ color: 'var(--pearl)' }}>Solana {clusterLabel(cluster)}</b> to your personal deposit address:</div>
      <div className="secret" style={{ borderStyle: 'solid' }}><code>{address}</code><CopyButton text={address} label="Copy" /></div>
      <div className="tiny dim mono" style={{ overflowWrap: 'anywhere' }}>
        USDC mint {mint.slice(0, 6)}…{mint.slice(-4)} · <a className="link" href={explorerAddr(address, cluster)} target="_blank" rel="noreferrer">view on explorer</a>
      </div>
      {cluster !== 'mainnet-beta' && <div className="notice warn tiny">This server runs on Solana {clusterLabel(cluster)} — send test USDC only.</div>}
      <div className="row">
        <button className="btn btn-foam btn-sm" onClick={check} disabled={busy}>{busy ? <span className="spinner" /> : cta}</button>
        <span className="tiny dim">After sending, click to credit your account.</span>
      </div>
      {msg && (
        <div className={`notice ${msg.ok ? 'foam' : 'danger'}`}>
          <span>{msg.text} {msg.url && <a className="link" href={msg.url} target="_blank" rel="noreferrer">Sweep transaction →</a>}</span>
        </div>
      )}
    </div>
  );
}
