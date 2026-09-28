import { Link } from 'react-router-dom';
import { PRICE_IN_PER_M_USD, PRICE_OUT_PER_M_USD } from '@tide/shared';
import { CodeBlock } from '../components/CopyButton';
import { Footer } from '../components/Nav';

const TOC = [
  ['overview', 'Overview'],
  ['auth', 'Authentication'],
  ['models', 'Models'],
  ['chat', 'Chat completions'],
  ['streaming', 'Streaming'],
  ['tools', 'Tools & thinking'],
  ['balance', 'Balance'],
  ['errors', 'Errors'],
  ['limits', 'Limits & billing'],
  ['nodes', 'Run a node'],
] as const;

const ERRORS = [
  ['400', 'invalid_request_error', 'Malformed body, empty messages, or a prompt too long for the model.'],
  ['400', 'content_policy_violation', 'Blocked by the safety filter (illegal content only).'],
  ['401', 'invalid_request_error', 'Missing or invalid API key.'],
  ['402', 'insufficient_quota', 'Not enough credits (or free prompts used up). Top up in Settings.'],
  ['404', 'model_not_found', 'Unknown model id.'],
  ['429', 'rate_limit_exceeded', 'Too many requests for this key — back off and retry.'],
  ['503', 'server_error', 'No capacity: no node is serving the model, or the node timed out / went offline.'],
];

