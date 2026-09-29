import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { NODE_SHARE, REFERRAL_SHARE } from '@tide/shared';
import { Footer } from '../components/Nav';
import { NodeMascot } from '../components/Logo';
import { NodeField } from '../components/NodeField';
import { copyText } from '../components/CopyButton';
import { useNetworkStats } from '../lib/socket';
import { api } from '../lib/api';
import { useCountUp, useFeed, type FeedReceipt } from '../lib/live';
import { fmtInt } from '../lib/format';

export const PENDING_PROMPT_KEY = 'tide_pending_prompt';
const pct = (x: number) => Math.round(x * 100);

function Num({ value, digits = 0, prefix = '' }: { value: number | undefined; digits?: number; prefix?: string }) {
  const { shown, bump } = useCountUp(value);
  return (
    <span key={bump} className={bump ? 'bump' : undefined} style={{ display: 'inline-block' }}>
      {prefix}{shown.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}
    </span>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return <span>UTC {p(now.getUTCHours())}<span className="colon">:</span>{p(now.getUTCMinutes())}<span className="colon">:</span>{p(now.getUTCSeconds())}</span>;
}

function ago(t: number) {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function Receipt({ r, i, drop }: { r: FeedReceipt; i: number; drop: boolean }) {
  const rot = ((i * 37) % 7) - 3;
  return (
    <article className={`receipt${drop ? ' drop' : ''}`} style={{ ['--rot' as string]: `${rot * 0.6}deg` }}>
      <h4>Tide</h4>
      <div className="ctr">INFERENCE RECEIPT</div>
      <div className="ctr">{new Date(r.at).toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
      <hr />
      <div className="ln"><span>JOB</span><span>#{r.hash.slice(0, 10)}</span></div>
      <div className="ln"><span>NODE</span><span>{r.node}</span></div>
      <div className="ln"><span>MODEL</span><span>{r.model}</span></div>
      <hr />
      {r.kind === 'image'
        ? <div className="ln"><span>IMAGE</span><span>1 × render</span></div>
        : <>
            <div className="ln"><span>TOKENS IN</span><span>{fmtInt(r.tokensIn)}</span></div>
            <div className="ln"><span>TOKENS OUT</span><span>{fmtInt(r.tokensOut)}</span></div>
          </>}
      {r.ms ? <div className="ln"><span>TIME</span><span>{(r.ms / 1000).toFixed(2)}s</span></div> : null}
      <div className="ln"><span>CHARGED</span><span>{r.credits} CR</span></div>
      <hr />
      <div className="ln tot"><span>TO NODE</span><span>${r.paidUsd.toFixed(5)}</span></div>
      <div className="ctr" style={{ marginTop: 8 }}>PROMPT NOT STORED · {ago(r.at)}</div>
      <div className="barcode" aria-hidden="true" />
      {r.paidUsd > 0 && <div className="stamp">PAID</div>}
    </article>
  );
}

const FAQ: [string, string][] = [
  ['Who answers my prompt?', 'A GPU owned by someone on the network — a gaming PC running Ollama, a rig with llama.cpp, or a browser tab using WebGPU. The orchestrator picks a free node, weighted by its measured speed.'],
  ['Is my prompt stored?', 'No. Prompts and answers are streamed through and never written to our database. We keep token counts for billing, nothing else. The node that served you sees the text, the same way any model host does.'],
  ['What does it cost?', 'Per token: $0.15 per million in, $0.90 per million out. A typical message is about one credit ($0.001). Free accounts get daily credits; you can start without an account.'],
  ['How do node owners get paid?', `${pct(NODE_SHARE)}% of what the user paid for the tokens their GPU generated, credited per job and withdrawable in USDC from $1.`],
  ['What stops a node from faking answers?', 'Hidden test prompts with known answers, speed limits no real GPU can beat, coherence checks and strikes. Fail enough and the account is banned and unpaid.'],
  ['Can I use it from code?', 'Yes. It speaks the OpenAI API — change the base URL and the key. Streaming, tools and usage are supported.'],
];

export default function Home() {
  const stats = useNetworkStats();
  const nav = useNavigate();
  const { feed, fresh } = useFeed();
  const [prompt, setPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [paid, setPaid] = useState<number | undefined>(undefined);
  const [picked, setPicked] = useState(0);
  const origin = typeof location !== 'undefined' ? location.origin : 'https://tide.network';
  const baseUrl = `${origin.replace(/^https?:\/\//, '')}/v1`;

  useEffect(() => {
    const load = () => api<{ paidToNodes: number }>('/api/treasury', { token: null }).then((t) => setPaid(t.paidToNodes)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = prompt.trim();
    if (p) sessionStorage.setItem(PENDING_PROMPT_KEY, p);
    nav('/chat');
  };
  const copy = async () => {
    await copyText(`${origin}/v1`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const onPick = useCallback(() => setPicked((n) => n + 1), []);

  const receipts = feed?.receipts ?? [];
  const latest = receipts[0];
  const nodes = stats?.nodesOnline ?? 0;
  const util = stats && nodes ? stats.busy / nodes : 0;

  return (
    <div className="landing">
      {/* ------------------------------------------------------------ hero */}
      <header className="hero">
        <div className="wrap hero-grid">
          <div className="hero-head">
            <div className="eyebrow">Open AI inference · paid per token</div>
            <h1 style={{ marginTop: 22 }}>AI on everyone's <span className="out">GPUs.</span></h1>
          </div>
          <div>
            <p className="lead" style={{ marginTop: 0 }}>
              Ask anything. An idle GPU somewhere on the internet answers, streams it back, and its owner gets <span className="mark">{pct(NODE_SHARE)}% of every token</span>. Open models. Nothing you type is stored.
            </p>
            <form className="hero-prompt" onSubmit={submit}>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask the network anything…" aria-label="Your prompt" maxLength={4000} />
              <button type="submit">Ask →</button>
            </form>
            <div className="cta">
              <button className={`copy-pill${copied ? ' copied' : ''}`} onClick={copy} title="Copy the OpenAI-compatible base URL">
                <span>base_url = {baseUrl}</span><b>{copied ? 'Copied' : 'Copy'}</b>
              </button>
              <Link to="/earn" className="btn btn-ghost">Run a node</Link>
            </div>
          </div>

          <aside className="board" aria-label="Live network board">
            <div className="board-top">
              <span className="live"><i />Live</span>
              <Clock />
            </div>
            <div className="board-big"><Num value={stats?.tokensGenerated} /></div>
            <div className="board-cap">TOKENS SERVED BY THE NETWORK</div>
            <div className="board-bar"><i style={{ width: `${Math.max(3, util * 100)}%` }} /></div>
            <div className="board-bar-cap"><span>Utilisation</span><span>{pct(util)}% busy · queue {stats?.queueDepth ?? 0}</span></div>
            <div className="board-tiles">
              <div><b><Num value={nodes} /></b><span>Nodes online</span></div>
              <div><b><Num value={paid} digits={4} prefix="$" /></b><span>Paid to nodes</span></div>
            </div>
            <div className="board-hash">
              <span>LAST RECEIPT</span>
              <b>{latest ? `#${latest.hash} · ${latest.node} · ${ago(latest.at)}` : 'waiting for the first job…'}</b>
            </div>
          </aside>
        </div>
      </header>

      {/* ------------------------------------------------------------ node field */}
      <div className="field-band">
        <NodeField onPick={onPick} />
        <div className="field-caption"><i />1 of {Math.max(nodes, 1).toLocaleString()} nodes answers you · routed {picked}×</div>
      </div>

      {/* ------------------------------------------------------------ ticker */}
      <div className="ticker" aria-label="Recently served jobs">
        <div className="ticker-label">JUST SERVED</div>
        <div className="ticker-rail">
          <div className="ticker-track">
            {[0, 1].map((dup) => (
              <span key={dup} style={{ display: 'inline-flex', gap: 10, paddingRight: 10 }} aria-hidden={dup === 1}>
                {(receipts.length ? receipts : Array.from({ length: 6 }, () => null)).map((r, i) => r ? (
                  <span className="tick" key={i}><i className="av" style={{ background: i % 3 ? '#C9C6BD' : '#19E57F' }} />{r.node} · {r.kind === 'image' ? '1 image' : `${fmtInt(r.tokensOut)} tok`} · <b>+${r.paidUsd.toFixed(5)}</b></span>
                ) : (
                  <span className="tick" key={i}><i className="av" />waiting for jobs · nodes paid {pct(NODE_SHARE)}%</span>
                ))}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ stats */}
      <section style={{ paddingBlock: 'clamp(56px, 7vw, 96px)' }}>
        <div className="wrap">
          <div className="stats-row">
            <div><b><Num value={nodes} /></b><span>GPUs online now</span></div>
            <div><b><Num value={feed?.totals.jobs ?? stats?.jobsCompleted} /></b><span>Jobs served</span></div>
            <div><b><Num value={stats?.avgTokPerSec} digits={1} /></b><span>Avg tokens / sec</span></div>
            <div><b>0</b><span>Prompts stored</span></div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ how it works */}
      <section style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="eyebrow">How it works</div>
          <h2 style={{ marginTop: 18 }}>Three steps.<br />No datacenter.</h2>
          <div className="how">
            <div className="how-card paper">
              <span className="n">01</span>
              <h3>You ask</h3>
              <p>In chat, the image studio, or any OpenAI client. Credits are held for the worst case, then settled to the exact tokens you got.</p>
            </div>
            <div className="how-card ink">
              <span className="n">02</span>
              <h3>A GPU answers</h3>
              <p>The orchestrator routes your prompt to a free node, weighted by measured speed, and streams every token straight back.</p>
            </div>
            <div className="how-card cash">
              <span className="n">03</span>
              <h3>Its owner gets paid</h3>
              <p>{pct(NODE_SHARE)}% of what you paid goes to the person whose hardware did the work. {pct(REFERRAL_SHARE)}% to whoever invited you.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ manifesto */}
      <section className="manifesto">
        <div className="wrap">
          <div className="eyebrow" style={{ color: '#9F9C92' }}>Why</div>
          <p className="big" style={{ marginTop: 26 }}>
            Every answer used to come from <s>three companies</s> <span className="cashw">a stranger's GPU.</span> <span className="hl">Now it pays them.</span>
          </p>
          <p className="sub">Hundreds of millions of gaming GPUs sit idle most of the day. Tide turns that idle time into inference for anyone, and sends most of the money back to the people who own the hardware.</p>
        </div>
      </section>

      {/* ------------------------------------------------------------ receipts */}
      <section style={{ paddingBottom: 'clamp(40px, 6vw, 80px)' }}>
        <div className="wrap">
          <div className="row-between" style={{ alignItems: 'flex-end' }}>
            <div>
              <div className="eyebrow">Receipts wall · live</div>
              <h2 style={{ marginTop: 18 }}>Every token<br />gets a receipt.</h2>
            </div>
            <p className="sub" style={{ maxWidth: 380 }}>Real jobs from the network, printed as they settle. No prompts, no users — just what ran, where, and who got paid.</p>
          </div>
          <div className="receipts">
            {receipts.length
              ? receipts.slice(0, 14).map((r, i) => <Receipt key={r.hash} r={r} i={i} drop={fresh.has(r.hash)} />)
              : <div className="empty" style={{ width: '100%' }}>No jobs yet. <Link className="link" to="/chat">Be the first →</Link></div>}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ proof */}
      <section style={{ borderTop: '1.5px solid var(--ink)' }}>
        <div className="wrap proof">
          <div>
            <div className="eyebrow">Trust</div>
            <h2 style={{ marginTop: 18, fontSize: 'clamp(38px, 4.6vw, 74px)' }}>Nobody grades their own homework.</h2>
            <ol>
              <li><span><b>Hidden test prompts.</b> Nodes get questions with known answers that look like real jobs. Wrong answers ban the account.</span></li>
              <li><span><b>Physics checks.</b> Faster than any real GPU, or gibberish output? No pay, and a strike.</span></li>
              <li><span><b>Signed receipts.</b> Big models split across GPUs sign every layer they ran. No valid chain, no payout.</span></li>
              <li><span><b>You pay for what arrived.</b> Stop mid-answer and you're charged for the tokens you got. Nothing arrived, nothing charged.</span></li>
            </ol>
            <p style={{ marginTop: 24 }}><Link className="link" to="/network">Watch the network live →</Link></p>
          </div>
          <div className="code-card">
            <div className="code-head"><span>settle(job)</span><span>orchestrator</span></div>
            <pre>{`node   = pick(idle_nodes, weight = measured_tok_s)
hold   = cost(input + max_output)     `}<span className="c"># reserved up front</span>{`

for token in stream(node, job):       `}<span className="c"># you see it live</span>{`
    send(you, token)

charge = cost(input + tokens_delivered)
refund(you, hold - charge)            `}<span className="c"># settled to the token</span>{`

if passes_canaries(node) and speed_ok and coherent:
    pay(node.owner, charge * `}<span className="s">{NODE_SHARE.toFixed(2)}</span>{`)
else:
    strike(node.owner)                `}<span className="c"># 5 strikes = banned</span></pre>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ rules */}
      <section style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="eyebrow">House rules</div>
          <div className="rules">
            <div className="rule"><h4>Prompts are never stored.</h4><p>Streamed through, counted, forgotten. Token counts are the only thing we keep.</p></div>
            <div className="rule"><h4>Pay per token.</h4><p>$0.15 / M in, $0.90 / M out. Held up front, refunded to the exact token.</p></div>
            <div className="rule"><h4>{pct(NODE_SHARE)}% to the GPU.</h4><p>The node that served you gets the biggest share. Withdraw in USDC from $1.</p></div>
            <div className="rule"><h4>Open models only.</h4><p>No refusal layer. The single hard line is illegal content involving minors.</p></div>
            <div className="rule"><h4>Cheaters get probed.</h4><p>Test prompts, speed limits and coherence checks. Five strikes and you're out.</p></div>
            <div className="rule"><h4>No account to start.</h4><p>Five free prompts on the house. Sign in for a daily grant.</p></div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ faq */}
      <section style={{ paddingTop: 0 }}>
        <div className="wrap" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 36 }}>
          <h2>Questions.</h2>
          <div className="faq">
            {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ final */}
      <section className="final">
        <div className="wrap">
          <NodeMascot className="mascot" />
          <h2>Plug in.<br /><span className="out">Get paid.</span></h2>
          <div className="cta">
            <Link to="/earn" className="btn btn-ink btn-lg">Run a node →</Link>
            <Link to="/chat" className="btn btn-ghost btn-lg">Ask something</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
