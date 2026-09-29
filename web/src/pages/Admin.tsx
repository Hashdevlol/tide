import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fmtDate, fmtInt, fmtUsd, shortAddr, timeAgo } from '../lib/format';

const KEY = 'tide_admin_token';

async function adm<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/admin' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-token': sessionStorage.getItem(KEY) ?? '', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error ?? `Request failed (${res.status})`), { status: res.status });
  return j as T;
}

export default function Admin() {
  const [authed, setAuthed] = useState(!!sessionStorage.getItem(KEY));
  const [err, setErr] = useState('');
  const [ov, setOv] = useState<any>(null);

  const load = useCallback(async () => {
    try { setOv(await adm('/overview')); setErr(''); } catch (e: any) {
      if (e.status === 401 || e.status === 404) { sessionStorage.removeItem(KEY); setAuthed(false); }
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    if (!authed) return;
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [authed, load]);

  if (!authed) return <Login err={err} onOk={() => { setAuthed(true); setErr(''); }} />;

  return (
    <div className="page wrap stack" style={{ gap: 22 }}>
      <div className="row-between">
        <div>
          <div className="eyebrow">operator console</div>
          <h1 style={{ fontSize: 34 }}>Admin</h1>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => { sessionStorage.removeItem(KEY); setAuthed(false); }}>Lock</button>
      </div>
      {err && <div className="notice danger">{err}</div>}
      {!ov ? <span className="spinner" /> : <Overview ov={ov} onChange={load} />}
      <Payouts onChange={load} />
      <Users />
      <Reputation />
    </div>
  );
}

function Login({ err, onOk }: { err: string; onOk: () => void }) {
  const [v, setV] = useState('');
  const [e2, setE2] = useState(err);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    sessionStorage.setItem(KEY, v.trim());
    try { await adm('/overview'); onOk(); } catch (x: any) { sessionStorage.removeItem(KEY); setE2(x.message); }
  };
  return (
    <div className="page wrap" style={{ maxWidth: 460 }}>
      <form className="card stack" onSubmit={submit}>
        <h3>Operator console</h3>
        <p className="small muted">Enter the server's <code>ADMIN_SECRET</code>. It's kept for this tab only.</p>
        <input className="input" type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="admin token" autoFocus />
        {e2 && <div className="notice danger">{e2}</div>}
        <button className="btn btn-foam" disabled={!v.trim()}>Unlock</button>
      </form>
    </div>
  );
}

