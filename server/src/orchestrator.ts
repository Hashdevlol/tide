import { randomBytes, randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  estimateTokens, textCreditCost,
  type ChatMessage, type ErrorCode, type JobCompleteMsg, type JobErrorMsg, type JobNewMsg, type JobTokenMsg,
  type Lane, type NetworkStats, type NodeStatus, type NodeType, type RegisterAck, type RegisterPayload,
  type SubmitAck, type SubmitPayload, type ToolCall, type Usage,
  IMAGE_CREDITS, IMAGE_MODEL, type ImageFailedMsg, type ImageJobMsg, type ImageParams, type ImageResultMsg,
} from '@tide/shared';
import { config } from './config.ts';
import { db, now } from './db.ts';
import { hashIp, resolveToken, type Principal, type User } from './auth.ts';
import { recordEarning, refund, reserve, settle, type Hold } from './billing.ts';
import { knownNodeModel, nodeServes, resolveModel, type ModelEntry } from './models.ts';
import { BLOCKED_MESSAGE, scanImagePrompt, scanText } from './safety.ts';
import { WEB_SEARCH_TOOL, formatForModel, searchProvider } from './search.ts';
import { SwarmManager, type AnnouncePayload, type Ring } from './swarm.ts';
import { publicCatalog } from './models.ts';
import {
  SPEED_CAP, SPEED_MIN_TOKENS, coherent, stripThink, gradeCanary, isBanned, makeCanary, recordCanary, strike, type Canary,
} from './anticheat.ts';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

interface NodeRec {
  id: string;
  socket: Socket;
  ownerId: string;
  ip: string;
  model: string;
  type: NodeType;
  tools: boolean;               // node can do tool calling (enables web search on chat jobs)
  benchTokPerSec: number;
  samples: number[];            // last 5 measured tok/s
  status: 'idle' | 'busy';
  jobId?: string;
  accountAgeOk: boolean;
  connectedAt: number;
  jobsCompleted: number;
  tokensGenerated: number;
  jobsSinceCanary: number;
  lastCanaryAt: number;
  idleSince: number;
}

/** Where a job's output goes: a chat socket or an HTTP API response. */
export interface JobSink {
  onQueued?(position: number): void;
  onAssigned?(nodeId: string): void;
  onToken(token: string): void;
  onComplete(r: { response: string; usage: Usage; truncated: boolean; finishReason: 'stop' | 'length' | 'tool_calls'; toolCalls?: ToolCall[] }): void;
  onError(error: string, code: ErrorCode): void;
  /** Side-channel UI events (web search progress / sources). */
  onEvent?(event: 'job:searching' | 'job:sources', data: object): void;
}

const MAX_TOOL_ROUNDS = 5;
const IMAGE_TIMEOUT = 180_000;

export interface ImageSink {
  onQueued?(position: number): void;
  onDone(r: { image: string; params: ImageParams; credits: number }): void;
  onError(error: string, code: ErrorCode): void;
}

interface ImageJob {
  id: string;
  user: User;
  params: ImageParams;
  hold: Hold;
  status: 'queued' | 'running' | 'done';
  nodeId?: string;
  createdAt: number;
  dispatchedAt?: number;
  attempts: number;
  sink?: ImageSink;
}

interface Job {
  id: string;
  user?: User;
  source: 'chat' | 'api' | 'canary';
  entry: ModelEntry;
  messages: ChatMessage[];
  think: boolean;
  tools?: unknown[];             // caller-supplied tools (API passthrough)
  serverTools: boolean;          // orchestrator runs web_search itself (chat jobs)
  rounds: number;
  roundStart: number;            // index into text where the current round began
  toolBusy?: boolean;
  swarmId?: string;              // served by a Current ring instead of a single node
  nonce?: string;                // bound into the ring's signed receipts
  temperature?: number;
  hold?: Hold;
  inputTokens: number;
  outputCap: number;
  status: 'queued' | 'running' | 'done';
  nodeId?: string;
  createdAt: number;
  dispatchedAt?: number;
  lastTokenAt?: number;
  tokens: number;
  text: string;                 // in memory only, for safety/coherence checks; never persisted
  sink?: JobSink;
  canary?: Canary;
  canaryNodeId?: string;
}

export interface SubmitRequest {
  principal: Principal;
  ip: string;
  messages: ChatMessage[];
  model?: string;
  think?: boolean;
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  source: 'chat' | 'api';
  sink: JobSink;
}

const NATIVE_SYSTEM = (search = false) =>
  `You are Tide, an open model served by a decentralized network of GPUs. Today is ${new Date().toISOString().slice(0, 10)}. ` +
  `Answer directly and helpfully.` +
  (search ? ' You can call web_search for anything recent or time-sensitive (news, prices, current events) or facts you are unsure of; cite the URLs you use.' : '');

// ---------------------------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------------------------

export class Orchestrator {
  nodes = new Map<string, NodeRec>();
  jobs = new Map<string, Job>();
  queue: string[] = [];
  imageJobs = new Map<string, ImageJob>();
  swarm: SwarmManager;
  imageQueue: string[] = [];
  private submitTimes = new Map<string, number[]>();
  private completedDurations: number[] = [];
  private totals = { jobsCompleted: 0, tokensGenerated: 0 };
  private timers: NodeJS.Timeout[] = [];

  constructor(private io: Server) {
    const t = (db.prepare("SELECT COUNT(*) n, COALESCE(SUM(output_tokens),0) t FROM jobs WHERE status = 'completed'").get() as { n: number; t: number });
    this.totals = { jobsCompleted: t.n, tokensGenerated: t.t };

    io.use((socket, next) => {
      const token = (socket.handshake.auth as { token?: string })?.token;
      const p = resolveToken(token);
      socket.data.principal = p;       // null => spectator (stats only)
      socket.data.ip = clientIp(socket);
      next();
    });
    this.swarm = new SwarmManager(publicCatalog, {
      onRingReady: () => this.processQueue(),
      onRingDown: (ring, why) => this.onRingDown(ring, why),
      changed: () => this.broadcastStats(),
    });
    io.on('connection', (s) => this.onConnection(s));

    this.timers.push(setInterval(() => this.sweep(), 10_000));
    this.timers.push(setInterval(() => this.canarySweep(), 120_000));
    this.timers.push(setInterval(() => this.swarm.sweep(), 60_000));
    this.timers.push(setInterval(() => this.io.emit('stats:update', this.stats()), 5_000));
  }

