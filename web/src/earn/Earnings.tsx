import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { fmtDate, fmtInt, fmtUsd, shortAddr } from '../lib/format';
import { explorerTx } from '../lib/solana';

export interface EarningsData {
  balance: { earned: number; referral: number; paid: number; today: number; available: number };
  totals: { jobs: number; tokens: number };
  recent: { job_id: string; usd: number; tokens: number; subsidized: number; created_at: number }[];
  payouts: { id: number; address: string; usd: number; status: string; tx: string | null; created_at: number }[];
  reputation: { strikes: number; banned: number; ban_reason?: string | null };
}

export function useEarnings(enabled: boolean) {
  const [data, setData] = useState<EarningsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<EarningsData>('/api/earnings')); setError(null); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => {
    if (!enabled) { setData(null); return; }
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [enabled, load]);
  return { data, error, reload: load };
}

const STATUS_BADGE: Record<string, string> = { pending: 'sky', completed: 'foam', needs_review: 'warn', failed: 'danger' };

export function EarningsPanel({ data, error, reload }: { data: EarningsData | null; error: string | null; reload(): void }) {
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const withdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ id: number; status: string; tx?: string; url?: string; message?: string; error?: string }>('/api/payouts', { body: { address: address.trim(), amount: Number(amount) } });
      if (r.status === 'completed') setMsg({ ok: true, text: `Payout #${r.id} sent.`, url: r.url ?? (r.tx ? explorerTx(r.tx) : undefined) });
      else if (r.status === 'needs_review') setMsg({ ok: false, text: r.error ?? `Payout #${r.id} could not be confirmed on-chain — an operator will review it.` });
      else setMsg({ ok: true, text: r.message ?? `Payout #${r.id} requested — status: ${r.status}.` });
      setAmount('');
      reload();
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  };

  const b = data?.balance;
  return (
    <div className="stack" style={{ gap: 18 }} id="earnings">
      <div className="row-between">
        <h2 className="section-title" style={{ margin: 0 }}>Earnings</h2>
        <span className="tiny dim mono">refreshes every 20s</span>
      </div>
      {error && <div className="notice danger">{error}</div>}
      {data?.reputation.banned ? (
        <div className="notice danger">This account is banned from serving{data.reputation.ban_reason ? `: ${data.reputation.ban_reason}` : ''}.</div>
      ) : data && data.reputation.strikes > 0 ? (
        <div className="notice warn">Reputation: {data.reputation.strikes} strike{data.reputation.strikes === 1 ? '' : 's'}. Nodes that return fake or incoherent output are not paid and get banned.</div>
      ) : null}

      <div className="grid grid-4">
        <div className="tile"><div className="v foam">{fmtUsd(b?.available)}</div><div className="l">Available</div></div>
        <div className="tile"><div className="v">{fmtUsd(b?.today)}</div><div className="l">Earned today</div></div>
        <div className="tile"><div className="v">{fmtUsd(b?.earned)}</div><div className="l">Node earnings</div><div className="s">{fmtInt(data?.totals.jobs)} jobs · {fmtInt(data?.totals.tokens)} tokens</div></div>
        <div className="tile"><div className="v">{fmtUsd(b?.referral)}</div><div className="l">Referrals</div><div className="s">{fmtUsd(b?.paid)} withdrawn</div></div>
      </div>

      <div className="grid grid-2">
        <form className="card stack" onSubmit={withdraw}>
          <h3>Withdraw USDC</h3>
          <p className="small muted">USDC payouts are processed on Solana. Minimum $1.00. One pending payout at a time.</p>
          <label className="field">
            <span>Solana address</span>
            <input className="input mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Your Solana wallet address" required pattern="[1-9A-HJ-NP-Za-km-z]{32,44}" />
          </label>
          <label className="field">
            <span>Amount (USD)</span>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input mono grow" type="number" min={1} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.00" required />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAmount(String(Math.floor((b?.available ?? 0) * 100) / 100))}>Max</button>
            </div>
          </label>
          <button className="btn btn-foam" disabled={busy || !b || b.available < 1}>{busy ? <span className="spinner" /> : 'Request payout'}</button>
          {b && b.available < 1 && <div className="tiny dim">You need at least $1.00 available to withdraw.</div>}
          {msg && <div className={`notice ${msg.ok ? 'foam' : 'danger'}`}><span>{msg.text} {msg.url && <a className="link" href={msg.url} target="_blank" rel="noreferrer">View transaction →</a>}</span></div>}
        </form>

        <div className="card">
          <h3>Payouts</h3>
          {data?.payouts.length ? (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table">
                <thead><tr><th>Date</th><th>To</th><th className="num">USD</th><th>Status</th></tr></thead>
                <tbody>
                  {data.payouts.map((p) => (
                    <tr key={p.id}>
                      <td>{fmtDate(p.created_at)}</td>
                      <td className="mono">{p.tx ? <a className="link" href={explorerTx(p.tx)} target="_blank" rel="noreferrer">{shortAddr(p.address)}</a> : shortAddr(p.address)}</td>
                      <td className="num">{fmtUsd(p.usd)}</td>
                      <td><span className={`badge ${STATUS_BADGE[p.status] ?? ''}`}>{p.status.replace('_', ' ')}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="empty">No payouts yet.</div>}
        </div>
      </div>

      <div className="card">
        <h3>Recent earnings</h3>
        {data?.recent.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead><tr><th>Time</th><th>Job</th><th className="num">Tokens</th><th className="num">Earned</th></tr></thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.job_id}>
                    <td>{fmtDate(r.created_at)}</td>
                    <td className="mono dim">{r.job_id.slice(0, 14)}…{r.subsidized ? <span className="badge" style={{ marginLeft: 8 }}>free lane</span> : null}</td>
                    <td className="num">{fmtInt(r.tokens)}</td>
                    <td className="num foam">{fmtUsd(r.usd, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">No earnings yet — jobs you serve show up here.</div>}
      </div>
    </div>
  );
}
