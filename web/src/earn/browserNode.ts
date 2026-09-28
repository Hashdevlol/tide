/**
 * Browser node: serves Tide Lite jobs from this tab over WebGPU with WebLLM.
 * Lives at module scope so it keeps serving while the user navigates the app.
 */
import { useSyncExternalStore } from 'react';
import type { ChatMessage, JobNewMsg, RegisterAck, RegisterPayload } from '@tide/shared';
import type { MLCEngine } from '@mlc-ai/web-llm';
import { getSocket, socketReady } from '../lib/socket';

export const BROWSER_MODELS = [
  { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen3 4B', vramMB: 3432, download: '~2.3 GB' },
  { id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Qwen3 1.7B', vramMB: 2037, download: '~1.1 GB' },
] as const;
export type BrowserModelId = (typeof BROWSER_MODELS)[number]['id'];
export type ModelPref = 'auto' | BrowserModelId;

export type Phase = 'idle' | 'checking' | 'loading' | 'benchmarking' | 'registering' | 'online' | 'reconnecting' | 'stopping' | 'error';

export interface NodeState {
  phase: Phase;
  model: BrowserModelId | null;
  progress: number;
  progressText: string;
  tokPerSec: number;
  nodeId: string | null;
  error: string | null;
  jobs: number;
  tokens: number;
  lastJobTps: number;
  busy: boolean;
  startedAt: number | null;
  log: { t: number; msg: string }[];
}

const initial: NodeState = {
  phase: 'idle', model: null, progress: 0, progressText: '', tokPerSec: 0, nodeId: null, error: null,
  jobs: 0, tokens: 0, lastJobTps: 0, busy: false, startedAt: null, log: [],
};

let state: NodeState = initial;
const subs = new Set<() => void>();
function set(p: Partial<NodeState>) {
  state = { ...state, ...p };
  subs.forEach((f) => f());
}
function log(msg: string) {
  set({ log: [...state.log, { t: Date.now(), msg }].slice(-60) });
}

export function useBrowserNode(): NodeState {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
}

// ------------------------------------------------------------------ runtime
let engine: MLCEngine | null = null;
let releaseLock: (() => void) | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let current: { jobId: string; cancelled: boolean } | null = null;
let stopping = false;
let wired = false;

export function webgpuSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

async function pickCandidates(pref: ModelPref): Promise<BrowserModelId[]> {
  if (pref !== 'auto') return pref === BROWSER_MODELS[0].id ? [BROWSER_MODELS[0].id, BROWSER_MODELS[1].id] : [BROWSER_MODELS[1].id];
  const gpu = (navigator as any).gpu;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter available. Try Chrome or Edge with hardware acceleration enabled.');
  const maxBuf = Number(adapter.limits?.maxBufferSize ?? 0);
  const mem = Number((navigator as any).deviceMemory ?? 8);
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  // Prefer the 4B model when the device looks like it has room for it; fall back otherwise.
  const roomy = !mobile && mem >= 8 && maxBuf >= 1024 ** 3;
  log(`GPU: max buffer ${(maxBuf / 1024 ** 2).toFixed(0)} MB · device memory ${mem} GB${mobile ? ' · mobile' : ''}`);
  return roomy ? [BROWSER_MODELS[0].id, BROWSER_MODELS[1].id] : [BROWSER_MODELS[1].id];
}

async function benchmark(eng: MLCEngine): Promise<number> {
  const t0 = performance.now();
  let first = 0, n = 0;
  let reported = 0;
  const stream = await eng.chat.completions.create({
    messages: [{ role: 'user', content: 'Count from 1 to 20.' }],
    max_tokens: 64,
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
    extra_body: { enable_thinking: false },
  });
  for await (const ch of stream) {
    if (ch.choices[0]?.delta?.content) { if (!n) first = performance.now(); n++; }
    const extra = (ch.usage as { extra?: { decode_tokens_per_s?: number } } | undefined)?.extra;
    if (extra?.decode_tokens_per_s) reported = extra.decode_tokens_per_s;
  }
  if (reported > 0) return reported;
  try {
    const txt = await eng.runtimeStatsText();
    const m = /decode:\s*([\d.]+)\s*tok\/s/i.exec(txt);
    if (m) return Number(m[1]);
  } catch { /* ignore */ }
  const secs = (performance.now() - (first || t0)) / 1000;
  return n > 1 ? (n - 1) / Math.max(secs, 0.001) : 0;
}

function toEngineMessages(messages: ChatMessage[]) {
  // WebLLM accepts system/user/assistant only, with the system prompt first.
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content || ' ' }));
  return [...(sys ? [{ role: 'system' as const, content: sys }] : []), ...rest];
}

async function runJob(job: JobNewMsg) {
  const s = getSocket();
  if (!engine || current) {
    s.emit('job:error', { jobId: job.jobId, error: 'Node busy' });
    return;
  }
  const me = { jobId: job.jobId, cancelled: false };
  current = me;
  set({ busy: true });
  const started = performance.now();
  let text = '', n = 0, finish: string | null = null;
  try {
    const stream = await engine.chat.completions.create({
      stream: true,
      messages: toEngineMessages(job.messages),
      max_tokens: job.maxTokens,
      temperature: job.temperature ?? 0.6,
      top_p: 0.95,
      extra_body: { enable_thinking: !!job.think },
    });
    for await (const ch of stream) {
      if (me.cancelled) break;
      const d = ch.choices[0]?.delta?.content;
      if (d) {
        text += d;
        n++;
        s.emit('job:token', { jobId: job.jobId, token: d });
      }
      if (ch.choices[0]?.finish_reason) finish = ch.choices[0].finish_reason;
    }
    if (me.cancelled) {
      log(`job ${job.jobId.slice(4, 12)} cancelled`);
    } else {
      s.emit('job:complete', { jobId: job.jobId, response: text, tokensGenerated: n, doneReason: finish === 'length' ? 'length' : 'stop' });
      const secs = (performance.now() - started) / 1000;
      const tps = n / Math.max(secs, 0.001);
      set({ jobs: state.jobs + 1, lastJobTps: tps });
      log(`job ${job.jobId.slice(4, 12)} · ${n} tok · ${tps.toFixed(1)} tok/s`);
    }
  } catch (e) {
    if (!me.cancelled) {
      s.emit('job:error', { jobId: job.jobId, error: (e as Error).message?.slice(0, 200) ?? 'generation failed' });
      log(`job ${job.jobId.slice(4, 12)} failed: ${(e as Error).message}`);
    }
  } finally {
    if (current === me) current = null;
    set({ busy: false });
  }
}