  stop() { this.timers.forEach(clearInterval); }

  // ------------------------------------------------------------------ connections
  private onConnection(s: Socket) {
    const p = s.data.principal as Principal | null;
    s.emit('stats:update', this.stats());
    if (p) s.join(`user:${p.user.id}`);
    if (p && p.kind !== 'node') this.emitNodeStatus(p.user.id, s);

    // ---- node side ----
    s.on('node:register', (payload: RegisterPayload, ack?: (r: RegisterAck) => void) => {
      const r = this.registerNode(s, payload);
      ack?.(r);
    });
    s.on('node:unregister', () => this.dropNode(s.data.nodeId, 'unregistered'));
    s.on('job:token', (m: JobTokenMsg) => this.onNodeToken(s, m));
    s.on('job:complete', (m: JobCompleteMsg) => this.onNodeComplete(s, m));
    s.on('job:error', (m: JobErrorMsg) => this.onNodeError(s, m));
    s.on('image:result', (m: ImageResultMsg) => this.onImageResult(s, m));

    // ---- swarm (Current) nodes ----
    s.on('node:announce', (m: AnnouncePayload, ack?: (r: unknown) => void) => {
      const pr = s.data.principal as Principal | null;
      if (!pr || pr.kind !== 'node') return ack?.({ ok: false, reason: 'Swarm nodes must authenticate with a node token (tnt_…)' });
      if (isBanned(pr.user.id)) return ack?.({ ok: false, reason: 'This account is banned from serving' });
      ack?.(this.swarm.announce(s, pr.user.id, m));
    });
    s.on('node:rtt', (m: { rttMs: Record<string, number> }) => this.swarm.recordRtt(s.data.swarmNodeId, m?.rttMs));
    s.on('swarm:ready', (m: { swarmId: string }) => this.swarm.markReady(s.data.swarmNodeId, String(m?.swarmId)));
    s.on('swarm:job_token', (m: { jobId: string; delta: string }) => this.onSwarmToken(s, m));
    s.on('swarm:job_complete', (m: { jobId: string; response?: string; tokensGenerated?: number; receipts?: unknown[] }) => void this.onSwarmComplete(s, m));
    s.on('swarm:job_error', (m: { jobId: string; error: string }) => {
      const job = this.swarmJobFor(s, m?.jobId);
      if (job) this.failJob(job, `Swarm error: ${String(m.error ?? 'unknown').slice(0, 200)}`, 'NODE_ERROR');
    });
    s.on('image:failed', (m: ImageFailedMsg) => this.onImageFailed(s, m));

    // ---- client side ----
    s.on('job:submit', (payload: SubmitPayload, ack?: (r: SubmitAck) => void) => {
      if (!p || p.kind === 'node') return ack?.({ error: 'Sign in first', code: 'UNAUTHORIZED' });
      let jobId = '';
      const sink: JobSink = {
        onQueued: (position) => s.emit('queue:position', { jobId, position }),
        onAssigned: (nodeId) => s.emit('job:assigned', { jobId, nodeId }),
        onToken: (token) => s.emit('job:token', { jobId, token }),
        onComplete: (r) => s.emit('job:complete', { jobId, ...r }),
        onError: (error, code) => s.emit('job:error', { jobId, error, code }),
        onEvent: (event, data) => s.emit(event, { jobId, ...data }),
      };
      const r = this.submit({
        principal: p, ip: s.data.ip, messages: payload?.messages, model: payload?.model, think: payload?.think,
        source: 'chat', sink,
      });
      if ('jobId' in r) {
        jobId = r.jobId;
        (s.data.jobs ??= new Set<string>()).add(jobId);
      }
      ack?.(r);
      if ('jobId' in r) this.processQueue();
    });
    s.on('job:abort', ({ jobId }: { jobId: string }) => {
      if ((s.data.jobs as Set<string> | undefined)?.has(jobId)) this.abort(jobId);
    });

    s.on('disconnect', () => {
      if (s.data.nodeId) this.dropNode(s.data.nodeId, 'disconnected');
      if (s.data.swarmNodeId) this.swarm.drop(s.data.swarmNodeId, 'disconnected');
      for (const jobId of (s.data.jobs as Set<string> | undefined) ?? []) this.abort(jobId, true);
    });
  }

  // ------------------------------------------------------------------ nodes
  private registerNode(s: Socket, p: RegisterPayload): RegisterAck {
    const pr = s.data.principal as Principal | null;
    if (!pr) return { error: 'Missing or invalid node token' };
    if (pr.user.kind === 'anon') return { error: 'Sign in with a wallet to run a node' };
    if (s.data.nodeId && this.nodes.has(s.data.nodeId)) return { nodeId: s.data.nodeId };
    const owner = pr.user;
    if (isBanned(owner.id)) return { error: 'This account is banned from serving' };

    const type: NodeType = p?.type === 'native' || p?.type === 'image' ? p.type : 'browser';
    if (type !== 'browser' && pr.kind !== 'node') return { error: 'Native and image nodes must authenticate with a node token (tnt_…)' };
    const model = String(p?.model ?? '');
    const modelOk = type === 'image' ? model === IMAGE_MODEL : knownNodeModel(model, type);
    if (!modelOk) return { error: `Model "${model}" is not served by the network. Update your node.` };
    const tps = Number(p?.tokPerSec) || 0;
    if (type !== 'image' && tps < config.minTokPerSec) return { error: `Too slow: ${tps.toFixed(1)} tok/s (minimum ${config.minTokPerSec})` };

    const mine = [...this.nodes.values()];
    if (mine.filter((n) => n.ownerId === owner.id).length >= config.maxNodesPerAccount) return { error: 'Too many nodes on this account' };
    if (mine.filter((n) => n.ip === s.data.ip).length >= config.maxNodesPerIp) return { error: 'Too many nodes from this IP' };

    const node: NodeRec = {
      id: 'n_' + randomUUID().slice(0, 12),
      socket: s,
      ownerId: owner.id,
      ip: s.data.ip,
      model,
      type,
      tools: type === 'native' && !!p?.capabilities?.tools,
      benchTokPerSec: tps,
      samples: [],
      status: 'idle',
      accountAgeOk: now() - owner.created_at >= config.minNodeAccountAgeHours * 3600_000,
      connectedAt: now(),
      jobsCompleted: 0,
      tokensGenerated: 0,
      jobsSinceCanary: 0,
      lastCanaryAt: now(),
      idleSince: now(),
    };
    this.nodes.set(node.id, node);
    s.data.nodeId = node.id;
    log(`node ${node.id} online: ${type} ${model} @ ${tps.toFixed(1)} tok/s (owner ${owner.id.slice(0, 8)})`);
    this.emitNodeStatus(owner.id);
    this.broadcastStats();
    this.processQueue();
    return { nodeId: node.id };
  }

