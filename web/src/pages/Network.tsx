import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useNetworkStats, useSocketConnected } from '../lib/socket';
import { fmtCompact, fmtInt, fmtUsd, shortAddr } from '../lib/format';
import { Sea } from '../components/Sea';
import { Footer } from '../components/Nav';

export interface Treasury {
  paidToNodes: number;
  paidToReferrers: number;
  protocolRevenue: number;
}

interface SwarmView {
  candidates: { nodeId: string; model: string; gpu?: string; vramGb: number; ring: string | null }[];
  rings: { swarmId: string; model: string; status: string; busy: boolean; tokS?: number; stages: { nodeId: string; lo: number; hi: number; head: boolean }[] }[];
}

function Swarms({ v }: { v: SwarmView | null }) {
  const pool = v?.candidates.filter((c) => !c.ring).length ?? 0;
  return (
    <div className="card" style={{ marginTop: 18 }} id="swarms">
      <div className="row-between">
        <div>
          <h3>Swarms</h3>
          <p className="small muted">Current splits one large model across several GPUs — each ring below holds a full copy, layer by layer.</p>
        </div>
        <span className="mono tiny muted">{v ? `${v.rings.length} ring${v.rings.length === 1 ? '' : 's'} · ${pool} in pool` : '…'}</span>
      </div>
      {!v || v.rings.length === 0 ? (
        <div className="empty small muted">No swarm is running yet. It takes several GPUs with enough combined VRAM — <Link className="link" to="/docs#nodes">join the pool →</Link></div>
      ) : v.rings.map((r) => {
        const total = Math.max(...r.stages.map((s) => s.hi));
        return (
          <div key={r.swarmId} style={{ marginTop: 14 }}>
            <div className="row-between small" style={{ marginBottom: 6 }}>
              <span><span className="mono">{r.swarmId}</span> · {r.model}</span>
              <span className="row" style={{ gap: 6 }}>
                <span className={`badge ${r.status === 'ready' ? 'foam' : 'warn'}`}>{r.busy ? 'serving' : r.status}</span>
                {r.tokS ? <span className="mono tiny dim">~{r.tokS} tok/s</span> : null}
              </span>
            </div>
            <div className="ring-bar">
              {r.stages.map((s) => (
                <div key={s.nodeId} className={`ring-seg${s.head ? ' head' : ''}`} style={{ flex: s.hi - s.lo }} title={`${s.nodeId}: layers ${s.lo}–${s.hi - 1}`}>
                  <span className="mono tiny">{s.lo}–{s.hi - 1}</span>
                </div>
              ))}
            </div>
            <div className="mono tiny dim" style={{ marginTop: 4 }}>{r.stages.length} stages · {total} layers · head runs the coordinator</div>
          </div>
        );
      })}
    </div>
  );
}

export default function Network() {
  const stats = useNetworkStats();
  const connected = useSocketConnected();
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [swarm, setSwarm] = useState<SwarmView | null>(null);

  useEffect(() => {
    const load = () => api<SwarmView>('/api/swarm', { token: null }).then(setSwarm).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

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

        <Swarms v={swarm} />

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

          <div className="card" id="economics">
            <div className="card-head">
              <div>
                <h3>Payouts</h3>
                <p className="small muted">Every paid token splits 70% to the node that served it, 5% to the referrer, and the rest to Tide.</p>
              </div>
            </div>
            <div className="grid grid-2" style={{ gap: 10 }}>
              <div className="tile"><div className="v foam">{fmtUsd(treasury?.paidToNodes, 4)}</div><div className="l">Earned by nodes</div></div>
              <div className="tile"><div className="v">{fmtUsd(treasury?.paidToReferrers, 4)}</div><div className="l">Earned by referrers</div></div>
            </div>
            <div className="row-between small muted" style={{ marginTop: 14 }}>
              <span>Withdrawals in USDC from $1.</span>
              <Link className="link" to="/earn">Start earning →</Link>
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