export default function Docs() {
  const origin = location.origin;
  const base = `${origin}/v1`;

  const curl = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $TIDE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "tide-max",
    "messages": [
      {"role": "system", "content": "You are concise."},
      {"role": "user", "content": "Why do tides happen?"}
    ],
    "max_tokens": 512
  }'`;
  const py = `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="sk-tide-...")

stream = client.chat.completions.create(
    model="tide-max",
    messages=[{"role": "user", "content": "Explain the tides."}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
    elif chunk.usage:
        print("\\n", chunk.usage)`;
  const js = `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}", apiKey: process.env.TIDE_API_KEY });

const res = await client.chat.completions.create({
  model: "tide-max-think",          // "-think" suffix = reasoning on
  messages: [{ role: "user", content: "Plan a 3-day Lisbon trip." }],
});
console.log(res.choices[0].message.content, res.usage);`;
  const models = `curl ${base}/models

{
  "object": "list",
  "data": [
    { "id": "tide-max", "name": "Tide Max", "available": true, "nodes": 12,
      "context_window": 16096,
      "pricing": { "type": "per_token", "usd_per_m_input": ${PRICE_IN_PER_M_USD}, "usd_per_m_output": ${PRICE_OUT_PER_M_USD} } },
    { "id": "tide-lite", "name": "Tide Lite", "available": true, "nodes": 40, ... }
  ]
}`;
  const response = `{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "tide-max",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Tides are…" },
    "finish_reason": "stop"            // "length" if max_tokens was hit
  }],
  "usage": { "prompt_tokens": 31, "completion_tokens": 212, "total_tokens": 243, "credits": 1 }
}`;
  const sse = `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}], ...}

data: {"choices":[{"index":0,"delta":{"content":"Tides"},"finish_reason":null}], ...}

: ping

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}], ...}

data: {"choices":[],"usage":{"prompt_tokens":31,"completion_tokens":212,"total_tokens":243,"credits":1}}

data: [DONE]`;
  const tools = `{
  "model": "tide-max",
  "messages": [{"role": "user", "content": "Weather in Oslo?"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    }
  }]
}
// → finish_reason "tool_calls", message.tool_calls[…]; send results back as {"role":"tool","tool_call_id":…}`;
  const balance = `curl ${base}/balance -H "Authorization: Bearer $TIDE_API_KEY"

{ "object": "balance", "credits": 4210, "usd": 4.21,
  "grant": { "plan": "pro", "total": 300, "used": 12, "remaining": 288, "resetsAt": 1767312000000 } }`;
  const node = `# 1. Get the code (Node.js 22+)
git clone <tide repo> && cd tide && npm install

# 2. Serve with Ollama (default backend)
ollama pull qwen3:8b
npx tsx node/src/index.ts --token tnt_... --url ${origin}

# …or any OpenAI-compatible server (llama.cpp, LM Studio, vLLM)
npx tsx node/src/index.ts --token tnt_... --url ${origin} \\
  --backend openai --upstream http://127.0.0.1:8080/v1 --upstream-model <id>

# …or a mock backend to test the network without a GPU
npx tsx node/src/index.ts --token tnt_... --url ${origin} --backend mock`;

  return (
    <>
      <div className="page wrap">
        <div className="page-head">
          <div className="eyebrow">// docs</div>
          <h1>API reference</h1>
          <p>Tide speaks the OpenAI Chat Completions protocol. If your code works with OpenAI, it works with Tide — change the base URL and the key.</p>
        </div>
        <div className="docs">
          <nav className="docs-toc" aria-label="On this page">
            {TOC.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
          </nav>
          <div className="docs-body">
            <section id="overview">
              <h2>Overview</h2>
              <p>Base URL:</p>
              <CodeBlock code={base} />
              <p>Every request is routed by the orchestrator to a free node serving the requested model and streamed straight back. Prompts and outputs are never stored. <code>/api/v1</code> is an alias of <code>/v1</code>.</p>
              <CodeBlock code={py} />
            </section>

            <section id="auth">
              <h2>Authentication</h2>
              <p>Send your key as a bearer token. Keys start with <code>sk-tide-</code> — create them in <Link className="link" to="/settings#keys">Settings → API keys</Link> (up to 5 per account). Keep them server-side.</p>
              <CodeBlock code={'Authorization: Bearer sk-tide-...'} />
            </section>

            <section id="models">
              <h2>Models</h2>
              <div className="endpoint"><span className="m get">GET</span>/v1/models</div>
              <p>Lists public models with live availability. No auth required.</p>
              <div className="table-wrap" style={{ margin: '12px 0 16px' }}>
                <table className="table">
                  <thead><tr><th>Model id</th><th>Served by</th><th>Max output</th><th>Notes</th></tr></thead>
                  <tbody>
                    <tr><td className="mono">tide-max</td><td>Native GPU nodes</td><td className="mono">4,096 · 8,192 thinking</td><td>Flagship. Tool calling + thinking. ~12k token prompt budget.</td></tr>
                    <tr><td className="mono">tide-lite</td><td>Browser nodes (WebGPU)</td><td className="mono">2,048</td><td>Small and fast. ~1.8k token prompt budget; no tools.</td></tr>
                    <tr><td className="mono">tide-dev</td><td>Mock nodes</td><td className="mono">512</td><td>Deterministic test model — development servers only.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>Append <code>-think</code> to any id (e.g. <code>tide-max-think</code>) — or pass <code>"think": true</code> — to let the model reason first. Reasoning arrives inline inside <code>&lt;think&gt;…&lt;/think&gt;</code>.</p>
              <CodeBlock code={models} />
            </section>

            <section id="chat">
              <h2>Chat completions</h2>
              <div className="endpoint"><span className="m">POST</span>/v1/chat/completions</div>
              <ul>
                <li><code>model</code> — a model id from <code>/v1/models</code> (default <code>tide-max</code>).</li>
                <li><code>messages</code> — roles <code>system</code>, <code>developer</code>, <code>user</code>, <code>assistant</code>, <code>tool</code>. Content may be a string or text parts (images are ignored). Oldest turns are trimmed to fit the model's prompt budget.</li>
                <li><code>max_tokens</code> / <code>max_completion_tokens</code> — capped at the model's output limit. Credits are held for this amount and refunded to what's actually generated.</li>
                <li><code>temperature</code>, <code>stream</code>, <code>stream_options.include_usage</code>, <code>tools</code>, <code>tool_choice</code> (<code>"none"</code> disables tools), <code>think</code>.</li>
              </ul>
              <CodeBlock code={curl} />
              <CodeBlock code={response} />
              <p><code>usage.credits</code> is what the request cost (1 credit = $0.001).</p>
            </section>

            <section id="streaming">
              <h2>Streaming</h2>
              <p>With <code>"stream": true</code> the response is Server-Sent Events in the OpenAI chunk format, ending with <code>data: [DONE]</code>. Comment lines (<code>: ping</code>) keep idle connections alive. If a node fails mid-stream you get a final <code>{'{"error": …}'}</code> event. Closing the connection stops generation, and you pay only for tokens already streamed.</p>
              <CodeBlock code={sse} />
              <CodeBlock code={js} />
            </section>

            <section id="tools">
              <h2>Tools &amp; thinking</h2>
              <p>Tool definitions are passed through to <code>tide-max</code> nodes that support function calling. When the model calls tools the response has <code>finish_reason: "tool_calls"</code> and <code>message.tool_calls</code>; run them and send the results back as <code>tool</code> messages.</p>
              <CodeBlock code={tools} />
            </section>

            <section id="balance">
              <h2>Balance</h2>
              <div className="endpoint"><span className="m get">GET</span>/v1/balance</div>
              <p>Your purchased credits and today's plan grant.</p>
              <CodeBlock code={balance} />
            </section>

            <section id="errors">
              <h2>Errors</h2>
              <p>Errors use the OpenAI shape: <code>{'{"error": {"message", "type", "code"}}'}</code>.</p>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>HTTP</th><th>type</th><th>Meaning</th></tr></thead>
                  <tbody>{ERRORS.map(([s, t, d]) => <tr key={s + t}><td className="mono">{s}</td><td className="mono small">{t}</td><td className="small">{d}</td></tr>)}</tbody>
                </table>
              </div>
            </section>

            <section id="limits">
              <h2>Limits &amp; billing</h2>
              <ul>
                <li>60 requests per minute per API key (default).</li>
                <li>Price: ${PRICE_IN_PER_M_USD.toFixed(2)} per 1M input tokens, ${PRICE_OUT_PER_M_USD.toFixed(2)} per 1M output tokens — the same on every model.</li>
                <li>API calls draw from a Pro/Max daily grant first, then purchased credits. The Free plan's grant and free prompts are for chat only.</li>
                <li>See <Link className="link" to="/pricing">Pricing</Link> for plans and credit packs.</li>
              </ul>
            </section>

            <section id="nodes">
              <h2>Run a node</h2>
              <p>Anyone can serve the network and earn USDC: nodes receive 70% of what users pay for the tokens they generate (80% with ≥500k $TIDE staked).</p>
              <ul>
                <li><b>Browser node</b> — open <Link className="link" to="/earn">Earn</Link>, sign in, click <i>Start earning</i>. Runs Qwen3 over WebGPU and serves <code>tide-lite</code>.</li>
                <li><b>Native node</b> — create a node token (<code>tnt_…</code>) on the Earn page, then run the node agent. It benchmarks your backend (minimum 5 tok/s) and serves <code>tide-max</code>.</li>
              </ul>
              <CodeBlock code={node} />
              <p>Nodes are verified with hidden canary prompts and speed/coherence checks. Nodes that return fake output are not paid and get banned.</p>
            </section>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
