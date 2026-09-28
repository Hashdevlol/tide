import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { NODE_SHARE, NODE_SHARE_STAKED } from '@tide/shared';
import { useAuth } from '../lib/auth';
import { api, errMsg } from '../lib/api';
import { explorerAddr, explorerTx } from '../lib/solana';
import { fmtCompact, fmtDate, fmtInt, fmtUsd, shortAddr } from '../lib/format';
import { CopyButton } from '../components/CopyButton';
import { Footer } from '../components/Nav';
import type { Treasury } from './Network';

type StakingInfo =
  | { enabled: false; threshold: number }
  | {
    enabled: true; stale: boolean; mint: string; address: string; total: number; matured: number; nextMaturity: number | null;
    rewards: { claimable: number; claimed: number }; boost: boolean; threshold: number; minAgeHours: number;
  };

const STEPS = [
  ['01 · STAKE', 'Send $TIDE to your staking address', 'Every account gets its own staking address. Tokens sent there count as your stake — no lockup, no contracts to approve.'],
  ['02 · MATURE', 'Wait 24 hours', 'Stake counts once it has been held for 24h, so nobody can flash-stake around a reward distribution.'],
  ['03 · EARN', 'Collect USDC rewards', 'Half of every protocol buyback pool streams to stakers pro-rata, paid in USDC. Claim any time from $1.'],
  ['04 · BOOST', 'Serve at 80%', `Node operators with ≥500k matured $TIDE earn ${Math.round(NODE_SHARE_STAKED * 100)}% of what users pay instead of ${Math.round(NODE_SHARE * 100)}%.`],
];

export default function Staking() {
  const { signedIn, openSignIn, me } = useAuth();
  const [info, setInfo] = useState<StakingInfo | null>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setInfo(await api<StakingInfo>('/api/staking')); setError(null); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { if (signedIn) load(); else setInfo(null); }, [signedIn, load]);
  useEffect(() => { api<Treasury>('/api/treasury', { token: null }).then(setTreasury).catch(() => {}); }, []);

  const live = info?.enabled ?? treasury?.launched ?? false;

  return (
    <>
      <div className="page wrap">
        <div className="page-head">
          <div className="eyebrow">// $TIDE staking</div>
          <h1>Stake $TIDE, <em>earn the flow</em>.</h1>
          <p>Protocol revenue buys back $TIDE: half is burned, half flows to stakers as USDC. No lockup — unstake whenever you like.</p>
        </div>

        {!live && (
          <div className="notice foam" style={{ marginBottom: 24 }}>
            <span><b>$TIDE launches soon.</b> Staking opens at launch — until then the treasury accrues the buyback and staker-reward pools you can see below.</span>
          </div>
        )}

        <div className="grid grid-4">
          <div className="tile"><div className="v">{fmtCompact(treasury?.totalStaked)}</div><div className="l">$TIDE staked</div></div>
          <div className="tile"><div className="v foam">{fmtUsd(treasury?.pendingStakerRewards)}</div><div className="l">Pending staker rewards</div></div>
          <div className="tile"><div className="v">{fmtUsd(treasury?.stakerRewardsPaidUsd)}</div><div className="l">Rewards paid</div></div>
          <div className="tile"><div className="v">{fmtCompact(treasury?.tideBurned)}</div><div className="l">$TIDE burned</div></div>
        </div>

        <div style={{ marginTop: 24 }}>
          {!signedIn ? (
            <div className="card row-between">
              <div>
                <h3>Your stake</h3>
                <p className="small muted">Sign in with your Solana wallet to get a staking address and track rewards.</p>
              </div>
              <button className="btn btn-foam" onClick={() => openSignIn('Sign in to stake $TIDE and earn USDC rewards.')}>Sign in</button>
            </div>
          ) : error ? (
            <div className="notice danger">{error}</div>
          ) : !info ? (
            <span className="spinner" />
          ) : info.enabled ? (
            <StakePanel info={info} wallet={me?.user.wallet ?? null} reload={load} />
          ) : (
            <div className="card">
              <h3>Your stake</h3>
              <p className="small muted">Staking is not live on this server yet. When it is, you'll get a personal staking address here. Stake ≥{fmtInt(info.threshold)} $TIDE to unlock the {Math.round(NODE_SHARE_STAKED * 100)}% node share.</p>
            </div>
          )}
        </div>

        <h2 className="section-title">How it works</h2>
        <div className="flow" style={{ marginTop: 0 }}>
          {STEPS.map(([n, h, p]) => <div className="step" key={n}><div className="n">{n}</div><h4>{h}</h4><p>{p}</p></div>)}
        </div>

        <div className="token" style={{ marginTop: 24 }}>
          <div>
            <div className="eyebrow">// where the money goes</div>
            <h2 style={{ fontSize: 'clamp(28px,3.4vw,40px)', letterSpacing: '-.03em', margin: '12px 0' }}>Usage in. Value out.</h2>
            <p className="sub">Nodes take {Math.round(NODE_SHARE * 100)}% of every paid token. Protocol margin is split between buybacks and stakers.</p>
          </div>
          <div>
            <div className="split-bar"><div className="burn">50% BURN</div><div className="stake">50% STAKERS</div></div>
            <div className="legend">
              <div><b>Ebb — burned</b>{fmtUsd(treasury?.buybackSpentUsd)} spent buying back $TIDE so far.</div>
              <div><b>Flow — staked</b>{fmtUsd(treasury?.pendingStakerRewards)} waiting to stream to stakers.</div>
            </div>
            {treasury?.tokenMint && <p className="tiny dim mono" style={{ marginTop: 14 }}>mint {treasury.tokenMint}</p>}
            <p className="small" style={{ marginTop: 14 }}><Link className="link" to="/network#treasury">Full treasury on the Network page →</Link></p>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}

