import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { NODE_SHARE, NODE_SHARE_STAKED } from '@tide/shared';
import { useAuth } from '../lib/auth';
import { api, errMsg } from '../lib/api';
import { useNodeStatus } from '../lib/socket';
import { duration, fmtDate, fmtInt, fmtUsd, timeAgo } from '../lib/format';
import {
  BROWSER_MODELS, startBrowserNode, stopBrowserNode, useBrowserNode, webgpuSupported, type ModelPref,
} from '../earn/browserNode';
import { EarningsPanel, useEarnings, type EarningsData } from '../earn/Earnings';
import { CodeBlock, SecretBox } from '../components/CopyButton';
import { Footer } from '../components/Nav';
import { IconTrash } from '../components/Icons';

type Tab = 'browser' | 'machine';

export default function Earn() {
  const { signedIn, me, openSignIn, loading } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const tab: Tab = loc.hash === '#machine' ? 'machine' : 'browser';
  const setTab = (t: Tab) => nav({ hash: t === 'machine' ? 'machine' : 'browser' }, { replace: true });
  const earnings = useEarnings(signedIn);

  return (
    <>
      <div className="page wrap">
        <div className="page-head">
          <div className="eyebrow">// earn</div>
          <h1>Put your GPU in the <em>current</em>.</h1>
          <p>Serve open models to the network and earn USDC for every token. Nodes earn <b className="foam">{Math.round(NODE_SHARE * 100)}%</b> of what users pay — <b className="foam">{Math.round(NODE_SHARE_STAKED * 100)}%</b> with ≥500k $TIDE staked.</p>
        </div>

        {!signedIn && !loading && (
          <div className="notice foam" style={{ marginBottom: 24 }}>
            <span className="grow">Sign in with a Solana wallet to run a node — earnings are tied to your account and paid out in USDC.</span>
            <button className="btn btn-foam btn-sm" onClick={() => openSignIn('Sign in to run a node and get paid for the tokens you serve.')}>Sign in</button>
          </div>
        )}

        <div className="seg" role="tablist" style={{ marginBottom: 24 }}>
          <button role="tab" aria-selected={tab === 'browser'} className={tab === 'browser' ? 'active' : ''} onClick={() => setTab('browser')}>In this browser</button>
          <button role="tab" aria-selected={tab === 'machine'} className={tab === 'machine' ? 'active' : ''} onClick={() => setTab('machine')}>On my machine</button>
        </div>

        {tab === 'browser' ? <BrowserTab signedIn={signedIn} earnings={earnings.data} /> : <MachineTab signedIn={signedIn} />}

        {signedIn && (
          <div style={{ marginTop: 48 }}>
            <EarningsPanel data={earnings.data} error={earnings.error} reload={earnings.reload} />
          </div>
        )}
        {signedIn && me && (
          <p className="small muted" style={{ marginTop: 24 }}>
            Also earn 5% of what the people you refer spend — <Link className="link" to="/settings#account">get your referral link</Link>.
          </p>
        )}
      </div>
      <Footer />
    </>
  );
}

const PHASE_LABEL: Record<string, string> = {
  idle: 'Offline', checking: 'Checking your GPU…', loading: 'Downloading model…', benchmarking: 'Benchmarking…',
  registering: 'Joining the network…', online: 'Online', reconnecting: 'Reconnecting…', stopping: 'Stopping…', error: 'Stopped',
};

