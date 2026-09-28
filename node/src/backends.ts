import type { ChatMessage, ToolCall } from '@tide/shared';

export interface GenRequest {
  messages: ChatMessage[];
  maxTokens: number;
  think: boolean;
  tools?: unknown[];
  temperature?: number;
  signal: AbortSignal;
  onToken: (t: string) => void;
}
export interface GenResult {
  text: string;
  tokens: number;
  doneReason: 'stop' | 'length' | 'tool_calls';
  toolCalls?: ToolCall[];
}

export interface Backend {
  /** Model string sent to the orchestrator at registration. */
  networkModel: string;
  describe(): string;
  prepare(log: (s: string) => void): Promise<void>;
  generate(req: GenRequest): Promise<GenResult>;
}

async function* ndjson(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

// ------------------------------------------------------------------------------------------
// Ollama: builds a "tide-max" model from a base model with fixed sampling params.
// ------------------------------------------------------------------------------------------
export class OllamaBackend implements Backend {
  networkModel = 'tide-max';
  constructor(private url: string, private baseModel: string, private numCtx: number) {}
  describe() { return `ollama ${this.baseModel} → ${this.networkModel} (${this.url})`; }

  async prepare(log: (s: string) => void) {
    const tags = await fetch(`${this.url}/api/tags`).then((r) => r.json()).catch(() => {
      throw new Error(`Ollama is not reachable at ${this.url}. Install it from https://ollama.com and run "ollama serve".`);
    }) as { models: { name: string }[] };
    const have = new Set(tags.models.map((m) => m.name));
    if (!have.has(this.baseModel) && !have.has(this.baseModel + ':latest')) {
      log(`pulling ${this.baseModel} (first run only)…`);
      const r = await fetch(`${this.url}/api/pull`, { method: 'POST', body: JSON.stringify({ model: this.baseModel, stream: true }) });
      if (!r.ok || !r.body) throw new Error(`pull failed: ${r.status}`);
      let last = '';
      for await (const line of ndjson(r.body)) {
        const m = JSON.parse(line);
        if (m.error) throw new Error(m.error);
        const pct = m.total ? ` ${Math.floor((m.completed ?? 0) / m.total * 100)}%` : '';
        const s = `${m.status}${pct}`;
        if (s !== last) { process.stdout.write(`\r  ${s.padEnd(60)}`); last = s; }
      }
      process.stdout.write('\n');
    }
    log(`building ${this.networkModel} from ${this.baseModel} (num_ctx ${this.numCtx})`);
    const c = await fetch(`${this.url}/api/create`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.networkModel,
        from: this.baseModel,
        parameters: { temperature: 0.6, top_k: 20, top_p: 0.95, num_ctx: this.numCtx, num_gpu: 999 },
        stream: false,
      }),
    });
    if (!c.ok) throw new Error(`ollama create failed: ${await c.text()}`);
  }

  async generate(req: GenRequest): Promise<GenResult> {
    const r = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      signal: req.signal,
      body: JSON.stringify({
        model: this.networkModel,
        stream: true,
        think: req.think,
        keep_alive: -1,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t) => ({ function: { name: t.function.name, arguments: safeJson(t.function.arguments) } })) } : {}),
        })),
        tools: req.tools,
        options: { num_predict: req.maxTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
      }),
    });
    if (!r.ok || !r.body) throw new Error(`ollama ${r.status}: ${await r.text()}`);
    let text = '', tokens = 0, inThink = false, doneReason: GenResult['doneReason'] = 'stop';
    let evalCount = 0;
    const toolCalls: ToolCall[] = [];
    const emit = (s: string) => { text += s; tokens++; req.onToken(s); };
    for await (const line of ndjson(r.body)) {
      const m = JSON.parse(line);
      if (m.error) throw new Error(m.error);
      const thinking: string | undefined = m.message?.thinking;
      const content: string | undefined = m.message?.content;
      if (thinking) { if (!inThink) { emit('<think>'); inThink = true; } emit(thinking); }
      if (content) { if (inThink) { emit('</think>'); inThink = false; } emit(content); }
      for (const tc of m.message?.tool_calls ?? []) {
        toolCalls.push({ id: `call_${toolCalls.length}`, type: 'function', function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments ?? {}) } });
      }
      if (m.done) {
        evalCount = m.eval_count ?? 0;
        if (m.done_reason === 'length') doneReason = 'length';
      }
    }
    if (inThink) emit('</think>');
    if (toolCalls.length) doneReason = 'tool_calls';
    return { text, tokens: evalCount || tokens, doneReason, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}

