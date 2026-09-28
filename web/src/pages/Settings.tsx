import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { PlanId } from '@tide/shared';
import { useAuth } from '../lib/auth';
import { api, ApiError, errMsg } from '../lib/api';
import { clusterLabel, useDeposit, type PlanIntent } from '../lib/solana';
import { DepositBox } from '../components/Deposit';
import { fmtDate, fmtInt, fmtUsd, timeAgo } from '../lib/format';
import { CodeBlock, CopyButton, SecretBox } from '../components/CopyButton';
import { IconTrash } from '../components/Icons';
import type { PlanInfo } from '../lib/types';

const TABS = [
  { id: 'account', label: 'Account' },
  { id: 'plans', label: 'Plans' },
  { id: 'credits', label: 'Credits' },
  { id: 'keys', label: 'API keys' },
  { id: 'usage', label: 'Usage' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function Settings() {
  const { hash } = useLocation();
  const tab: TabId = (TABS.find((t) => `#${t.id}` === hash)?.id ?? 'account') as TabId;
  const { me, signedIn, loading, openSignIn } = useAuth();

  return (
    <div className="page wrap">
      <div className="page-head">
        <div className="eyebrow">// settings</div>
        <h1>Your account</h1>
      </div>
      <div className="settings">
        <nav className="side-tabs" aria-label="Settings sections">
          {TABS.map((t) => <Link key={t.id} to={{ hash: t.id }} replace className={tab === t.id ? 'active' : ''}>{t.label}</Link>)}
        </nav>
        <div className="stack" style={{ gap: 18, minWidth: 0 }}>
          {loading ? <span className="spinner" /> : !signedIn && tab !== 'usage' && tab !== 'credits' || (!me && (tab === 'usage' || tab === 'credits')) ? (
            <div className="card stack" style={{ alignItems: 'flex-start' }}>
              <h3>Sign in to manage your account</h3>
              <p className="muted small">Connect a Solana wallet to get a daily credit grant, API keys, plans, and node earnings.</p>
              <button className="btn btn-foam" onClick={() => openSignIn()}>Sign in</button>
            </div>
          ) : (
            <>
              {tab === 'account' && <AccountTab />}
              {tab === 'plans' && <PlansTab />}
              {tab === 'credits' && <CreditsTab />}
              {tab === 'keys' && <KeysTab />}
              {tab === 'usage' && <UsageTab />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ account
function AccountTab() {
  const { me, logout } = useAuth();
  const [ref, setRef] = useState<{ code: string; referredCount: number; earnedUsd: number } | null>(null);
  useEffect(() => { api('/api/referrals').then(setRef).catch(() => {}); }, []);
  if (!me) return null;
  const u = me.user;
  const link = ref?.code ? `${location.origin}/?ref=${ref.code}` : '';

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Identity</h3>
          <button className="btn btn-ghost btn-sm" onClick={() => logout()}>Log out</button>
        </div>
        <dl className="kv">
          <dt>Name</dt><dd>{u.name ?? '—'}</dd>
          <dt>Sign-in</dt><dd><span className="badge">{u.kind === 'wallet' ? 'Solana wallet' : u.kind === 'dev' ? 'Dev login' : 'Anonymous'}</span></dd>
          {u.wallet && <><dt>Wallet</dt><dd className="mono small row" style={{ gap: 6 }}>{u.wallet} <CopyButton text={u.wallet} /></dd></>}
          <dt>Plan</dt><dd><span className="badge foam">{me.plan.id}</span>{me.plan.expiresAt ? <span className="small muted"> · renews/expires {fmtDate(me.plan.expiresAt, false)}</span> : null}</dd>
          <dt>Member since</dt><dd>{fmtDate(u.createdAt, false)}</dd>
          <dt>User ID</dt><dd className="mono tiny dim">{u.id}</dd>
        </dl>
      </div>

      <div className="card stack">
        <h3>Referrals</h3>
        <p className="small muted">Share your link. You earn 5% of what the people you refer spend on inference, paid with your node earnings in USDC.</p>
        {link ? (
          <div className="secret" style={{ borderStyle: 'solid', borderColor: 'var(--line)', color: 'var(--pearl)' }}><code>{link}</code><CopyButton text={link} label="Copy" /></div>
        ) : <span className="spinner" />}
        <div className="grid grid-2" style={{ gap: 10 }}>
          <div className="tile"><div className="v">{fmtInt(ref?.referredCount)}</div><div className="l">People referred</div></div>
          <div className="tile"><div className="v foam">{fmtUsd(ref?.earnedUsd)}</div><div className="l">Referral earnings</div></div>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ plans
function GrantMeter() {
  const { me } = useAuth();
  const g = me?.grant;
  if (!g) return null;
  const pct = g.total ? Math.min(100, (g.used / g.total) * 100) : 0;
  const hrs = Math.max(0, Math.round((g.resetsAt - Date.now()) / 3600_000));
  return (
    <div>
      <div className="row-between small"><span>Today's grant</span><span className="mono">{fmtInt(g.remaining)} / {fmtInt(g.total)} left</span></div>
      <div className="meter" style={{ marginTop: 8 }}><i style={{ width: `${100 - pct}%` }} /></div>
      <div className="progress-text"><span>{fmtInt(g.used)} used</span><span>resets in ~{hrs}h (00:00 UTC)</span></div>
    </div>
  );
}

function PlansTab() {
  const { me, pricing, devMode, refresh } = useAuth();
  const { info: deposit, reload: reloadDeposit } = useDeposit();
  const [intent, setIntent] = useState<PlanIntent | null>(null);
  const [months, setMonths] = useState<1 | 3 | 12>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const plans: PlanInfo[] = pricing?.plans ?? [];
  const canDev = devMode && !!pricing?.devCredits;
  const checkout = deposit?.enabled === true;

  const loadPlans = useCallback(async () => {
    try { setIntent((await api<{ intent: PlanIntent | null }>('/api/plans')).intent); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadPlans(); }, [loadPlans]);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key); setMsg(null);
    try { const t = await fn(); if (t) setMsg({ ok: true, text: t }); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(null); }
  };
  const activate = (plan: PlanId) => run(plan + ':dev', async () => {
    await api('/api/plans/dev-activate', { body: { plan } });
    await refresh();
    return `Activated ${plan} (test).`;
  });
  const buy = (plan: PlanId) => run(plan, async () => {
    try {
      const r = await api<{ intent: PlanIntent; releasedCredits: number }>('/api/plans/buy', { body: { plan, months } });
      setIntent(r.intent);
      reloadDeposit();
      return r.releasedCredits ? `A previous purchase was replaced — ${r.releasedCredits} credits returned to your balance.` : undefined;
    } catch (e) {
      if (e instanceof ApiError && e.status === 503 && canDev) {
        await api('/api/plans/dev-activate', { body: { plan } });
        await refresh();
        return `Checkout is not configured — activated ${plan} (test) instead.`;
      }
      throw e;
    }
  });
  const cancel = () => run('cancel', async () => {
    const r = await api<{ releasedCredits: number }>('/api/plans/cancel', { body: {} });
    setIntent(null);
    await refresh();
    return r.releasedCredits ? `Purchase cancelled — ${r.releasedCredits} credits added to your balance for what you already sent.` : 'Purchase cancelled.';
  });

  return (
    <>
      <div className="card stack">
        <div className="row-between">
          <div>
            <h3>Current plan: <span className="foam">{plans.find((p) => p.id === me?.plan.id)?.name ?? me?.plan.id}</span></h3>
            <p className="small muted">{me?.plan.expiresAt ? `Active until ${fmtDate(me.plan.expiresAt, false)}` : 'Free forever. Upgrade any time.'}</p>
          </div>
          <Link to="/pricing" className="link small">Compare plans →</Link>
        </div>
        <GrantMeter />
      </div>

      {intent && deposit?.enabled && (
        <div className="card glow stack">
          <div className="row-between">
            <h3>Finish your {intent.plan === 'max' ? 'Max' : 'Pro'} purchase</h3>
            <span className="tiny dim">expires {fmtDate(intent.expires_at)}</span>
          </div>
          <div>
            <div className="row-between small">
              <span>Send <b className="foam mono">${Math.max(0, intent.expected_usd - intent.paid_usd).toFixed(2)} USDC</b> for {intent.months} month{intent.months === 1 ? '' : 's'}</span>
              <span className="mono">{fmtUsd(intent.paid_usd)} / {fmtUsd(intent.expected_usd)}</span>
            </div>
            <div className="meter" style={{ marginTop: 8 }}><i style={{ width: `${Math.min(100, (intent.paid_usd / intent.expected_usd) * 100)}%` }} /></div>
          </div>
          <DepositBox address={deposit.address} cluster={deposit.cluster} mint={deposit.mint} cta="Check payment"
            onChecked={() => { loadPlans(); refresh(); }} />
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={cancel} disabled={!!busy}>Cancel purchase</button>
        </div>
      )}

      <div className="row-between">
        <div className="seg" role="radiogroup" aria-label="Billing period">
          {([1, 3, 12] as const).map((m) => (
            <button key={m} role="radio" aria-checked={months === m} className={months === m ? 'active' : ''} onClick={() => setMonths(m)}>{m === 1 ? '1 month' : `${m} months`}</button>
          ))}
        </div>
        <span className="tiny dim">{deposit?.enabled ? `Paid in USDC on Solana ${clusterLabel(deposit.cluster)}` : 'USDC checkout coming soon'}</span>
      </div>

      <div className="plans">
        {plans.map((p) => (
          <div key={p.id} className={`card plan${me?.plan.id === p.id ? ' glow' : ''}`}>
            <div className="row-between"><span className="eyebrow">{p.name}</span>{me?.plan.id === p.id && <span className="badge sky">current</span>}</div>
            <div className="price" style={{ fontSize: 34 }}>${p.priceUsd * (p.id === 'free' ? 1 : months)}<small> / {months === 1 || p.id === 'free' ? 'mo' : `${months} mo`}</small></div>
            <div className="mono small"><span className="foam">{fmtInt(p.dailyCredits)}</span> <span className="muted">credits / day</span></div>
            <div style={{ flex: 1 }} />
            {p.id === 'free' ? (
              canDev && me?.plan.id !== 'free'
                ? <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => activate('free')}>Switch to Free (test)</button>
                : <span className="tiny dim">Included</span>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {checkout ? (
                  <button className="btn btn-foam btn-sm" disabled={!!busy} onClick={() => buy(p.id)}>
                    {busy === p.id ? <span className="spinner" /> : me?.plan.id === p.id ? 'Extend with USDC' : 'Buy with USDC'}
                  </button>
                ) : !canDev && <button className="btn btn-ghost btn-sm" disabled>USDC checkout coming soon</button>}
                {canDev && (
                  <button className={`btn ${checkout ? 'btn-ghost btn-xs' : 'btn-foam btn-sm'}`} disabled={!!busy} onClick={() => activate(p.id)}>
                    {busy === p.id + ':dev' ? <span className="spinner" /> : me?.plan.id === p.id ? 'Extend 30 days (test)' : 'Activate (test)'}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {canDev && <div className="notice">Dev build: “(test)” buttons activate plans instantly for 30 days without payment.</div>}
      {msg && <div className={`notice ${msg.ok ? 'foam' : 'danger'}`}>{msg.text}</div>}
    </>
  );
}

// ------------------------------------------------------------------ credits
interface CreditTx { delta: number; reason: string; ref: string | null; created_at: number }
const REASONS: Record<string, string> = {
  dev: 'Test credits', job_hold: 'Job hold', job_refund: 'Job refund', purchase: 'Purchase', deposit: 'USDC deposit', plan_release: 'Plan purchase refund',
};

function CreditsTab() {
  const { me, pricing, devMode, refresh, signedIn } = useAuth();
  const { info: deposit } = useDeposit(signedIn);
  const [data, setData] = useState<{ balance: number; transactions: CreditTx[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api('/api/credits?tx=50').then(setData).catch((e) => setError(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    setBusy(true); setError(null);
    try { await api('/api/credits/dev-add', { body: { amount: 1000 } }); await Promise.all([load(), refresh()]); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const perUsd = (deposit?.enabled ? deposit.creditsPerUsd : undefined) ?? pricing?.creditsPerUsdPurchased ?? 500;

  return (
    <>
      <div className="grid grid-2">
        <div className="card stack">
          <h3>Credit balance</h3>
          <div className="mono" style={{ fontSize: 40, fontWeight: 600, lineHeight: 1 }}>{fmtInt(data?.balance ?? me?.credits)}</div>
          <div className="small muted">≈ {fmtUsd((data?.balance ?? me?.credits ?? 0) / 1000)} of inference · never expires</div>
          {devMode && pricing?.devCredits && signedIn && (
            <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={add} disabled={busy}>{busy ? <span className="spinner" /> : 'Add 1,000 test credits'}</button>
          )}
          {error && <div className="notice danger">{error}</div>}
          <GrantMeter />
        </div>
        <div className="card stack">
          <h3>Buy credits with USDC</h3>
          <p className="small muted">$1 buys {fmtInt(perUsd)} credits pay-as-you-go. Plans are the cheaper path if you chat daily.</p>
          {!signedIn ? (
            <div className="tiny dim">Sign in with a wallet to get a deposit address.</div>
          ) : deposit?.enabled ? (
            <>
              {deposit.intent && <div className="notice foam tiny">Deposits go toward your open {deposit.intent.plan} purchase first — see <Link className="link" to={{ hash: 'plans' }}>Plans</Link>.</div>}
              <DepositBox address={deposit.address} cluster={deposit.cluster} mint={deposit.mint} onChecked={() => { load(); refresh(); }} />
            </>
          ) : deposit ? (
            <div className="tiny dim">USDC checkout on Solana is coming soon.</div>
          ) : <span className="spinner" />}
        </div>
      </div>
      <div className="card">
        <h3>Transactions</h3>
        {data?.transactions.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead><tr><th>When</th><th>Type</th><th>Reference</th><th className="num">Credits</th></tr></thead>
              <tbody>
                {data.transactions.map((t, i) => (
                  <tr key={i}>
                    <td>{fmtDate(t.created_at)}</td>
                    <td>{REASONS[t.reason] ?? t.reason}</td>
                    <td className="mono tiny dim">{t.ref ? t.ref.slice(0, 16) : '—'}</td>
                    <td className={`num ${t.delta >= 0 ? 'foam' : ''}`}>{t.delta >= 0 ? '+' : ''}{fmtInt(t.delta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">No transactions yet. Free prompts and daily grants do not show up here.</div>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ API keys
interface ApiKey { id: string; name: string | null; prefix: string; created_at: number; last_used_at: number | null }

function KeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ keys: ApiKey[] }>('/api/api-keys').then((r) => setKeys(r.keys)).catch((e) => setError(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      const r = await api<{ key: string }>('/api/api-keys', { body: { name: name.trim() || undefined } });
      setFresh(r.key); setName(''); load();
    } catch (err) { setError(errMsg(err)); }
  };
  const revoke = async (id: string) => {
    if (!confirm('Revoke this API key? Apps using it will stop working.')) return;
    try { await api(`/api/api-keys/${id}`, { method: 'DELETE' }); load(); } catch (err) { setError(errMsg(err)); }
  };

  const base = `${location.origin}/v1`;
  const key = fresh ?? 'sk-tide-...';
  const curl = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "tide-max", "stream": true,
       "messages": [{"role": "user", "content": "Hello!"}]}'`;
  const py = `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="${key}")

stream = client.chat.completions.create(
    model="tide-max",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`;

  return (
    <>
      <div className="card stack">
        <h3>API keys</h3>
        <p className="small muted">Keys start with <code>sk-tide-</code> and work with any OpenAI-compatible client. Up to 5 active keys.</p>
        <form className="row" onSubmit={create} style={{ flexWrap: 'nowrap' }}>
          <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. my-app" maxLength={40} />
          <button className="btn btn-foam btn-sm">Create key</button>
        </form>
        {fresh && <SecretBox value={fresh} />}
        {error && <div className="notice danger">{error}</div>}
        {keys.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name ?? 'unnamed'}</td>
                    <td className="mono small">{k.prefix}…</td>
                    <td className="small">{fmtDate(k.created_at, false)}</td>
                    <td className="small">{k.last_used_at ? timeAgo(k.last_used_at) : 'never'}</td>
                    <td className="num"><button className="icon-btn" onClick={() => revoke(k.id)} aria-label="Revoke key" title="Revoke"><IconTrash /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">No API keys yet.</div>}
      </div>
      <div className="card stack">
        <h3>Quick start</h3>
        <p className="small muted">Base URL <code>{base}</code> · full reference in the <Link className="link" to="/docs">API docs</Link>.</p>
        <CodeBlock code={curl} />
        <CodeBlock code={py} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ usage
interface UsageData {
  byModel: { model: string; requests: number; input_tokens: number; output_tokens: number; credits: number }[];
  daily: { day: string; requests: number; credits: number }[];
}

function UsageTab() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<UsageData>('/api/usage').then(setData).catch((e) => setError(errMsg(e))); }, []);

  const totals = useMemo(() => (data?.byModel ?? []).reduce(
    (a, m) => ({ requests: a.requests + m.requests, tokens: a.tokens + (m.input_tokens ?? 0) + (m.output_tokens ?? 0), credits: a.credits + (m.credits ?? 0) }),
    { requests: 0, tokens: 0, credits: 0 },
  ), [data]);

  return (
    <>
      {error && <div className="notice danger">{error}</div>}
      <div className="grid grid-3">
        <div className="tile"><div className="v">{fmtInt(totals.requests)}</div><div className="l">Requests</div></div>
        <div className="tile"><div className="v">{fmtInt(totals.tokens)}</div><div className="l">Tokens</div></div>
        <div className="tile"><div className="v foam">{fmtInt(totals.credits)}</div><div className="l">Credits spent</div></div>
      </div>
      <div className="card">
        <h3>Activity</h3>
        <p className="small muted" style={{ marginBottom: 14 }}>Requests per day over the last year (UTC).</p>
        <ActivityGrid daily={data?.daily ?? []} />
      </div>
      <div className="card">
        <h3>By model</h3>
        {data?.byModel.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead><tr><th>Model</th><th className="num">Requests</th><th className="num">Input tok</th><th className="num">Output tok</th><th className="num">Credits</th></tr></thead>
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={m.model}>
                    <td className="mono">{m.model}</td>
                    <td className="num">{fmtInt(m.requests)}</td>
                    <td className="num">{fmtInt(m.input_tokens)}</td>
                    <td className="num">{fmtInt(m.output_tokens)}</td>
                    <td className="num foam">{fmtInt(m.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">No usage yet — <Link className="link" to="/chat">start a chat</Link>.</div>}
      </div>
    </>
  );
}

function ActivityGrid({ daily }: { daily: UsageData['daily'] }) {
  const cells = useMemo(() => {
    const byDay = new Map(daily.map((d) => [d.day, d.requests]));
    const max = Math.max(1, ...daily.map((d) => d.requests));
    const today = new Date();
    const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    let start = end - 364 * 86_400_000;
    start -= new Date(start).getUTCDay() * 86_400_000; // align to Sunday
    const out: { key: string; n: number; level: number; out: boolean }[] = [];
    for (let t = start; t <= end; t += 86_400_000) {
      const key = new Date(t).toISOString().slice(0, 10);
      const n = byDay.get(key) ?? 0;
      const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
      out.push({ key, n, level, out: t < end - 364 * 86_400_000 });
    }
    return out;
  }, [daily]);

  return (
    <>
      <div className="heat-wrap">
        <div className="heat" role="img" aria-label="Daily activity over the last year">
          {cells.map((c) => <i key={c.key} className={c.out ? 'out' : c.level ? `l${c.level}` : ''} title={`${c.key}: ${c.n} request${c.n === 1 ? '' : 's'}`} />)}
        </div>
      </div>
      <div className="heat-legend">
        Less <i style={{ background: 'rgba(28,50,99,.45)' }} /><i style={{ background: 'rgba(61,255,194,.22)' }} /><i style={{ background: 'rgba(61,255,194,.45)' }} /><i style={{ background: 'rgba(61,255,194,.7)' }} /><i style={{ background: 'var(--foam)' }} /> More
      </div>
    </>
  );
}