  private dropNode(nodeId: string | undefined, why: string) {
    if (!nodeId) return;
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.nodes.delete(nodeId);
    node.socket.data.nodeId = undefined;
    log(`node ${nodeId} offline (${why})`);
    const ij = node.jobId ? this.imageJobs.get(node.jobId) : undefined;
    if (ij && ij.status === 'running') {
      if (ij.attempts < 2) {
        ij.status = 'queued'; ij.nodeId = undefined; ij.dispatchedAt = undefined;
        this.imageQueue.unshift(ij.id);
      } else this.failImage(ij, 'The image node went offline', 'NODE_GONE');
    }
    const job = node.jobId ? this.jobs.get(node.jobId) : undefined;
    if (job && job.status === 'running') {
      if (job.canary) {
        this.finishJob(job);
      } else if (job.tokens === 0) {
        // Nothing delivered yet: put it back at the head of the queue.
        job.status = 'queued';
        job.nodeId = undefined;
        job.dispatchedAt = undefined;
        this.queue.unshift(job.id);
      } else {
        this.failJob(job, 'The node serving this answer went offline', 'NODE_GONE');
      }
    }
    this.emitNodeStatus(node.ownerId);
    this.broadcastStats();
    this.processQueue();
  }

  private kick(node: NodeRec, reason: string) {
    node.socket.emit('node:kicked', { reason });
    this.dropNode(node.id, `kicked: ${reason}`);
  }

  private speed(n: NodeRec) {
    const s = n.samples.length ? n.samples.reduce((a, b) => a + b, 0) / n.samples.length : n.benchTokPerSec;
    return Math.max(5, s);
  }

  // ------------------------------------------------------------------ submit
  submit(req: SubmitRequest): { jobId: string; lane: Lane } | { error: string; code: ErrorCode } {
    const { principal, sink } = req;
    const user = principal.user;
    if (!Array.isArray(req.messages) || req.messages.length === 0) return { error: '`messages` must be a non-empty array', code: 'BAD_REQUEST' };
    const messages: ChatMessage[] = req.messages
      .filter((m) => m && typeof m === 'object')
      .map((m) => ({ ...m, content: typeof m.content === 'string' ? m.content : '' }));

    const resolved = resolveModel(req.model);
    if (!resolved) return { error: `Unknown model "${req.model}"`, code: 'UNKNOWN_MODEL' };
    const { entry } = resolved;
    const think = resolved.think || !!req.think;

    // Safety floor on the prompt.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!scanText(messages.map((m) => m.content).join('\n')).safe) return { error: 'Request blocked by safety filter', code: 'SAFETY' };

    // Rate limit (API keys have their own per-minute limiter in the HTTP layer).
    if (req.source === 'chat') {
      const times = (this.submitTimes.get(user.id) ?? []).filter((t) => t > now() - 300_000);
      if (times.length >= config.jobsPer5Min) return { error: 'Slow down — too many requests', code: 'RATE_LIMIT' };
      times.push(now());
      this.submitTimes.set(user.id, times);
    }

    const trimmed = trimToBudget(messages, entry.inputBudget);
    if (!trimmed) return { error: `Message too long for ${entry.name} (max ~${entry.inputBudget} tokens)`, code: 'CONTEXT_TOO_LONG' };
    if (!lastUser && !trimmed.some((m) => m.role === 'tool')) return { error: 'No user message', code: 'BAD_REQUEST' };

    const servingNodes = [...this.nodes.values()].filter((n) => nodeServes(entry, n.model, n.type));
    if (entry.swarm ? !this.swarm.hasReadyRing(entry.id) : servingNodes.length === 0) {
      return { error: `No ${entry.swarm ? 'swarm is' : 'nodes are'} serving ${entry.name} right now`, code: 'NO_CAPACITY' };
    }

    const inputTokens = trimmed.reduce((a, m) => a + estimateTokens(m.content) + 4, 0);
    let outputCap = think ? entry.outputCapThink : entry.outputCap;
    if (req.maxTokens && req.maxTokens > 0) outputCap = Math.min(outputCap, Math.floor(req.maxTokens));
    const holdCredits = textCreditCost(inputTokens, outputCap);

    const r = reserve(user, holdCredits, {
      viaApiKey: principal.kind === 'apikey',
      ipHash: hashIp(req.ip),
      hasFreeCapacity: entry.swarm ? true : servingNodes.some((n) => n.accountAgeOk),
    });
    if ('error' in r) return r;

    const job: Job = {
      id: 'job_' + randomUUID().replace(/-/g, '').slice(0, 20),
      user,
      source: req.source,
      entry,
      messages: trimmed,
      think,
      tools: req.tools,
      serverTools: req.source === 'chat' && !req.tools,
      rounds: 0,
      roundStart: 0,
      temperature: req.temperature,
      hold: r.hold,
      inputTokens,
      outputCap,
      status: 'queued',
      createdAt: now(),
      tokens: 0,
      text: '',
      sink,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    return { jobId: job.id, lane: r.hold.lane };
  }

  /** Stop a job at the user's request (or because their connection dropped). */
  abort(jobId: string, silent = false) {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'done') return;
    if (silent) job.sink = undefined;
    this.failJob(job, 'Stopped', 'ABORTED');
  }