function Overview({ ov, onChange }: { ov: any; onChange: () => void }) {
  const users = Object.fromEntries((ov.users as { kind: string; n: number }[]).map((u) => [u.kind, u.n]));
  const pay = Object.fromEntries((ov.payouts as { status: string; n: number; usd: number }[]).map((p) => [p.status, p]));
  const kick = async (nodeId: string) => {
    const reason = prompt('Reason shown to the node operator?', 'removed by operator');
    if (reason === null) return;
    await adm('/kick', { nodeId, reason });
    onChange();
  };
  return (
    <>
      <div className="grid grid-4" style={{ gap: 12 }}>
        <Tile v={fmtInt(ov.network.nodesOnline)} l="Nodes online" s={`${ov.network.busy} busy · queue ${ov.network.queueDepth}`} />
        <Tile v={fmtInt(ov.jobsToday.n)} l="Jobs today" s={`${fmtInt(ov.jobsToday.t)} tokens · ${fmtInt(ov.jobsToday.c)} credits`} />
        <Tile v={fmtInt((users.wallet ?? 0) + (users.dev ?? 0))} l="Accounts" s={`${fmtInt(users.anon ?? 0)} anonymous sessions`} />
        <Tile v={fmtUsd(ov.paidCreditsToday / 1000)} l="Paid usage today" s={`free subsidy ${fmtUsd(ov.subsidy.today)} today`} foam />
        <Tile v={fmtUsd(ov.liabilities.nodeOwed)} l="Owed to nodes" s="earned − paid out" />
        <Tile v={fmtInt(ov.liabilities.creditsOutstanding)} l="Credits outstanding" s={fmtUsd(ov.liabilities.creditsOutstanding / 1000) + ' of inference'} />
        <Tile v={fmtUsd(ov.treasury.profit ?? 0)} l="Platform revenue" s="after node + referral payouts" />
        <Tile v={fmtInt((pay.needs_review?.n ?? 0) + (pay.pending?.n ?? 0))} l="Payouts to resolve" s={`${fmtUsd((pay.needs_review?.usd ?? 0) + (pay.pending?.usd ?? 0))} held`} foam={!!pay.needs_review?.n} />
      </div>

      <div className="card">
        <h3>Live nodes</h3>
        {ov.nodes.length === 0 ? <div className="empty small muted">No nodes connected.</div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Node</th><th>Model</th><th>Owner</th><th>IP</th><th>Status</th><th className="num">tok/s</th><th className="num">Jobs</th><th>Up</th><th /></tr></thead>
              <tbody>
                {ov.nodes.map((n: any) => (
                  <tr key={n.nodeId}>
                    <td className="mono small">{n.nodeId}</td>
                    <td>{n.model} <span className="badge">{n.type}</span>{n.tools && <span className="badge sky">tools</span>}</td>
                    <td className="mono small">{n.ownerId.slice(0, 8)}</td>
                    <td className="mono small">{n.ip}</td>
                    <td><span className={`badge ${n.status === 'busy' ? 'foam' : ''}`}>{n.status}</span></td>
                    <td className="num">{n.tokPerSec}</td>
                    <td className="num">{fmtInt(n.jobsCompleted)}</td>
                    <td className="small muted">{timeAgo(n.connectedAt)}</td>
                    <td><button className="btn btn-ghost btn-xs" onClick={() => kick(n.nodeId)}>Kick</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Tile({ v, l, s, foam }: { v: string; l: string; s?: string; foam?: boolean }) {
  return <div className="tile"><div className={`v${foam ? ' foam' : ''}`}>{v}</div><div className="l">{l}</div>{s && <div className="s">{s}</div>}</div>;
}

function Payouts({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState('needs_review');
  const [rows, setRows] = useState<any[] | null>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => { adm(`/payouts?status=${status}`).then((r) => setRows(r.payouts)).catch((e) => setMsg(e.message)); }, [status]);
  useEffect(load, [load]);
  const resolve = async (id: number, s: 'completed' | 'failed') => {
    let tx: string | undefined;
    if (s === 'completed') {
      tx = prompt('Transaction signature you verified on-chain:')?.trim();
      if (!tx) return;
    } else if (!confirm('Mark FAILED and release the amount back to the node owner? Only do this if you are certain no USDC was sent.')) return;
    try { await adm(`/payouts/${id}`, { status: s, tx }); setMsg(`Payout #${id} → ${s}`); load(); onChange(); } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="card stack">
      <div className="row-between">
        <h3>Payouts</h3>
        <select className="select" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          {['needs_review', 'pending', 'completed', 'failed', ''].map((s) => <option key={s} value={s}>{s || 'all'}</option>)}
        </select>
      </div>
      {msg && <div className="notice">{msg}</div>}
      {!rows ? <span className="spinner" /> : rows.length === 0 ? <div className="empty small muted">Nothing here.</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Owner</th><th>To</th><th className="num">USDC</th><th>Status</th><th>Created</th><th>Tx</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td>{p.display_name ?? p.user_id.slice(0, 8)}</td>
                  <td className="mono small">{shortAddr(p.address)}</td>
                  <td className="num">{fmtUsd(p.usd)}</td>
                  <td><span className={`badge ${p.status === 'needs_review' ? 'warn' : p.status === 'completed' ? 'foam' : p.status === 'failed' ? 'danger' : ''}`}>{p.status}</span></td>
                  <td className="small muted">{fmtDate(p.created_at)}</td>
                  <td className="mono small">{p.tx ? shortAddr(p.tx) : '—'}</td>
                  <td>
                    {p.status !== 'completed' && p.status !== 'failed' && (
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn btn-ghost btn-xs" onClick={() => resolve(p.id, 'completed')}>Mark sent</button>
                        <button className="btn btn-ghost btn-xs" onClick={() => resolve(p.id, 'failed')}>Release</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Users() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [msg, setMsg] = useState('');
  const search = useCallback((query: string) => { adm(`/users?q=${encodeURIComponent(query)}`).then((r) => setRows(r.users)).catch((e) => setMsg(e.message)); }, []);
  useEffect(() => { search(''); }, [search]);
  const adjust = async (u: any) => {
    const d = prompt(`Credit adjustment for ${u.display_name ?? u.id} (e.g. 500 or -200):`);
    if (!d) return;
    const reason = prompt('Reason (kept in the audit log):', 'support') ?? '';
    try { const r = await adm('/credits', { userId: u.id, delta: Number(d), reason }); setMsg(`${u.display_name ?? u.id}: balance now ${fmtInt(r.balance)}`); search(q); } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="card stack">
      <div className="row-between">
        <h3>Accounts</h3>
        <form className="row" onSubmit={(e) => { e.preventDefault(); search(q); }}>
          <input className="input" style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="wallet, name or id" />
          <button className="btn btn-ghost btn-sm">Search</button>
        </form>
      </div>
      {msg && <div className="notice">{msg}</div>}
      {!rows ? <span className="spinner" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Account</th><th>Wallet</th><th>Plan</th><th className="num">Credits</th><th className="num">Jobs</th><th className="num">Node earned</th><th>Strikes</th><th>Joined</th><th /></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>{u.display_name ?? '—'} <span className="mono tiny dim">{u.id.slice(0, 8)}</span></td>
                  <td className="mono small">{shortAddr(u.wallet) || '—'}</td>
                  <td>{u.plan !== 'free' && u.plan_expires > Date.now() ? <span className="badge foam">{u.plan}</span> : 'free'}</td>
                  <td className="num">{fmtInt(u.credits)}</td>
                  <td className="num">{fmtInt(u.jobs)}</td>
                  <td className="num">{fmtUsd(u.earned, 4)}</td>
                  <td>{u.banned ? <span className="badge danger">banned</span> : u.strikes ? <span className="badge warn">{u.strikes}</span> : '—'}</td>
                  <td className="small muted">{fmtDate(u.created_at, false)}</td>
                  <td><button className="btn btn-ghost btn-xs" onClick={() => adjust(u)}>Credits…</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Reputation() {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(() => { adm('/reputation').then((r) => setRows(r.rows)).catch(() => setRows([])); }, []);
  useEffect(load, [load]);
  const unban = async (id: string) => {
    if (!confirm('Lift the ban and reset strikes + canary history?')) return;
    await adm('/unban', { userId: id });
    load();
  };
  return (
    <div className="card stack">
      <h3>Node reputation</h3>
      <p className="small muted">Strikes come from impossible speeds and incoherent output; bans from 5 strikes or failed canary probes.</p>
      {!rows ? <span className="spinner" /> : rows.length === 0 ? <div className="empty small muted">No strikes recorded.</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Owner</th><th className="num">Strikes</th><th className="num">Canary ✓ / ✗</th><th>Status</th><th>Reason</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id}>
                  <td>{r.display_name ?? r.user_id.slice(0, 8)}</td>
                  <td className="num">{r.strikes}</td>
                  <td className="num">{r.canary_pass} / {r.canary_fail}</td>
                  <td>{r.banned ? <span className="badge danger">banned</span> : <span className="badge">active</span>}</td>
                  <td className="small muted">{r.ban_reason ?? '—'}</td>
                  <td className="small muted">{timeAgo(r.updated_at)}</td>
                  <td>{r.banned ? <button className="btn btn-ghost btn-xs" onClick={() => unban(r.user_id)}>Unban</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