function BrowserTab({ signedIn, earnings }: { signedIn: boolean; earnings: EarningsData | null }) {
  const node = useBrowserNode();
  const { openSignIn } = useAuth();
  const [pref, setPref] = useState<ModelPref>('auto');
  const [, tick] = useState(0);
  useEffect(() => {
    if (node.phase !== 'online') return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [node.phase]);

  const supported = webgpuSupported();
  const running = !['idle', 'error'].includes(node.phase);
  const online = node.phase === 'online';
  const modelInfo = BROWSER_MODELS.find((m) => m.id === node.model);

  const start = () => {
    if (!signedIn) return openSignIn('Sign in to run a browser node and get paid for the tokens you serve.');
    void startBrowserNode(pref);
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="node-hero">
        <div className={`card${online ? ' glow' : ''}`}>
          <div className="card-head">
            <div className="node-state">
              <span className={`dot${online ? (node.busy ? ' busy' : '') : node.phase === 'error' ? ' warn' : running ? ' busy' : ' off'}`} />
              <div>
                <div className="big">{PHASE_LABEL[node.phase]}{online && node.busy ? ' · serving a job' : ''}</div>
                <div className="small muted mono">
                  {node.model ? `${modelInfo?.label ?? node.model} · Tide Lite` : 'Tide Lite · Qwen3 over WebGPU'}
                  {node.nodeId ? ` · ${node.nodeId}` : ''}
                </div>
              </div>
            </div>
            {running ? (
              <button className="btn btn-ghost" onClick={() => stopBrowserNode()} disabled={node.phase === 'stopping'}>Stop node</button>
            ) : (
              <button className="btn btn-foam" onClick={start} disabled={!supported}>Start earning</button>
            )}
          </div>

          {!supported && (
            <div className="notice warn">WebGPU isn't available in this browser. Use a recent Chrome or Edge on desktop (or Safari 26+), or run a node <Link className="link" to="/earn#machine">on your machine</Link>.</div>
          )}

          {!running && supported && (
            <div className="stack">
              <label className="field">
                <span>Model</span>
                <select className="select" value={pref} onChange={(e) => setPref(e.target.value as ModelPref)}>
                  <option value="auto">Auto — pick the best model my GPU can hold</option>
                  {BROWSER_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.download} download · ~{(m.vramMB / 1024).toFixed(1)} GB VRAM</option>)}
                </select>
              </label>
              <p className="small muted">The model downloads once and is cached by your browser. Your node serves <b>Tide Lite</b> chats; you only earn for jobs you complete.</p>
            </div>
          )}

          {(node.phase === 'loading' || node.phase === 'checking') && (
            <div style={{ marginTop: 8 }}>
              <div className="meter"><i style={{ width: `${Math.round(node.progress * 100)}%` }} /></div>
              <div className="progress-text"><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.progressText || 'Starting…'}</span><span>{Math.round(node.progress * 100)}%</span></div>
            </div>
          )}
          {(node.phase === 'benchmarking' || node.phase === 'registering') && (
            <div className="row small muted" style={{ marginTop: 8 }}><span className="spinner" /> {node.phase === 'benchmarking' ? 'Measuring tokens per second…' : 'Registering with the orchestrator…'}</div>
          )}
          {node.phase === 'error' && node.error && <div className="notice danger" style={{ marginTop: 8 }}>{node.error}</div>}

          {running && (
            <div className="notice warn" style={{ marginTop: 16 }}>
              Keep this tab open and visible. Browsers throttle background tabs — you can use other Tide pages in this tab, but closing it takes your node offline.
            </div>
          )}
        </div>

        <div className="card">
          <h3>This session</h3>
          <div className="grid grid-2" style={{ marginTop: 14, gap: 10 }}>
            <div className="tile"><div className="v">{fmtInt(node.jobs)}</div><div className="l">Jobs</div></div>
            <div className="tile"><div className="v">{fmtInt(node.tokens)}</div><div className="l">Tokens</div></div>
            <div className="tile"><div className="v">{node.tokPerSec ? node.tokPerSec.toFixed(1) : '—'}</div><div className="l">Bench tok/s</div><div className="s">{node.lastJobTps ? `last job ${node.lastJobTps.toFixed(1)}` : ' '}</div></div>
            <div className="tile"><div className="v foam">{fmtUsd(earnings?.balance.today)}</div><div className="l">Earned today</div></div>
          </div>
          <div className="tiny dim mono" style={{ marginTop: 12 }}>{node.startedAt && online ? `uptime ${duration(Date.now() - node.startedAt)}` : ' '}</div>
        </div>
      </div>

      {node.log.length > 0 && (
        <div className="card">
          <h3>Node log</h3>
          <div className="log" style={{ marginTop: 10 }}>
            {node.log.slice().reverse().map((l, i) => <div key={i}><span className="dim">{new Date(l.t).toLocaleTimeString()}</span> {l.msg}</div>)}
          </div>
        </div>
      )}

      <div className="rate-strip card">
        <span>Nodes earn <b>{Math.round(NODE_SHARE * 100)}%</b> of what users pay</span>
        <span><b>{Math.round(NODE_SHARE_STAKED * 100)}%</b> with ≥500k $TIDE staked</span>
        <span>Minimum <b>5 tok/s</b> to join</span>
        <span>Paid in <b>USDC</b> on Solana</span>
      </div>
    </div>
  );
}

interface NodeToken { id: string; name: string | null; prefix: string; created_at: number; last_used_at: number | null }

const BACKENDS = [
  { id: 'ollama', label: 'Ollama', args: '--base-model qwen3:8b', note: 'Default. Install Ollama and pull the model first: ollama pull qwen3:8b' },
  { id: 'openai', label: 'llama.cpp / LM Studio / vLLM', args: '--backend openai --upstream http://127.0.0.1:8080/v1 --upstream-model <id>', note: 'Any OpenAI-compatible server. Replace <id> with the model id your server exposes.' },
  { id: 'image', label: 'Images (ComfyUI)', args: '--mode image --comfy http://127.0.0.1:8188 --comfy-ckpt <checkpoint.safetensors>', note: 'Serve the image studio from ComfyUI. Paid per image (70% of 10 credits). Use --comfy-workflow <api.json> for Flux or any custom graph.' },
  { id: 'mock', label: 'Mock (testing)', args: '--backend mock', note: 'Serves the tide-dev mock model — for testing the network without a GPU.' },
];