function StakePanel({ info, wallet, reload }: { info: Extract<StakingInfo, { enabled: true }>; wallet: string | null; reload(): void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const pct = Math.min(100, (info.matured / info.threshold) * 100);

  const run = async (key: string, fn: () => Promise<{ text: string; url?: string; ok?: boolean }>) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); setMsg({ ok: r.ok ?? true, text: r.text, url: r.url }); reload(); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(null); }
  };
  const unstake = (all: boolean) => run(all ? 'all' : 'part', async () => {
    const r = await api<{ tx: string; url?: string }>('/api/staking/unstake', { body: { amount: all ? 'all' : Number(amount) } });
    setAmount('');
    return { text: 'Unstaked — $TIDE is on its way to your wallet.', url: r.url ?? explorerTx(r.tx) };
  });
  const claim = () => run('claim', async () => {
    const r = await api<{ status: string; usd: number; tx?: string }>('/api/staking/claim', { body: {} });
    return r.status === 'completed'
      ? { text: `Claimed ${fmtUsd(r.usd)} USDC.`, url: r.tx ? explorerTx(r.tx) : undefined }
      : { ok: false, text: `Claim of ${fmtUsd(r.usd)} could not be confirmed — an operator will review it.` };
  });

  return (
    <div className="stack" style={{ gap: 18 }}>
      {info.stale && <div className="notice warn">Could not refresh your on-chain balance just now — showing the last known stake.</div>}
      <div className="grid grid-2">
        <div className="card stack">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h3>Your stake</h3>
            {info.boost ? <span className="badge foam">{Math.round(NODE_SHARE_STAKED * 100)}% node share</span> : <span className="badge">{Math.round(NODE_SHARE * 100)}% node share</span>}
          </div>
          <div className="row" style={{ gap: 28 }}>
            <div><div className="mono" style={{ fontSize: 30, fontWeight: 600 }}>{fmtInt(info.total)}</div><div className="tiny muted">$TIDE staked</div></div>
            <div><div className="mono foam" style={{ fontSize: 30, fontWeight: 600 }}>{fmtInt(info.matured)}</div><div className="tiny muted">matured</div></div>
          </div>
          {info.nextMaturity && info.total > info.matured && <div className="small muted">Next stake matures {fmtDate(info.nextMaturity)} ({info.minAgeHours}h holding period).</div>}
          <div>
            <div className="row-between tiny muted"><span>Toward the {fmtCompact(info.threshold)} node boost</span><span className="mono">{pct.toFixed(0)}%</span></div>
            <div className="meter" style={{ marginTop: 6 }}><i style={{ width: `${pct}%` }} /></div>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>To stake, send $TIDE to your staking address:</div>
          <div className="secret" style={{ borderStyle: 'solid' }}><code>{info.address}</code><CopyButton text={info.address} label="Copy" /></div>
          <div className="tiny dim"><a className="link" href={explorerAddr(info.address)} target="_blank" rel="noreferrer">View on explorer</a> · mint {shortAddr(info.mint)}</div>
        </div>

        <div className="card stack">
          <h3>Rewards</h3>
          <div className="row" style={{ gap: 28 }}>
            <div><div className="mono foam" style={{ fontSize: 30, fontWeight: 600 }}>{fmtUsd(info.rewards.claimable)}</div><div className="tiny muted">claimable USDC</div></div>
            <div><div className="mono" style={{ fontSize: 30, fontWeight: 600 }}>{fmtUsd(info.rewards.claimed)}</div><div className="tiny muted">claimed</div></div>
          </div>
          <button className="btn btn-foam btn-sm" style={{ alignSelf: 'flex-start' }} onClick={claim} disabled={!!busy || info.rewards.claimable < 1 || !wallet}>
            {busy === 'claim' ? <span className="spinner" /> : 'Claim to my wallet'}
          </button>
          {info.rewards.claimable < 1 && <div className="tiny dim">Minimum claim is $1.00.</div>}

          <div className="divider">UNSTAKE</div>
          {!wallet ? (
            <div className="tiny dim">Sign in with a Solana wallet to unstake — tokens are returned to that wallet.</div>
          ) : (
            <>
              <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); unstake(false); }}>
                <input className="input mono grow" type="number" min={1} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount ($TIDE)" />
                <button className="btn btn-ghost btn-sm" disabled={!!busy || !amount}>{busy === 'part' ? <span className="spinner" /> : 'Unstake'}</button>
              </form>
              <div className="row-between tiny dim">
                <span>Minimum 1,000 $TIDE unless withdrawing everything. Sent to {shortAddr(wallet)}.</span>
                <button className="link" onClick={() => unstake(true)} disabled={!!busy || info.total <= 0}>Unstake all</button>
              </div>
            </>
          )}
        </div>
      </div>
      {msg && <div className={`notice ${msg.ok ? 'foam' : 'danger'}`}><span>{msg.text} {msg.url && <a className="link" href={msg.url} target="_blank" rel="noreferrer">View transaction →</a>}</span></div>}
    </div>
  );
}