  // ------------------------------------------------------------------ dispatch
  processQueue() {
    this.processImageQueue();
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.jobs.get(this.queue[i]);
      if (!job || job.status !== 'queued') { this.queue.splice(i--, 1); continue; }
      if (job.entry.swarm) {
        const ring = this.swarm.idleRing(job.entry.id);
        if (!ring) continue;
        this.queue.splice(i--, 1);
        this.dispatchSwarm(job, ring);
        continue;
      }
      const freeLane = job.hold?.lane === 'free' || job.hold?.subsidyKind === 'free_grant';
      const idle = [...this.nodes.values()].filter(
        (n) => n.status === 'idle' && nodeServes(job.entry, n.model, n.type) && (!freeLane || n.accountAgeOk),
      );
      if (idle.length === 0) continue;
      this.queue.splice(i--, 1);
      this.dispatch(job, pickWeighted(idle, (n) => this.speed(n)));
    }
    this.queue.forEach((id, idx) => this.jobs.get(id)?.sink?.onQueued?.(idx + 1));
  }

  private dispatch(job: Job, node: NodeRec) {
    job.status = 'running';
    job.nodeId = node.id;
    job.dispatchedAt = now();
    job.lastTokenAt = now();
    node.status = 'busy';
    node.jobId = job.id;
    job.sink?.onAssigned?.(node.id);
    node.socket.emit('job:new', this.jobMessage(job, node));
    this.emitNodeStatus(node.ownerId);
  }

  private jobMessage(job: Job, node: NodeRec): JobNewMsg {
    const tools = job.tools ?? (job.serverTools && node.tools && job.rounds < MAX_TOOL_ROUNDS ? [WEB_SEARCH_TOOL] : undefined);
    let messages = job.messages;
    if (node.type === 'native' && !messages.some((m) => m.role === 'system')) {
      messages = [{ role: 'system', content: NATIVE_SYSTEM(!!tools && !job.tools) }, ...messages];
    }
    return {
      jobId: job.id,
      messages,
      maxTokens: Math.max(64, job.outputCap - job.tokens),
      think: job.think,
      tools,
      temperature: job.temperature,
    };
  }

  /** Run the model's web_search calls, then start the next generation round on the same node. */
  private async runServerTools(job: Job, node: NodeRec, calls: ToolCall[]) {
    job.rounds++;
    job.toolBusy = true;
    const said = stripThink(job.text.slice(job.roundStart));
    const named = calls.map((c, i) => ({ ...c, id: c.id ?? `call_${job.rounds}_${i}`, type: 'function' as const }));
    job.messages = [...job.messages, { role: 'assistant', content: said, tool_calls: named }];
    for (const c of named) {
      let content = `Unknown tool "${c.function.name}"`;
      if (c.function.name === 'web_search') {
        let args: { query?: string; freshness?: string } = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* model sent bad JSON */ }
        const query = String(args.query ?? '').slice(0, 300);
        job.sink?.onEvent?.('job:searching', { query });
        const results = query ? await searchProvider.run(query, args.freshness).catch((e) => { log(`search failed: ${(e as Error).message}`); return []; }) : [];
        job.sink?.onEvent?.('job:sources', { query, sources: results.map(({ title, url, description }) => ({ title, url, description })) });
        content = formatForModel(query, results);
      }
      job.messages.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content });
      job.inputTokens += estimateTokens(content);
    }
    // The job may have been stopped or the node may have left while we searched.
    if (job.status !== 'running' || node.jobId !== job.id || !this.nodes.has(node.id)) return;
    job.toolBusy = false;
    job.lastTokenAt = now();
    job.roundStart = job.text.length;
    node.socket.emit('job:new', this.jobMessage(job, node));
  }

  // ------------------------------------------------------------------ node events
  private jobFor(s: Socket, jobId: string): { job: Job; node: NodeRec } | null {
    const node = this.nodes.get(s.data.nodeId);
    const job = this.jobs.get(jobId);
    if (!node || !job || job.nodeId !== node.id || job.status !== 'running') return null;
    return { job, node };
  }

  private onNodeToken(s: Socket, m: JobTokenMsg) {
    const r = this.jobFor(s, m?.jobId);
    if (!r || typeof m.token !== 'string') return;
    const { job } = r;
    job.tokens++;
    job.text += m.token;
    job.lastTokenAt = now();
    if (job.tokens % 16 === 0 && !scanText(job.text.slice(-600)).safe) {
      job.sink?.onToken('\n\n' + BLOCKED_MESSAGE);
      this.failJob(job, 'Blocked by safety filter', 'SAFETY');
      return;
    }
    if (job.tokens > job.outputCap + 32) {
      // Node ignored the output cap; stop paying for more.
      this.completeJob(job, r.node, { jobId: job.id, response: job.text, tokensGenerated: job.tokens, doneReason: 'length' });
      return;
    }
    job.sink?.onToken(m.token);
  }

  private onNodeComplete(s: Socket, m: JobCompleteMsg) {
    const r = this.jobFor(s, m?.jobId);
    if (!r) return;
    this.completeJob(r.job, r.node, m);
  }

  private onNodeError(s: Socket, m: JobErrorMsg) {
    const r = this.jobFor(s, m?.jobId);
    if (!r) return;
    if (r.job.canary) {
      recordCanary(r.node.ownerId, r.node.id, 'neutral');
      this.finishJob(r.job);
      return;
    }
    this.failJob(r.job, `Node error: ${String(m.error ?? 'unknown').slice(0, 200)}`, 'NODE_ERROR');
  }

  private completeJob(job: Job, node: NodeRec, m: JobCompleteMsg) {
    const elapsed = Math.max(1, now() - (job.dispatchedAt ?? now()));
    const text = job.text || (typeof m.response === 'string' ? m.response : '');
    const toolCalls = Array.isArray(m.toolCalls) && m.toolCalls.length && job.tools ? m.toolCalls : undefined;

    // ---- canary grading ----
    if (job.canary) {
      const pass = gradeCanary(job.canary, text);
      log(`canary ${pass ? 'PASS' : 'FAIL'} on ${node.id}`);
      const banned = recordCanary(node.ownerId, node.id, pass ? 'pass' : 'fail');
      this.finishJob(job);
      if (banned) this.kick(node, 'failed verification probes');
      return;
    }

    // ---- final safety scan ----
    if (!scanText(text).safe) {
      job.sink?.onToken('\n\n' + BLOCKED_MESSAGE);
      this.failJob(job, 'Blocked by safety filter', 'SAFETY');
      return;
    }

    // The model asked to search: run it and continue the answer in another round.
    if (job.serverTools && Array.isArray(m.toolCalls) && m.toolCalls.length && job.rounds < MAX_TOOL_ROUNDS && job.tokens < job.outputCap) {
      void this.runServerTools(job, node, m.toolCalls);
      return;
    }

    const counted = Math.min(job.tokens, job.outputCap);
    const truncated = m.doneReason === 'length' || job.tokens >= job.outputCap;
    const hold = job.hold!;
    const delivered = counted > 0 || !!toolCalls;

    // Anti-cheat before paying the node.
    let pay = delivered;
    const tps = counted / (elapsed / 1000);
    if (counted >= SPEED_MIN_TOKENS && tps > SPEED_CAP[node.type]) {
      pay = false;
      log(`speed strike on ${node.id}: ${tps.toFixed(0)} tok/s`);
      if (strike(node.ownerId, 'impossible speed')) this.kick(node, 'banned');
    } else if (!toolCalls && !coherent(text)) {
      pay = false;
      log(`coherence strike on ${node.id}`);
      if (strike(node.ownerId, 'incoherent output')) this.kick(node, 'banned');
    }

    let charged = 0;
    if (delivered) {
      charged = settle(hold, textCreditCost(job.inputTokens, counted), job.id);
    } else {
      refund(hold, job.id);
    }
    if (pay && charged > 0) {
      recordEarning({ jobId: job.id, ownerId: node.ownerId, payerId: job.user!.id, hold, charged, tokens: counted });
    }

    // Stats + speed samples
    if (counted >= 50) {
      node.samples = [...node.samples, tps].slice(-5);
      if (node.samples.length >= 3 && node.samples.reduce((a, b) => a + b, 0) / node.samples.length < config.minTokPerSec) {
        this.kick(node, 'sustained speed below minimum');
      }
    }
    node.jobsCompleted++;
    node.tokensGenerated += counted;
    node.jobsSinceCanary++;
    this.totals.jobsCompleted++;
    this.totals.tokensGenerated += counted;
    this.completedDurations = [...this.completedDurations, elapsed].slice(-50);
    node.socket.emit('job:counted', { jobId: job.id, tokensGenerated: counted });

    job.sink?.onComplete({
      response: text,
      usage: { inputTokens: job.inputTokens, outputTokens: counted, credits: charged },
      truncated,
      finishReason: toolCalls ? 'tool_calls' : truncated ? 'length' : 'stop',
      toolCalls,
    });
    this.persistJob(job, node, 'completed', counted, charged);
    this.finishJob(job);

    // Occasionally verify the node with a canary while the network is quiet.
    if (this.queue.length === 0 && (node.jobsSinceCanary >= 15 || Math.random() < 1 / 15)) {
      setTimeout(() => this.sendCanary(node), 250);
    }
  }

  /** End a job without a normal completion: settle what was delivered, refund if nothing was. */
  private failJob(job: Job, error: string, code: ErrorCode) {
    if (job.status === 'done') return;
    const node = job.nodeId ? this.nodes.get(job.nodeId) : undefined;
    if (job.hold) {
      const counted = Math.min(job.tokens, job.outputCap);
      if (counted > 0) {
        // Tokens were delivered: bill for what streamed. Only a user-initiated stop pays the node.
        const charged = settle(job.hold, textCreditCost(job.inputTokens, counted), job.id);
        if (node && code === 'ABORTED' && coherent(job.text)) {
          recordEarning({ jobId: job.id, ownerId: node.ownerId, payerId: job.user!.id, hold: job.hold, charged, tokens: counted });
        }
        this.persistJob(job, node, code === 'ABORTED' ? 'aborted' : 'failed', counted, charged);
      } else {
        refund(job.hold, job.id);
        this.persistJob(job, node, 'failed', 0, 0);
      }
    }
    if (node && job.status === 'running') node.socket.emit('job:cancel', { jobId: job.id });
    if (job.swarmId && job.status === 'running') {
      const ring = this.swarm.rings.get(job.swarmId);
      if (ring) this.swarm.headOf(ring)?.socket.emit('swarm:job_cancel', { jobId: job.id, swarmId: ring.id });
    }
    job.sink?.onError(error, code);
    this.finishJob(job);
  }

  private finishJob(job: Job) {
    if (job.swarmId) {
      const ring = this.swarm.rings.get(job.swarmId);
      if (ring && ring.jobId === job.id) ring.jobId = undefined;
    }
    job.status = 'done';
    job.sink = undefined;
    job.text = '';
    this.jobs.delete(job.id);
    const qi = this.queue.indexOf(job.id);
    if (qi >= 0) this.queue.splice(qi, 1);
    const node = job.nodeId ? this.nodes.get(job.nodeId) : undefined;
    if (node && node.jobId === job.id) {
      node.status = 'idle';
      node.jobId = undefined;
      node.idleSince = now();
      this.emitNodeStatus(node.ownerId);
    }
    setTimeout(() => this.processQueue(), 100);
  }

  private persistJob(job: Job, node: NodeRec | undefined, status: string, outTokens: number, credits: number) {
    if (!job.user) return;
    db.prepare(
      `INSERT OR REPLACE INTO jobs(id, user_id, node_id, node_owner, model, lane, source, status, input_tokens, output_tokens, credits, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(job.id, job.user.id, node?.id ?? null, node?.ownerId ?? null, job.entry.id, job.hold?.lane ?? 'free', job.source, status,
      job.inputTokens, outTokens, credits, job.dispatchedAt ? now() - job.dispatchedAt : null, job.createdAt);
  }

  // ------------------------------------------------------------------ swarm jobs (Current rings)
  private dispatchSwarm(job: Job, ring: Ring) {
    const head = this.swarm.headOf(ring);
    if (!head) return;
    job.status = 'running';
    job.swarmId = ring.id;
    job.nonce = randomBytes(16).toString('hex');
    job.dispatchedAt = now();
    job.lastTokenAt = now();
    ring.jobId = job.id;
    job.sink?.onAssigned?.(ring.id);
    const messages = job.messages.some((m) => m.role === 'system') ? job.messages : [{ role: 'system' as const, content: NATIVE_SYSTEM() }, ...job.messages];
    head.socket.emit('swarm:job', {
      swarmId: ring.id, jobId: job.id, messages, nonce: job.nonce, maxNew: Math.max(1, job.outputCap - job.tokens), reasoning: job.think,
    });
  }

  private swarmJobFor(s: Socket, jobId: string): Job | null {
    const job = this.jobs.get(jobId);
    if (!job || !job.swarmId || job.status !== 'running') return null;
    const ring = this.swarm.rings.get(job.swarmId);
    // Only the ring's coordinator (head) may stream or settle a job.
    if (!ring || this.swarm.headOf(ring)?.socket.id !== s.id) return null;
    return job;
  }

  private onSwarmToken(s: Socket, m: { jobId: string; delta: string }) {
    const job = this.swarmJobFor(s, m?.jobId);
    if (!job || typeof m.delta !== 'string') return;
    if (job.tokens >= job.outputCap + 32) return; // past the cap: stop relaying (and billing)
    job.tokens++;
    job.text += m.delta;
    job.lastTokenAt = now();
    if (job.tokens % 16 === 0 && !scanText(job.text.slice(-600)).safe) {
      job.sink?.onToken('\n\n' + BLOCKED_MESSAGE);
      this.failJob(job, 'Blocked by safety filter', 'SAFETY');
      return;
    }
    job.sink?.onToken(m.delta);
  }

  private async onSwarmComplete(s: Socket, m: { jobId: string; response?: string; tokensGenerated?: number; receipts?: unknown[] }) {
    const job = this.swarmJobFor(s, m?.jobId);
    if (!job) return;
    const ring = this.swarm.rings.get(job.swarmId!)!;
    const text = job.text || (typeof m.response === 'string' ? m.response : '');
    if (!scanText(text).safe) {
      job.sink?.onToken('\n\n' + BLOCKED_MESSAGE);
      this.failJob(job, 'Blocked by safety filter', 'SAFETY');
      return;
    }
    const counted = Math.min(job.tokens, job.outputCap);
    const truncated = job.tokens >= job.outputCap;
    const hold = job.hold!;
    const charged = counted > 0 ? settle(hold, textCreditCost(job.inputTokens, counted), job.id) : (refund(hold, job.id), 0);
    const nonce = job.nonce!;
    const payerId = job.user!.id;
    const ok = coherent(text);

    this.totals.jobsCompleted++;
    this.totals.tokensGenerated += counted;
    job.sink?.onComplete({
      response: text, usage: { inputTokens: job.inputTokens, outputTokens: counted, credits: charged }, truncated,
      finishReason: truncated ? 'length' : 'stop',
    });
    this.persistJob(job, undefined, 'completed', counted, charged);
    this.finishJob(job);

    // Settlement: only a receipt set that proves the whole model ran on this ring pays anyone.
    if (!charged || !ok) return;
    const layerCount = job.entry.swarm!.layerCount;
    const v = await this.swarm.verifyReceipts(ring, job.id, nonce, Array.isArray(m.receipts) ? m.receipts : [], layerCount);
    if (!v.ok) {
      const head = ring.stages.find((x) => x.head)!;
      if (strike(head.ownerId, 'invalid swarm receipts')) this.swarm.dissolve(ring.id, 'coordinator banned');
      return;
    }
    for (const { stage, weight } of v.shares) {
      recordEarning({ jobId: `${job.id}#${stage.index}`, ownerId: stage.ownerId, payerId, hold, charged: charged * weight, tokens: Math.round(counted * weight) });
    }
  }

  private onRingDown(ring: Ring, _why: string) {
    const job = ring.jobId ? this.jobs.get(ring.jobId) : undefined;
    if (!job || job.status !== 'running') return;
    if (job.tokens === 0) {
      job.status = 'queued'; job.swarmId = undefined; job.dispatchedAt = undefined;
      this.queue.unshift(job.id);
      this.processQueue();
    } else {
      this.failJob(job, 'The swarm serving this answer lost a node', 'NODE_GONE');
    }
  }

  swarmView() { return this.swarm.publicView(); }

  // ------------------------------------------------------------------ image lane
  submitImage(req: { principal: Principal; ip: string; params: ImageParams; nsfw: boolean; sink: ImageSink }): { jobId: string } | { error: string; code: ErrorCode } {
    const user = req.principal.user;
    if (user.kind === 'anon') return { error: 'Sign in to create images', code: 'UNAUTHORIZED' };
    if (!req.params.prompt.trim()) return { error: 'Prompt is empty', code: 'BAD_REQUEST' };
    const v = scanImagePrompt(`${req.params.prompt}\n${req.params.negativePrompt ?? ''}`, req.nsfw);
    if (!v.safe) {
      return v.reason === 'nsfw_disabled'
        ? { error: 'This prompt needs the 18+ toggle', code: 'SAFETY' }
        : { error: 'Request blocked by safety filter', code: 'SAFETY' };
    }
    const nodes = [...this.nodes.values()].filter((n) => n.type === 'image');
    if (nodes.length === 0) return { error: 'No image nodes are online right now', code: 'NO_CAPACITY' };
    const r = reserve(user, IMAGE_CREDITS, { viaApiKey: req.principal.kind === 'apikey', ipHash: hashIp(req.ip), hasFreeCapacity: nodes.some((n) => n.accountAgeOk) });
    if ('error' in r) return r;
    const job: ImageJob = {
      id: 'img_' + randomUUID().replace(/-/g, '').slice(0, 20), user, params: req.params, hold: r.hold,
      status: 'queued', createdAt: now(), attempts: 0, sink: req.sink,
    };
    this.imageJobs.set(job.id, job);
    this.imageQueue.push(job.id);
    this.processImageQueue();
    return { jobId: job.id };
  }

  abortImage(jobId: string) {
    const j = this.imageJobs.get(jobId);
    if (j && j.status !== 'done') { j.sink = undefined; this.failImage(j, 'Stopped', 'ABORTED'); }
  }

  private processImageQueue() {
    for (let i = 0; i < this.imageQueue.length; i++) {
      const job = this.imageJobs.get(this.imageQueue[i]);
      if (!job || job.status !== 'queued') { this.imageQueue.splice(i--, 1); continue; }
      const freeLane = job.hold.lane === 'free' || job.hold.subsidyKind === 'free_grant';
      const idle = [...this.nodes.values()].filter((n) => n.type === 'image' && n.status === 'idle' && (!freeLane || n.accountAgeOk));
      if (idle.length === 0) { job.sink?.onQueued?.(i + 1); continue; }
      this.imageQueue.splice(i--, 1);
      const node = idle[Math.floor(Math.random() * idle.length)];
      job.status = 'running'; job.nodeId = node.id; job.dispatchedAt = now(); job.attempts++;
      node.status = 'busy'; node.jobId = job.id;
      const msg: ImageJobMsg = { jobId: job.id, params: job.params };
      node.socket.emit('image:job', msg);
      this.emitNodeStatus(node.ownerId);
    }
  }

  private imageFor(s: Socket, jobId: string) {
    const node = this.nodes.get(s.data.nodeId);
    const job = this.imageJobs.get(jobId);
    if (!node || !job || job.nodeId !== node.id || job.status !== 'running') return null;
    return { node, job };
  }

  private onImageResult(s: Socket, m: ImageResultMsg) {
    const r = this.imageFor(s, m?.jobId);
    if (!r) return;
    const { node, job } = r;
    const png = pngSize(typeof m.image === 'string' ? m.image : '');
    if (!png || png.width !== job.params.width || png.height !== job.params.height) {
      log(`invalid image from ${node.id}: ${png ? `${png.width}x${png.height}` : 'not a PNG'}`);
      if (strike(node.ownerId, 'invalid image')) this.kick(node, 'banned');
      this.failImage(job, 'The node returned an invalid image', 'NODE_ERROR');
      return;
    }
    const charged = settle(job.hold, IMAGE_CREDITS, job.id);
    recordEarning({ jobId: job.id, ownerId: node.ownerId, payerId: job.user.id, hold: job.hold, charged, tokens: 0 });
    node.jobsCompleted++;
    this.totals.jobsCompleted++;
    this.persistImage(job, node, 'completed', charged);
    job.sink?.onDone({ image: m.image, params: job.params, credits: charged });
    this.finishImage(job);
  }

  private onImageFailed(s: Socket, m: ImageFailedMsg) {
    const r = this.imageFor(s, m?.jobId);
    if (r) this.failImage(r.job, `Image node error: ${String(m.error ?? 'unknown').slice(0, 200)}`, 'NODE_ERROR');
  }

  private failImage(job: ImageJob, error: string, code: ErrorCode) {
    if (job.status === 'done') return;
    const node = job.nodeId ? this.nodes.get(job.nodeId) : undefined;
    refund(job.hold, job.id);
    if (node && job.status === 'running') node.socket.emit('image:cancel', { jobId: job.id });
    this.persistImage(job, node, code === 'ABORTED' ? 'aborted' : 'failed', 0);
    job.sink?.onError(error, code);
    this.finishImage(job);
  }

  private finishImage(job: ImageJob) {
    job.status = 'done';
    job.sink = undefined;
    this.imageJobs.delete(job.id);
    const qi = this.imageQueue.indexOf(job.id);
    if (qi >= 0) this.imageQueue.splice(qi, 1);
    const node = job.nodeId ? this.nodes.get(job.nodeId) : undefined;
    if (node && node.jobId === job.id) {
      node.status = 'idle'; node.jobId = undefined; node.idleSince = now();
      this.emitNodeStatus(node.ownerId);
    }
    setTimeout(() => this.processImageQueue(), 50);
  }

  private persistImage(job: ImageJob, node: NodeRec | undefined, status: string, credits: number) {
    db.prepare(
      `INSERT OR REPLACE INTO jobs(id, user_id, node_id, node_owner, model, lane, source, status, input_tokens, output_tokens, credits, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'image', ?, 0, 0, ?, ?, ?)`,
    ).run(job.id, job.user.id, node?.id ?? null, node?.ownerId ?? null, IMAGE_MODEL, job.hold.lane, status, credits,
      job.dispatchedAt ? now() - job.dispatchedAt : null, job.createdAt);
  }

  // ------------------------------------------------------------------ canaries
  private sendCanary(node: NodeRec) {
    if (!this.nodes.has(node.id) || node.status !== 'idle' || this.queue.length > 0) return;
    const entry = [...[resolveModel('tide-max'), resolveModel('tide-lite'), resolveModel('tide-dev')]]
      .map((r) => r?.entry).find((e) => e && nodeServes(e, node.model, node.type));
    if (!entry) return;
    const c = makeCanary();
    const job: Job = {
      id: 'job_' + randomUUID().replace(/-/g, '').slice(0, 20),
      source: 'canary', entry, messages: c.messages, think: false, inputTokens: 0, outputCap: 256, serverTools: false, rounds: 0, roundStart: 0,
      status: 'queued', createdAt: now(), tokens: 0, text: '', canary: c,
    };
    node.jobsSinceCanary = 0;
    node.lastCanaryAt = now();
    this.jobs.set(job.id, job);
    this.dispatch(job, node);
  }

  private canarySweep() {
    if (this.queue.length > 0) return;
    const due = [...this.nodes.values()].find((n) => n.status === 'idle' && now() - n.lastCanaryAt > 300_000 && now() - n.idleSince > 5_000);
    if (due) this.sendCanary(due);
  }

  // ------------------------------------------------------------------ liveness
  private sweep() {
    const t = now();
    for (const ij of [...this.imageJobs.values()]) {
      if (ij.status === 'queued' && t - ij.createdAt > config.queueTimeout) this.failImage(ij, 'Timed out waiting for an image node', 'TIMEOUT');
      else if (ij.status === 'running' && t - (ij.dispatchedAt ?? t) > IMAGE_TIMEOUT) this.failImage(ij, 'The image node took too long', 'TIMEOUT');
    }
    for (const job of [...this.jobs.values()]) {
      if (job.status === 'queued' && t - job.createdAt > config.queueTimeout) {
        this.failJob(job, 'Timed out waiting for a free node', 'TIMEOUT');
      } else if (job.status === 'running') {
        const since = t - (job.dispatchedAt ?? t);
        const ceiling = job.canary ? config.canaryCeiling : config.jobCeiling;
        const stalled = !job.toolBusy && (job.tokens === 0 ? since > config.firstTokenTimeout : t - (job.lastTokenAt ?? t) > config.tokenGapTimeout);
        if (stalled || since > ceiling) {
          if (job.canary) {
            const node = this.nodes.get(job.nodeId!);
            if (node) {
              node.socket.emit('job:cancel', { jobId: job.id });
              if (recordCanary(node.ownerId, node.id, 'fail')) this.kick(node, 'failed verification probes');
            }
            this.finishJob(job);
          } else {
            this.failJob(job, 'The node stopped responding', 'TIMEOUT');
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ stats
  stats(): NetworkStats {
    const nodes = [...this.nodes.values()].filter((n) => n.accountAgeOk || !config.isProd);
    const byModel: Record<string, number> = {};
    for (const n of nodes) {
      const e = [resolveModel('tide-max'), resolveModel('tide-lite'), resolveModel('tide-dev')].map((r) => r?.entry).find((x) => x && nodeServes(x, n.model, n.type));
      if (e) byModel[e.id] = (byModel[e.id] ?? 0) + 1;
      else if (n.type === 'image') byModel[IMAGE_MODEL] = (byModel[IMAGE_MODEL] ?? 0) + 1;
    }
    const speeds = nodes.map((n) => this.speed(n));
    return {
      nodesOnline: nodes.length,
      browserNodes: nodes.filter((n) => n.type === 'browser').length,
      nativeNodes: nodes.filter((n) => n.type === 'native').length,
      imageNodes: nodes.filter((n) => n.type === 'image').length,
      byModel,
      busy: nodes.filter((n) => n.status === 'busy').length,
      queueDepth: this.queue.length + this.imageQueue.length,
      jobsCompleted: this.totals.jobsCompleted,
      tokensGenerated: this.totals.tokensGenerated,
      avgTokPerSec: speeds.length ? +(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1) : 0,
      at: now(),
    };
  }

  modelAvailability(id: string): number {
    const r = resolveModel(id);
    if (r?.entry.swarm) return [...this.swarm.rings.values()].filter((x) => x.model === r.entry.id && x.status === 'ready').length;
    return r ? [...this.nodes.values()].filter((n) => nodeServes(r.entry, n.model, n.type)).length : 0;
  }

  private broadcastStats() { this.io.emit('stats:update', this.stats()); }

  /** Operator view: every live node with its owner and address. */
  adminNodes() {
    return [...this.nodes.values()].map((n) => ({
      nodeId: n.id, ownerId: n.ownerId, ip: n.ip, model: n.model, type: n.type, tools: n.tools, status: n.status,
      tokPerSec: +this.speed(n).toFixed(1), jobsCompleted: n.jobsCompleted, tokensGenerated: n.tokensGenerated,
      connectedAt: n.connectedAt, accountAgeOk: n.accountAgeOk,
    }));
  }

  adminKick(nodeId: string, reason: string): boolean {
    const n = this.nodes.get(nodeId);
    if (!n) return false;
    this.kick(n, reason);
    return true;
  }

  nodesForOwner(ownerId: string): NodeStatus[] {
    return [...this.nodes.values()].filter((n) => n.ownerId === ownerId).map((n) => ({
      nodeId: n.id, model: n.model, type: n.type, status: n.status, tokPerSec: +this.speed(n).toFixed(1),
      jobsCompleted: n.jobsCompleted, tokensGenerated: n.tokensGenerated, connectedAt: n.connectedAt,
    }));
  }

  private emitNodeStatus(ownerId: string, only?: Socket) {
    const payload = this.nodesForOwner(ownerId);
    if (only) only.emit('node:status', payload);
    else this.io.to(`user:${ownerId}`).emit('node:status', payload);
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function clientIp(s: Socket): string {
  const xf = s.handshake.headers['x-forwarded-for'];
  const first = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0]?.trim();
  return first || (s.handshake.headers['x-real-ip'] as string) || s.handshake.address || 'unknown';
}

function pickWeighted<T>(items: T[], weight: (t: T) => number): T {
  const ws = items.map(weight);
  let r = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

/**
 * Drop the oldest non-system turns until the prompt fits. System messages and the newest
 * message are always kept. Returns null if the newest message alone is too long.
 */
export function trimToBudget(messages: ChatMessage[], budget: number): ChatMessage[] | null {
  const cost = (m: ChatMessage) => estimateTokens(m.content) + 4;
  const out = [...messages];
  let total = out.reduce((a, m) => a + cost(m), 0);
  let i = 0;
  while (total > budget && i < out.length - 1) {
    if (out[i].role === 'system') { i++; continue; }
    total -= cost(out[i]);
    out.splice(i, 1);
  }
  // Drop orphaned tool results whose assistant tool-call turn was trimmed.
  while (out.length > 1 && out[0].role === 'tool') out.shift();
  return total > budget ? null : out;
}

const log = (...a: unknown[]) => console.log(`[orch ${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Width/height from a base64 PNG's IHDR chunk, or null if it isn't a PNG. */
export function pngSize(b64: string): { width: number; height: number; bytes: number } | null {
  if (!b64 || b64.length > 16_000_000) return null;
  const head = Buffer.from(b64.slice(0, 64), 'base64');
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47 || head.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), bytes: Math.floor(b64.length * 0.75) };
}