function MachineTab({ signedIn }: { signedIn: boolean }) {
  const { openSignIn } = useAuth();
  const nodes = useNodeStatus();
  const [tokens, setTokens] = useState<NodeToken[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState('ollama');

  const load = useCallback(async () => {
    try { setTokens((await api<{ tokens: NodeToken[] }>('/api/node-tokens')).tokens); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { if (signedIn) load(); }, [signedIn, load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ id: string; token: string }>('/api/node-tokens', { body: { name: name.trim() || undefined } });
      setFresh(r.token);
      setName('');
      load();
    } catch (err) { setError(errMsg(err)); }
  };
  const revoke = async (id: string) => {
    if (!confirm('Revoke this node token? Nodes using it will stop being able to connect.')) return;
    try { await api(`/api/node-tokens/${id}`, { method: 'DELETE' }); load(); } catch (err) { setError(errMsg(err)); }
  };

  const b = BACKENDS.find((x) => x.id === backend)!;
  const cmd = `npx tsx node/src/index.ts --token ${fresh ?? '<your tnt_ token>'} --url ${location.origin} ${b.args}`;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid grid-2">
        <div className="card stack">
          <h3>1 · Create a node token</h3>
          <p className="small muted">Node tokens (<code>tnt_…</code>) let a machine serve on behalf of your account. Up to 5 active tokens.</p>
          {signedIn ? (
            <>
              <form className="row" onSubmit={create} style={{ flexWrap: 'nowrap' }}>
                <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. desktop-4090" maxLength={40} />
                <button className="btn btn-foam btn-sm">Create</button>
              </form>
              {fresh && <SecretBox value={fresh} />}
              {error && <div className="notice danger">{error}</div>}
              {tokens.length > 0 && (
                <div className="node-list">
                  {tokens.map((t) => (
                    <div className="node-row" key={t.id}>
                      <span className="mono foam">{t.prefix}…</span>
                      <span className="grow">{t.name ?? 'unnamed'}</span>
                      <span className="tiny dim">{t.last_used_at ? `used ${timeAgo(t.last_used_at)}` : `created ${fmtDate(t.created_at, false)}`}</span>
                      <button className="icon-btn" onClick={() => revoke(t.id)} aria-label="Revoke token" title="Revoke"><IconTrash /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <button className="btn btn-foam" onClick={() => openSignIn('Sign in to create node tokens.')}>Sign in to create a token</button>
          )}
        </div>

        <div className="card stack">
          <h3>2 · Run the node</h3>
          <p className="small muted">From a checkout of the Tide repo (Node.js 22+). Your node benchmarks itself, then joins the network and serves <b>Tide Max</b> jobs.</p>
          <div className="cmd-tabs">
            {BACKENDS.map((x) => (
              <button key={x.id} className={`btn btn-xs ${backend === x.id ? 'btn-foam' : 'btn-ghost'}`} onClick={() => setBackend(x.id)}>{x.label}</button>
            ))}
          </div>
          <CodeBlock code={cmd} />
          <p className="tiny muted">{b.note} Add <code>--save</code> to remember options in <code>~/.tide-node.json</code>.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Your live nodes</h3>
          <span className="badge foam">{nodes.length} online</span>
        </div>
        {nodes.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Node</th><th>Type</th><th>Model</th><th>Status</th><th className="num">tok/s</th><th className="num">Jobs</th><th className="num">Tokens</th><th>Up</th></tr></thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.nodeId}>
                    <td className="mono">{n.nodeId}</td>
                    <td><span className={`badge ${n.type === 'browser' ? 'sky' : 'foam'}`}>{n.type}</span></td>
                    <td className="mono small">{n.model}</td>
                    <td><span className="row" style={{ gap: 6 }}><span className={`dot${n.status === 'busy' ? ' busy' : ''}`} />{n.status}</span></td>
                    <td className="num">{n.tokPerSec.toFixed(1)}</td>
                    <td className="num">{fmtInt(n.jobsCompleted)}</td>
                    <td className="num">{fmtInt(n.tokensGenerated)}</td>
                    <td className="small">{duration(Date.now() - n.connectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">{signedIn ? 'No nodes online. Start one above — it appears here within seconds.' : 'Sign in to see your nodes.'}</div>}
      </div>
    </div>
  );
}