function register(): Promise<RegisterAck> {
  const payload: RegisterPayload = {
    model: state.model!,
    tokPerSec: Math.round(state.tokPerSec * 10) / 10,
    type: 'browser',
    capabilities: { tools: false, think: true },
    numCtx: 4096,
    version: 'web-0.1.0',
  };
  return getSocket().timeout(15_000).emitWithAck('node:register', payload) as Promise<RegisterAck>;
}

function wireSocket() {
  if (wired) return;
  wired = true;
  const s = getSocket();
  s.on('job:new', (job: JobNewMsg) => { if (engine && state.phase === 'online') runJob(job); });
  s.on('job:cancel', ({ jobId }: { jobId: string }) => {
    if (current?.jobId === jobId) {
      current.cancelled = true;
      try { engine?.interruptGenerate(); } catch { /* ignore */ }
    }
  });
  s.on('job:counted', ({ tokensGenerated }: { tokensGenerated: number }) => set({ tokens: state.tokens + (tokensGenerated || 0) }));
  s.on('node:kicked', ({ reason }: { reason: string }) => {
    log(`removed from network: ${reason}`);
    void stopBrowserNode(`Removed from the network: ${reason}`);
  });
  s.on('disconnect', () => {
    if (state.phase === 'online') { set({ phase: 'reconnecting', nodeId: null }); log('connection lost — reconnecting…'); }
    if (current) { current.cancelled = true; try { engine?.interruptGenerate(); } catch { /* ignore */ } }
  });
  s.on('connect', async () => {
    if (state.phase !== 'reconnecting' || !engine) return;
    try {
      const r = await register();
      if ('error' in r) throw new Error(r.error);
      set({ phase: 'online', nodeId: r.nodeId });
      log(`back online as ${r.nodeId}`);
    } catch (e) {
      void stopBrowserNode((e as Error).message);
    }
  });
}

async function holdLocks() {
  const locks = (navigator as any).locks;
  if (locks?.request && !releaseLock) {
    locks.request('tide-browser-node', () => new Promise<void>((resolve) => { releaseLock = resolve; })).catch(() => {});
  }
  try { wakeLock = await (navigator as any).wakeLock?.request('screen'); } catch { /* optional */ }
}
function releaseLocks() {
  releaseLock?.();
  releaseLock = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

export async function startBrowserNode(pref: ModelPref) {
  if (!['idle', 'error'].includes(state.phase)) return;
  stopping = false;
  set({ ...initial, phase: 'checking', log: [], startedAt: null });
  try {
    if (!webgpuSupported()) throw new Error('WebGPU is not available in this browser. Use a recent Chrome, Edge or Safari on a device with a GPU.');
    const candidates = await pickCandidates(pref);
    const webllm = await import('@mlc-ai/web-llm');
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i];
      if (stopping) return;
      set({ phase: 'loading', model: id, progress: 0, progressText: 'Preparing download…' });
      log(`loading ${id}`);
      try {
        engine = await webllm.CreateMLCEngine(
          id,
          { initProgressCallback: (r) => set({ progress: r.progress, progressText: r.text }) },
          { context_window_size: 4096 },
        );
        break;
      } catch (e) {
        log(`could not load ${id}: ${(e as Error).message}`);
        engine = null;
        if (i === candidates.length - 1) throw e;
      }
    }
    if (stopping || !engine) { await teardown(); return; }
    set({ phase: 'benchmarking', progress: 1, progressText: 'Benchmarking…' });
    const tps = await benchmark(engine);
    log(`benchmark: ${tps.toFixed(1)} tok/s`);
    set({ tokPerSec: tps });
    if (stopping) { await teardown(); return; }

    set({ phase: 'registering' });
    await socketReady();
    wireSocket();
    const r = await register();
    if ('error' in r) throw new Error(r.error);
    await holdLocks();
    set({ phase: 'online', nodeId: r.nodeId, startedAt: Date.now() });
    log(`online as ${r.nodeId}`);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log(`error: ${msg}`);
    await teardown();
    set({ phase: 'error', error: msg, nodeId: null });
  }
}

async function teardown() {
  if (current) { current.cancelled = true; try { engine?.interruptGenerate(); } catch { /* ignore */ } }
  const eng = engine;
  engine = null;
  releaseLocks();
  if (eng) { try { await eng.unload(); } catch { /* ignore */ } }
}

export async function stopBrowserNode(error?: string) {
  if (state.phase === 'idle') return;
  stopping = true;
  set({ phase: 'stopping' });
  try { getSocket().emit('node:unregister'); } catch { /* ignore */ }
  await teardown();
  log('stopped');
  set({ phase: error ? 'error' : 'idle', error: error ?? null, nodeId: null, busy: false, progress: 0 });
}

// Tell the orchestrator promptly when the tab closes.
if (typeof window !== 'undefined') {
  addEventListener('pagehide', () => { if (state.nodeId) getSocket().emit('node:unregister'); });
}
