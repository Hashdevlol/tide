import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useNetworkStats, useSocketConnected } from '../lib/socket';
import { fmtCompact, fmtInt, fmtUsd, shortAddr } from '../lib/format';
import { Sea } from '../components/Sea';
import { Footer } from '../components/Nav';

export interface Treasury {
  launched: boolean;
  tokenMint: string | null;
  pendingBuyback: number;
  pendingStakerRewards: number;
  paidToNodes: number;
  totalStaked?: number;
  tideBurned?: number;
  buybackSpentUsd?: number;
  stakerRewardsPaidUsd?: number;
}

export default function Network() {
  const stats = useNetworkStats();
  const connected = useSocketConnected();
  const [treasury, setTreasury] = useState<Treasury | null>(null);

  useEffect(() => {
    const load = () => api<Treasury>('/api/treasury', { token: null }).then(setTreasury).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const busyPct = stats && stats.nodesOnline ? stats.busy / stats.nodesOnline : 0;
  const models = stats ? Object.entries(stats.byModel).sort((a, b) => b[1] - a[1]) : [];
  const maxModel = Math.max(1, ...models.map(([, n]) => n));

  return (
    <>
      <div className="page wrap">
        <div className="page-head">
          <div className="eyebrow">// network</div>
          <h1>The tide, <em>live</em>.</h1>
          <p>Every node, job and token flowing through Tide right now. Updates every few seconds from the orchestrator.</p>
        </div>

        <div className="net-hero">
          <Sea activity={0.1 + busyPct * 0.9} className="sea" horizon={0.3} />
          <div className="overlay">
            <div className="row" style={{ gap: 8, marginBottom: 10 }}>
              <span className={`dot${connected ? '' : ' off'}`} />
              <span className="mono tiny muted">{connected ? 'LIVE' : 'RECONNECTING'}</span>
            </div>
            <div className="v">{stats ? fmtInt(stats.nodesOnline) : '—'}</div>
            <div className="muted small">nodes online</div>
          </div>
        </div>

        <div className="grid grid-4">
          <div className="tile"><div className="v">{fmtInt(stats?.browserNodes)}</div><div className="l">Browser nodes</div><div className="s">WebGPU tabs</div></div>
          <div className="tile"><div className="v">{fmtInt(stats?.nativeNodes)}</div><div className="l">Native nodes</div><div className="s">GPU machines</div></div>
          <div className="tile"><div className="v sky">{fmtInt(stats?.busy)}</div><div className="l">Busy now</div><div className="s">{Math.round(busyPct * 100)}% utilization</div></div>
          <div className="tile"><div className="v">{fmtInt(stats?.queueDepth)}</div><div className="l">In queue</div><div className="s">waiting for a node</div></div>
          <div className="tile"><div className="v foam">{fmtCompact(stats?.jobsCompleted)}</div><div className="l">Jobs completed</div></div>
          <div className="tile"><div className="v">{fmtCompact(stats?.tokensGenerated)}</div><div className="l">Tokens generated</div></div>
          <div className="tile"><div className="v">{stats ? stats.avgTokPerSec.toFixed(1) : '—'}</div><div className="l">Avg tok/s</div><div className="s">per node, measured</div></div>
          <div className="tile"><div className="v">0</div><div className="l">Prompts stored</div><div className="s">never persisted</div></div>
        </div>

        <div className="grid grid-2" style={{ marginTop: 18 }}>
          <div className="card">
            <h3>Nodes by model</h3>
            <p className="small muted" style={{ marginBottom: 10 }}>Which public models the online nodes are serving.</p>
            {models.length ? models.map(([m, n]) => (
              <div className="bar-row" key={m}>
                <span className="mono small">{m}</span>
                <div className="meter"><i style={{ width: `${(n / maxModel) * 100}%` }} /></div>
                <span className="mono small" style={{ textAlign: 'right' }}>{n}</span>
              </div>
            )) : <div className="empty">No nodes online. <Link className="link" to="/earn">Be the first →</Link></div>}
          </div>

          <div className="card" id="treasury">
            <div className="card-head">
              <div>
                <h3>Treasury</h3>
                <p className="small muted">Protocol margin splits 50/50 into $TIDE buybacks (burned) and staker rewards.</p>
              </div>
              <span className={`badge ${treasury?.launched ? 'foam' : ''}`}>{treasury?.launched ? '$TIDE live' : '$TIDE pre-launch'}</span>
            </div>
            <div className="grid grid-2" style={{ gap: 10 }}>
              <div className="tile"><div className="v foam">{fmtUsd(treasury?.paidToNodes)}</div><div className="l">Paid to nodes</div></div>
              <div className="tile"><div className="v">{fmtUsd(treasury?.pendingBuyback)}</div><div className="l">Pending buyback</div></div>
              <div className="tile"><div className="v">{fmtUsd(treasury?.pendingStakerRewards)}</div><div className="l">Pending staker rewards</div></div>
              <div className="tile"><div className="v">{fmtUsd(treasury?.stakerRewardsPaidUsd)}</div><div className="l">Rewards paid</div></div>
              <div className="tile"><div className="v">{fmtUsd(treasury?.buybackSpentUsd)}</div><div className="l">Spent on buybacks</div></div>
              <div className="tile"><div className="v">{fmtCompact(treasury?.tideBurned)}</div><div className="l">$TIDE burned</div></div>
            </div>
            <div className="row-between small muted" style={{ marginTop: 14 }}>
              <span>Total staked: <b className="mono" style={{ color: 'var(--pearl)' }}>{fmtCompact(treasury?.totalStaked)} $TIDE</b></span>
              {treasury?.tokenMint
                ? <span className="mono tiny">mint {shortAddr(treasury.tokenMint)}</span>
                : <Link className="link" to="/staking">How staking works →</Link>}
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 18 }}>
          <div className="row-between">
            <div>
              <h3>Add your GPU to the tide</h3>
              <p className="small muted">Run a browser node in one click, or a native node with Ollama, llama.cpp or vLLM.</p>
            </div>
            <div className="row">
              <Link to="/earn" className="btn btn-foam">Start earning</Link>
              <Link to="/docs#nodes" className="btn btn-ghost">Node docs</Link>
            </div>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