// ------------------------------------------------------------------------------------------
// Any OpenAI-compatible server: llama.cpp (llama-server), LM Studio, vLLM, SGLang, TGI…
// ------------------------------------------------------------------------------------------
export class OpenAICompatBackend implements Backend {
  networkModel = 'tide-max';
  constructor(private url: string, private upstreamModel: string, private apiKey?: string) {}
  describe() { return `openai-compatible ${this.upstreamModel} @ ${this.url} → ${this.networkModel}`; }

  async prepare() {
    const r = await fetch(`${this.url.replace(/\/$/, '')}/models`, { headers: this.headers() }).catch(() => null);
    if (!r?.ok) throw new Error(`Upstream server not reachable at ${this.url}/models`);
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async generate(req: GenRequest): Promise<GenResult> {
    const r = await fetch(`${this.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: req.signal,
      headers: this.headers(),
      body: JSON.stringify({
        model: this.upstreamModel,
        stream: true,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.6,
        top_p: 0.95,
        messages: req.messages,
        tools: req.tools,
        chat_template_kwargs: { enable_thinking: req.think },
      }),
    });
    if (!r.ok || !r.body) throw new Error(`upstream ${r.status}: ${await r.text()}`);
    let text = '', tokens = 0, inThink = false, doneReason: GenResult['doneReason'] = 'stop';
    const calls: { id?: string; name: string; args: string }[] = [];
    const emit = (s: string) => { text += s; tokens++; req.onToken(s); };
    for await (const line of ndjson(r.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      const m = JSON.parse(data);
      const c = m.choices?.[0];
      if (!c) continue;
      const reasoning: string | undefined = c.delta?.reasoning_content ?? c.delta?.reasoning;
      if (reasoning) { if (!inThink) { emit('<think>'); inThink = true; } emit(reasoning); }
      if (c.delta?.content) { if (inThink) { emit('</think>'); inThink = false; } emit(c.delta.content); }
      for (const tc of c.delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: tc.id, name: '', args: '' };
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
      if (c.finish_reason === 'length') doneReason = 'length';
    }
    if (inThink) emit('</think>');
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id ?? `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } }));
    if (toolCalls.length) doneReason = 'tool_calls';
    return { text, tokens, doneReason, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}

// ------------------------------------------------------------------------------------------
// Mock: a toy model for local end-to-end testing (serves "tide-dev", dev servers only).
// ------------------------------------------------------------------------------------------
export class MockBackend implements Backend {
  networkModel = 'tide-dev';
  constructor(private tokPerSec = 40) {}
  describe() { return `mock model @ ~${this.tokPerSec} tok/s`; }
  async prepare() {}

  async generate(req: GenRequest): Promise<GenResult> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const reply = mockReply(last);
    const words = reply.split(/(?<=\s)/);
    let text = '', tokens = 0;
    for (const w of words) {
      if (req.signal.aborted) throw new Error('aborted');
      if (tokens >= req.maxTokens) return { text, tokens, doneReason: 'length' };
      await new Promise((r) => setTimeout(r, 1000 / this.tokPerSec));
      text += w; tokens++;
      req.onToken(w);
    }
    return { text, tokens, doneReason: 'stop' };
  }
}

function mockReply(prompt: string): string {
  const nums = prompt.match(/\b\d+\b/g)?.map(Number) ?? [];
  const word = prompt.match(/\b[A-Z]{4,6}\b/)?.[0];
  if (nums.length >= 2 && word) return `The sum is ${nums[0] + nums[1]}. ${word}`;
  const topic = prompt.replace(/\s+/g, ' ').trim().slice(0, 80) || 'your question';
  return (
    `This answer was generated by a mock Tide node, which exists so the whole network can be tested without a GPU. ` +
    `You asked about "${topic}". In a real deployment the orchestrator routes this prompt to a node running an open model, ` +
    `streams every token back as it is produced, settles the credit hold to the exact number of tokens delivered, ` +
    `and credits the node owner with seventy percent of the revenue. Canary probes, speed limits and coherence checks ` +
    `keep dishonest nodes from earning. Swap the mock backend for Ollama or any OpenAI compatible server to serve real answers.`
  );
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return {}; } }
