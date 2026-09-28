import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { NODE_SHARE, NODE_SHARE_STAKED } from '@tide/shared';
import { Sea } from '../components/Sea';
import { Footer } from '../components/Nav';
import { IconArrow } from '../components/Icons';
import { useNetworkStats } from '../lib/socket';
import { fmtCompact, fmtInt } from '../lib/format';

export const PENDING_PROMPT_KEY = 'tide_pending_prompt';

export default function Home() {
  const stats = useNetworkStats();
  const nav = useNavigate();
  const [prompt, setPrompt] = useState('');
  const origin = typeof location !== 'undefined' ? location.origin : 'https://tide.network';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = prompt.trim();
    if (!p) return nav('/chat');
    sessionStorage.setItem(PENDING_PROMPT_KEY, p);
    nav('/chat');
  };

  const activity = stats ? Math.min(1, 0.15 + (stats.busy / Math.max(1, stats.nodesOnline)) * 0.85) : 0.2;

  const ticker = useMemo(() => {
    const items: string[] = [];
    if (stats) {
      items.push(`${fmtInt(stats.nodesOnline)} nodes online`);
      items.push(`${fmtInt(stats.browserNodes)} browser · ${fmtInt(stats.nativeNodes)} native`);
      for (const [m, n] of Object.entries(stats.byModel)) items.push(`${m} · ${n} node${n === 1 ? '' : 's'} serving`);
      items.push(`${fmtCompact(stats.jobsCompleted)} jobs served`);
      items.push(`${fmtCompact(stats.tokensGenerated)} tokens generated`);
      items.push(`avg ${stats.avgTokPerSec.toFixed(1)} tok/s`);
      items.push(`${stats.busy} busy · queue ${stats.queueDepth}`);
    }
    items.push(`${Math.round(NODE_SHARE * 100)}% of every paid token goes to the node`);
    items.push('0 prompts stored');
    items.push('paid out in USDC on Solana');
    items.push('OpenAI-compatible API');
    while (items.length < 12) items.push(...items.slice(0, 12 - items.length));
    return items;
  }, [stats]);

  return (
    <div className="landing">
      <header className="hero">
        <Sea activity={activity} />
        <div className="wrap" style={{ width: '100%' }}>
          <div className="hero-inner">
            <span className="pill">
              <span className={`dot${stats && stats.nodesOnline === 0 ? ' off' : ''}`} />
              <span className="mono">{stats ? `${fmtInt(stats.nodesOnline)} node${stats.nodesOnline === 1 ? '' : 's'} online` : 'connecting to the network…'}</span>
            </span>
            <h1>Compute that <em>flows</em> where it's needed.</h1>
            <p className="lead">Tide is an open protocol for decentralized AI. A permissionless network of user-owned GPUs that funds inference of open models.</p>
            <form className="hero-prompt" onSubmit={submit}>
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ask the network anything…"
                aria-label="Ask Tide"
                enterKeyHint="send"
              />
              <button className="btn btn-foam btn-sm" type="submit">Ask <IconArrow width={15} height={15} /></button>
            </form>
            <div className="cta">
              <Link className="btn btn-foam" to="/docs">Start building</Link>
              <Link className="btn btn-ghost" to="/earn">Run a node</Link>
            </div>
            <div className="stats">
              <div className="stat"><b>{stats ? stats.avgTokPerSec.toFixed(1) : '—'}</b><span>avg tok/s per node</span></div>
              <div className="stat"><b>0</b><span>prompts stored</span></div>
              <div className="stat"><b>{stats ? fmtCompact(stats.jobsCompleted) : '—'}</b><span>requests served</span></div>
              <div className="stat"><b>{stats ? fmtCompact(stats.tokensGenerated) : '—'}</b><span>tokens generated</span></div>
            </div>
          </div>
        </div>
      </header>

      <div className="ticker" aria-hidden="true">
        <div>
          {[...ticker, ...ticker].map((t, i) => <span key={i}><i>≈</i> {t}</span>)}
        </div>
      </div>

      <section>
        <div className="wrap">
          <div className="eyebrow">// pick your current</div>
          <h2>Three ways into the tide.</h2>
          <p className="sub">Build on it, power it, or own a piece of it. Every role feeds the same network.</p>
          <div className="doors">
            <div className="door" id="dev">
              <div className="tag">FOR DEVELOPERS</div>
              <h3>Build on the network</h3>
              <p>One OpenAI-compatible API, served by distributed nodes instead of a data center. No prompt logging. Pay for exactly the tokens you use.</p>
              <ul><li>Drop-in OpenAI SDK support</li><li>Streaming, thinking and tool calls</li><li>Pay per token, no subscription</li></ul>
              <Link className="more" to="/docs">Read the API →</Link>
            </div>
            <div className="door" id="earn">
              <div className="tag">FOR GPU OWNERS</div>
              <h3>Plug in, get paid</h3>
              <p>Your idle GPU is dead water. Put it in the current and earn USDC for every token you serve — starting from a browser tab, all the way up to a full node.</p>
              <ul><li>Browser node via WebGPU — zero install</li><li>Native node with Ollama, llama.cpp or vLLM</li><li>{Math.round(NODE_SHARE * 100)}% of revenue, paid in USDC</li></ul>
              <Link className="more" to="/earn">Start earning →</Link>
            </div>
            <div className="door">
              <div className="tag">FOR THE OPEN-MODEL COMMUNITY</div>
              <h3>Own a piece</h3>
              <p>Tide is infrastructure that pays for itself. Protocol revenue buys back $TIDE: half is burned, half flows to the people who stake it.</p>
              <ul><li>Revenue-backed buybacks</li><li>Stake $TIDE, earn the flow</li><li>Open treasury, on-chain</li></ul>
              <a className="more" href="#token">See the tokenomics →</a>
            </div>
          </div>
        </div>
      </section>

      <section id="api" style={{ paddingTop: 40 }}>
        <div className="wrap split">
          <div>
            <div className="eyebrow">// developers</div>
            <h2>Change one line.<br />Ride the tide.</h2>
            <p className="sub">Point any OpenAI client at Tide. Your request is routed to whichever node is free and fastest, streamed back token by token, and settled to the exact tokens delivered.</p>
            <ul className="check">
              <li><span><b>Open models.</b> Only illegal content is filtered.</span></li>
              <li><span><b>Nothing stored.</b> Prompts and outputs never touch our database.</span></li>
              <li><span><b>Fair metering.</b> Credits held up front, refunded to the token.</span></li>
            </ul>
          </div>
          <pre>
<span className="k">from</span> openai <span className="k">import</span> OpenAI{'\n\n'}
client = OpenAI({'\n'}
{'    '}base_url=<span className="s">"{origin}/v1"</span>,{'\n'}
{'    '}api_key=<span className="s">"sk-tide-..."</span>,{'\n'}
){'\n\n'}
res = client.chat.completions.create({'\n'}
{'    '}model=<span className="s">"tide-max"</span>,{'\n'}
{'    '}messages=[{'{'}<span className="s">"role"</span>: <span className="s">"user"</span>,{'\n'}
{'               '}<span className="s">"content"</span>: <span className="s">"Explain the tides."</span>{'}'}],{'\n'}
{'    '}stream=<span className="k">True</span>,{'\n'}
){'\n'}
<span className="c"># ≈ served by a GPU somewhere on the open internet</span>
          </pre>
        </div>
      </section>

      <section style={{ paddingTop: 40 }}>
        <div className="wrap">
          <div className="eyebrow">// how it flows</div>
          <h2>From prompt to payout.</h2>
          <div className="flow">
            <div className="step"><div className="n">01 · REQUEST</div><h4>You send a prompt</h4><p>Via chat or the API. Credits are held for the worst case and settled to the token.</p></div>
            <div className="step"><div className="n">02 · ROUTE</div><h4>The orchestrator flows it</h4><p>Jobs go to free nodes, weighted by measured speed. No free node? You wait in a fair queue.</p></div>
            <div className="step"><div className="n">03 · SERVE</div><h4>A node runs it</h4><p>A browser tab over WebGPU or a native GPU node streams tokens straight back to you.</p></div>
            <div className="step"><div className="n">04 · SETTLE</div><h4>Everyone gets paid</h4><p>Nodes earn {Math.round(NODE_SHARE * 100)}% in USDC. Protocol fees buy back $TIDE for burns and stakers.</p></div>
          </div>
        </div>
      </section>

      <section id="token" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <div className="token">
            <div>
              <div className="eyebrow">// $TIDE</div>
              <h2>Usage in.<br />Value out.</h2>
              <p className="sub">Every paid token of inference sends protocol revenue into a buyback. What comes back gets split down the middle. Node operators staking ≥500k $TIDE earn {Math.round(NODE_SHARE_STAKED * 100)}% instead of {Math.round(NODE_SHARE * 100)}%.</p>
            </div>
            <div>
              <div className="split-bar"><div className="burn">50% BURN</div><div className="stake">50% STAKERS</div></div>
              <div className="legend">
                <div><b>Ebb — burned</b>Half of every buyback is removed from supply forever.</div>
                <div><b>Flow — staked</b>Half is streamed to $TIDE stakers, pro-rata.</div>
              </div>
              <p className="small muted" style={{ marginTop: 18 }}><Link className="link" to="/network#treasury">Watch the treasury live →</Link></p>
            </div>
          </div>
        </div>
      </section>

      <section className="final">
        <div className="wrap">
          <div className="eyebrow">// high tide</div>
          <h2>The biggest models, on everyone's GPUs.</h2>
          <p className="sub" style={{ margin: '0 auto' }}>Rising water lifts every node.</p>
          <div className="cta" style={{ marginTop: 34 }}>
            <Link className="btn btn-foam" to="/chat">Try Tide Chat</Link>
            <Link className="btn btn-ghost" to="/earn">Connect a GPU</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
