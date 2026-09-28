#!/usr/bin/env -S npx tsx
/**
 * tide-node — connect a GPU to the Tide network and earn for every token it serves.
 *
 *   tide-node --token tnt_… [--url https://tide.network] [--backend ollama|openai|mock]
 *             [--base-model qwen3:8b] [--ollama http://127.0.0.1:11434]
 *             [--upstream http://127.0.0.1:8080/v1 --upstream-model my-model]
 */
import { io, type Socket } from 'socket.io-client';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JobNewMsg, RegisterAck, RegisterPayload } from '@tide/shared';
import { MockBackend, OllamaBackend, OpenAICompatBackend, type Backend } from './backends.ts';

const VERSION = '0.1.0';
const CONFIG_PATH = join(homedir(), '.tide-node.json');

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

const saved: Record<string, string> = (() => { try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
const args = { ...saved, ...parseArgs(process.argv.slice(2)) } as Record<string, string>;
const log = (s: string) => console.log(`\x1b[36m≈\x1b[0m ${s}`);
const warn = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`);

if (args.help || !args.token) {
  console.log(`tide-node ${VERSION}

  --token <tnt_…>         node token from the Earn page (required)
  --url <url>             Tide server (default http://localhost:3001)
  --backend <name>        ollama (default) | openai | mock
  --base-model <name>     Ollama base model to serve as tide-max (default qwen3:8b)
  --ollama <url>          Ollama URL (default http://127.0.0.1:11434)
  --num-ctx <n>           context window for Ollama (default 16384)
  --upstream <url>        OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1
  --upstream-model <id>   model id on the upstream server
  --upstream-key <key>    API key for the upstream server, if any
  --save                  remember these options in ~/.tide-node.json`);
  process.exit(args.token ? 0 : 1);
}

if (args.save) {
  const { save: _s, help: _h, ...rest } = args;
  writeFileSync(CONFIG_PATH, JSON.stringify(rest, null, 2));
  log(`saved options to ${CONFIG_PATH}`);
}

function makeBackend(): Backend {
  switch (args.backend ?? 'ollama') {
    case 'mock': return new MockBackend(Number(args['mock-tps']) || 40);
    case 'openai':
      if (!args.upstream || !args['upstream-model']) throw new Error('--upstream and --upstream-model are required for the openai backend');
      return new OpenAICompatBackend(args.upstream, args['upstream-model'], args['upstream-key']);
    case 'ollama':
      return new OllamaBackend(args.ollama ?? 'http://127.0.0.1:11434', args['base-model'] ?? 'qwen3:8b', Number(args['num-ctx']) || 16384);
    default: throw new Error(`unknown backend ${args.backend}`);
  }
}

async function benchmark(b: Backend): Promise<number> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180_000);
  const noop = () => {};
  await b.generate({ messages: [{ role: 'user', content: 'Say hi.' }], maxTokens: 4, think: false, signal: ctl.signal, onToken: noop });
  let first = 0, n = 0;
  const t0 = Date.now();
  await b.generate({
    messages: [{ role: 'user', content: 'Write a short paragraph about ocean tides.' }],
    maxTokens: 64, think: false, signal: ctl.signal,
    onToken: () => { if (!n++) first = Date.now(); },
  });
  clearTimeout(timer);
  const secs = (Date.now() - (first || t0)) / 1000;
  return n > 1 ? (n - 1) / Math.max(secs, 0.001) : 0;
}

async function main() {
  const backend = makeBackend();
  log(`tide-node ${VERSION} · ${backend.describe()}`);
  await backend.prepare(log);
  log('benchmarking…');
  const tps = await benchmark(backend);
  log(`benchmark: ${tps.toFixed(1)} tok/s`);
  if (tps < 2) { warn('too slow to serve the network (need at least 5 tok/s)'); process.exit(1); }

  const url = args.url ?? 'http://localhost:3001';
  const socket: Socket = io(url, { transports: ['websocket'], auth: { token: args.token }, reconnectionDelay: 2000, reconnectionDelayMax: 10_000 });
  const running = new Map<string, AbortController>();
  let jobsDone = 0, tokensDone = 0;

  const register = () => {
    const payload: RegisterPayload = {
      model: backend.networkModel, tokPerSec: Math.round(tps * 10) / 10, type: 'native',
      capabilities: { tools: !(backend instanceof MockBackend), think: true }, version: VERSION,
    };
    socket.emit('node:register', payload, (r: RegisterAck) => {
      if ('error' in r) { warn(`registration refused: ${r.error}`); process.exit(2); }
      log(`online as ${r.nodeId} — serving ${backend.networkModel} on ${url}`);
    });
  };

  socket.on('connect', register);
  socket.on('disconnect', (why) => warn(`disconnected (${why}), reconnecting…`));
  socket.on('connect_error', (e) => warn(`connection failed: ${e.message}`));
  socket.on('node:kicked', ({ reason }) => { warn(`removed from network: ${reason}`); process.exit(3); });

  socket.on('job:new', async (job: JobNewMsg) => {
    const ctl = new AbortController();
    running.set(job.jobId, ctl);
    const started = Date.now();
    try {
      const r = await backend.generate({
        messages: job.messages, maxTokens: job.maxTokens, think: job.think, tools: job.tools, temperature: job.temperature,
        signal: ctl.signal, onToken: (token) => socket.emit('job:token', { jobId: job.jobId, token }),
      });
      socket.emit('job:complete', { jobId: job.jobId, response: r.text, tokensGenerated: r.tokens, doneReason: r.doneReason, toolCalls: r.toolCalls });
      const secs = (Date.now() - started) / 1000;
      log(`job ${job.jobId.slice(4, 12)} · ${r.tokens} tok · ${(r.tokens / secs).toFixed(1)} tok/s`);
    } catch (e) {
      if (!ctl.signal.aborted) socket.emit('job:error', { jobId: job.jobId, error: (e as Error).message });
    } finally {
      running.delete(job.jobId);
    }
  });
  socket.on('job:cancel', ({ jobId }) => running.get(jobId)?.abort());
  socket.on('job:counted', ({ tokensGenerated }) => { jobsDone++; tokensDone += tokensGenerated; });

  const shutdown = () => {
    log(`shutting down · ${jobsDone} jobs · ${tokensDone} tokens this session`);
    socket.emit('node:unregister');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { warn((e as Error).message); process.exit(1); });
