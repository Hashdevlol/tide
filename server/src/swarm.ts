/**
 * Swarms: one large model split across several nodes by Current (tide/current, the shard fork).
 *
 *   node:announce  -> candidate pool (pubkey proven by signature)
 *   node:rtt       -> latency matrix
 *   auto-form      -> `python -m shard.plan` picks stages + contiguous layer blocks
 *   swarm:assign   -> each node pulls its layers, starts its stage; head also runs the coordinator
 *   swarm:ready    -> once every stage is up the ring serves jobs (see Orchestrator)
 *   settlement     -> `python -m shard.verify` checks signed receipts; nodes are paid by layers held
 *
 * The heavy lifting (placement math, receipt verification) is Current's own code, called as
 * JSON-in/JSON-out subprocesses so the control plane and the engine stay in lockstep.
 */
import { spawn } from 'node:child_process';
import { createPublicKey, randomBytes, randomUUID, verify as edVerify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Socket } from 'socket.io';
import type { ModelEntry } from './models.ts';

const env = process.env;
export const currentDir = resolve(env.CURRENT_DIR ?? '../current');
const venvPy = [resolve(currentDir, '.venv/Scripts/python.exe'), resolve(currentDir, '.venv/bin/python')].find((p) => existsSync(p));
export const currentPython = env.CURRENT_PYTHON ?? venvPy ?? (process.platform === 'win32' ? 'python' : 'python3');

const FORM_DEBOUNCE_MS = Number(env.SWARM_FORM_DEBOUNCE_MS) || 3000;
const DEFAULT_RTT_MS = 30;
const RTT_TTL_MS = 10 * 60_000;
const MIN_FREE_VRAM_MB = Number(env.SWARM_MIN_VRAM_MB ?? 8000);
const PULL_TIMEOUT_MS = 60 * 60_000;

/** Run a Current CLI module: one JSON object on stdin, one JSON object on stdout. */
export function runCurrent<T = any>(module: string, input: unknown, timeoutMs = 30_000): Promise<{ code: number; out: T | null; err: string }> {
  return new Promise((res) => {
    const p = spawn(currentPython, ['-m', module], { cwd: currentDir, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(t); res({ code: -1, out: null, err: e.message }); });
    p.on('close', (code) => {
      clearTimeout(t);
      let parsed: T | null = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop() || 'null'); } catch { /* keep null */ }
      res({ code: code ?? -1, out: parsed, err: err.slice(-2000) });
    });
    p.stdin.end(JSON.stringify(input));
  });
}

// ------------------------------------------------------------------ types

export interface NodeCap {
  free_vram_mb: number;
  subnet: string;
  cpu_factor?: number;
  up_mbps?: number;
  layer_vram_mb?: number;
  cap_layers?: number;
  total_vram_mb?: number;
  layer_ms?: number;
  gpu?: string;
}

export interface AnnouncePayload { model: string; pubkey: string; sig: string; cap: NodeCap; addrs?: string[] }

interface Candidate {
  id: string;
  socket: Socket;
  ownerId: string;
  pubkey: string;          // base64 raw ed25519
  model: string;
  cap: NodeCap;
  addrs: string[];
  rtt: Map<string, { ms: number; at: number }>;
  ringId?: string;
  joinedAt: number;
}

export interface Stage { nodeId: string; ownerId: string; pubkey: string; index: number; lo: number; hi: number; head: boolean; tail: boolean }

export interface Ring {
  id: string;
  model: string;
  token: string;
  stages: Stage[];
  status: 'pulling' | 'ready' | 'degraded' | 'failed';
  ready: Set<string>;
  jobId?: string;
  createdAt: number;
  plan: { step_ms?: number; tok_s_per_g?: number };
}

export interface SwarmModel { profile: string | Record<string, number>; layerCount: number; manifestRef: string }

export function swarmModelOf(e: ModelEntry): SwarmModel | undefined {
  return e.swarm;
}

// ------------------------------------------------------------------ manager

export class SwarmManager {
  candidates = new Map<string, Candidate>();
  rings = new Map<string, Ring>();
  private formTimers = new Map<string, NodeJS.Timeout>();
  private forming = new Set<string>();

  constructor(
    private models: () => ModelEntry[],
    private hooks: { onRingReady(ring: Ring): void; onRingDown(ring: Ring, why: string): void; changed(): void },
  ) {}

  private model(id: string) { return this.models().find((m) => m.id === id && m.swarm); }

  announce(socket: Socket, ownerId: string, p: AnnouncePayload): { ok: true; nodeId: string } | { ok: false; reason: string } {
    const entry = this.model(String(p?.model ?? ''));
    if (!entry) return { ok: false, reason: `"${p?.model}" is not a swarm model` };
    const cap = p?.cap;
    if (!cap || !(Number(cap.free_vram_mb) >= MIN_FREE_VRAM_MB) || typeof cap.subnet !== 'string' || !cap.subnet) {
      return { ok: false, reason: `need a subnet and at least ${MIN_FREE_VRAM_MB} MB free VRAM` };
    }
    if (!verifyAnnounce(p.pubkey, p.sig, socket.id)) return { ok: false, reason: 'pubkey signature check failed' };
    // Re-announce (same socket or same key) replaces the old entry.
    for (const c of [...this.candidates.values()]) {
      if (c.socket.id === socket.id || c.pubkey === p.pubkey) this.drop(c.id, 're-announced');
    }
    const c: Candidate = {
      id: 's_' + randomUUID().slice(0, 12), socket, ownerId, pubkey: p.pubkey, model: entry.id,
      cap: sanitizeCap(cap), addrs: Array.isArray(p.addrs) ? p.addrs.slice(0, 8).map(String) : [], rtt: new Map(), joinedAt: Date.now(),
    };
    this.candidates.set(c.id, c);
    socket.data.swarmNodeId = c.id;
    // Ask everyone in this model's pool to measure latency to each other.
    this.requestProbes(entry.id);
    this.scheduleForm(entry.id);
    this.hooks.changed();
    return { ok: true, nodeId: c.id };
  }

  recordRtt(nodeId: string, rttMs: Record<string, number>) {
    const c = this.candidates.get(nodeId);
    if (!c || !rttMs || typeof rttMs !== 'object') return;
    for (const [peer, ms] of Object.entries(rttMs)) {
      const v = Number(ms);
      if (this.candidates.has(peer) && v >= 0.05 && v <= 2000) c.rtt.set(peer, { ms: v, at: Date.now() });
    }
  }

  private requestProbes(model: string) {
    const pool = [...this.candidates.values()].filter((c) => c.model === model);
    for (const c of pool) {
      c.socket.emit('swarm:probe_peers', { model, peers: pool.filter((o) => o.id !== c.id).slice(0, 16).map((o) => ({ nodeId: o.id, addrs: o.addrs })) });
    }
  }

  private scheduleForm(model: string) {
    clearTimeout(this.formTimers.get(model));
    this.formTimers.set(model, setTimeout(() => void this.form(model), FORM_DEBOUNCE_MS));
  }

  /** Try to build a ring from the free candidates of `model`. */
  async form(model: string): Promise<Ring | null> {
    const entry = this.model(model);
    if (!entry || this.forming.has(model)) return null;
    if ([...this.rings.values()].some((r) => r.model === model && r.status === 'pulling')) return null;
    const pool = [...this.candidates.values()].filter((c) => c.model === model && !c.ringId);
    if (pool.length < 2) return null;
    this.forming.add(model);
    try {
      const now = Date.now();
      const rtt = pool.map((a) => pool.map((b) => {
        if (a.id === b.id) return 0;
        const ab = a.rtt.get(b.id), ba = b.rtt.get(a.id);
        const fresh = [ab, ba].filter((x) => x && now - x.at < RTT_TTL_MS).map((x) => x!.ms);
        return fresh.length ? Math.max(...fresh) : DEFAULT_RTT_MS;
      }));
      const req = { nodes: pool.map((c) => ({ id: c.id, ...c.cap })), rtt, model: entry.swarm!.profile };
      const r = await runCurrent<{ order: string[]; stages: { id: string; index: number; lo: number; hi: number; head: boolean; tail: boolean }[]; step_ms: number; tok_s_per_g: number } | null>('shard.plan', req);
      if (r.code !== 0) { log(`plan failed (${r.code}): ${JSON.stringify(r.out) ?? ''} ${r.err.slice(-300)}`); return null; }
      if (!r.out) { log(`pool of ${pool.length} for ${model} can't hold the model yet`); return null; }
      // Re-check the pool: nodes may have left while the planner ran.
      const stages = r.out.stages.map((s) => ({ s, c: this.candidates.get(s.id) }));
      if (stages.some((x) => !x.c || x.c.ringId)) { this.scheduleForm(model); return null; }
      const ring: Ring = {
        id: 'sw_' + randomUUID().slice(0, 10), model, token: randomBytes(24).toString('base64url'), status: 'pulling', ready: new Set(), createdAt: now,
        plan: { step_ms: r.out.step_ms, tok_s_per_g: r.out.tok_s_per_g },
        stages: stages.map(({ s, c }) => ({ nodeId: c!.id, ownerId: c!.ownerId, pubkey: c!.pubkey, index: s.index, lo: s.lo, hi: s.hi, head: s.head, tail: s.tail })),
      };
      this.rings.set(ring.id, ring);
      const peers = ring.stages.map((s) => ({ nodeId: s.nodeId, pubkey: s.pubkey, index: s.index, lo: s.lo, hi: s.hi, addrs: this.candidates.get(s.nodeId)!.addrs }));
      const head = ring.stages.find((s) => s.head)!;
      for (const s of ring.stages) {
        const c = this.candidates.get(s.nodeId)!;
        c.ringId = ring.id;
        c.socket.emit('swarm:assign', {
          swarmId: ring.id, model, manifestRef: entry.swarm!.manifestRef, layerCount: entry.swarm!.layerCount,
          stageIndex: s.index, nstages: ring.stages.length, lo: s.lo, hi: s.hi, head: s.head, tail: s.tail,
          role: s.head ? 'coordinator' : 'stage', coordinatorNodeId: head.nodeId, swarmToken: ring.token, peers,
        });
      }
      log(`ring ${ring.id} formed for ${model}: ${ring.stages.map((s) => `${s.nodeId}[${s.lo},${s.hi})`).join(' → ')} ~${r.out.tok_s_per_g} tok/s`);
      this.hooks.changed();
      return ring;
    } finally {
      this.forming.delete(model);
    }
  }

  markReady(nodeId: string, swarmId: string) {
    const ring = this.rings.get(swarmId);
    if (!ring || ring.status !== 'pulling' || !ring.stages.some((s) => s.nodeId === nodeId)) return;
    ring.ready.add(nodeId);
    if (ring.ready.size === ring.stages.length) {
      ring.status = 'ready';
      for (const s of ring.stages) this.candidates.get(s.nodeId)?.socket.emit('swarm:ring_ready', { swarmId });
      log(`ring ${ring.id} ready`);
      this.hooks.onRingReady(ring);
      this.hooks.changed();
    }
  }

  /** A node left: its ring can't serve any more. Free the survivors and try to re-form. */
  drop(nodeId: string | undefined, why: string) {
    if (!nodeId) return;
    const c = this.candidates.get(nodeId);
    if (!c) return;
    this.candidates.delete(nodeId);
    c.socket.data.swarmNodeId = undefined;
    if (c.ringId) this.dissolve(c.ringId, `node ${nodeId} ${why}`);
    this.scheduleForm(c.model);
    this.hooks.changed();
  }

  dissolve(ringId: string, why: string) {
    const ring = this.rings.get(ringId);
    if (!ring) return;
    ring.status = 'degraded';
    this.rings.delete(ringId);
    for (const s of ring.stages) {
      const c = this.candidates.get(s.nodeId);
      if (c && c.ringId === ringId) { c.ringId = undefined; c.socket.emit('swarm:dissolve', { swarmId: ringId, reason: why }); }
    }
    log(`ring ${ringId} dissolved: ${why}`);
    this.hooks.onRingDown(ring, why);
    this.scheduleForm(ring.model);
  }

  sweep() {
    for (const r of [...this.rings.values()]) {
      if (r.status === 'pulling' && Date.now() - r.createdAt > PULL_TIMEOUT_MS) this.dissolve(r.id, 'pull timed out');
    }
    for (const m of new Set([...this.candidates.values()].map((c) => c.model))) this.requestProbes(m);
  }

  idleRing(model: string): Ring | undefined {
    return [...this.rings.values()].find((r) => r.model === model && r.status === 'ready' && !r.jobId);
  }
  hasReadyRing(model: string) { return [...this.rings.values()].some((r) => r.model === model && r.status === 'ready'); }
  headOf(ring: Ring) { return this.candidates.get(ring.stages.find((s) => s.head)!.nodeId); }
  ringForSocket(socket: Socket) { const c = this.candidates.get(socket.data.swarmNodeId); return c?.ringId ? this.rings.get(c.ringId) : undefined; }
  nodeIdForSocket(socket: Socket): string | undefined { return socket.data.swarmNodeId; }

  /**
   * Verify a finished job's receipts with Current. Returns each stage's share of the work
   * (by layers held) when the receipt set proves the whole model ran on the assigned ring.
   */
  async verifyReceipts(ring: Ring, jobId: string, nonce: string, receipts: unknown[], layerCount: number) {
    const assignments = Object.fromEntries(ring.stages.map((s) => [s.pubkey, [s.lo, s.hi]]));
    const r = await runCurrent<{ ok: boolean; error?: string }>('shard.verify', {
      receipts, layer_count: layerCount, mode: 'payment', assignments, expected_nonce: nonce, check_chain: env.SWARM_CHECK_CHAIN === '1',
    });
    const ok = r.code === 0 && !!r.out?.ok;
    if (!ok) log(`receipts rejected for ${jobId}: ${r.out?.error ?? r.err.slice(-200)}`);
    return { ok, error: r.out?.error, shares: ok ? ring.stages.map((s) => ({ stage: s, weight: (s.hi - s.lo) / layerCount })) : [] };
  }

  publicView() {
    return {
      candidates: [...this.candidates.values()].map((c) => ({ nodeId: c.id, model: c.model, gpu: c.cap.gpu, vramGb: Math.round(c.cap.free_vram_mb / 1024), ring: c.ringId ?? null })),
      rings: [...this.rings.values()].map((r) => ({ swarmId: r.id, model: r.model, status: r.status, busy: !!r.jobId, stages: r.stages.map((s) => ({ nodeId: s.nodeId, lo: s.lo, hi: s.hi, head: s.head })), tokS: r.plan.tok_s_per_g })),
    };
  }
}

function sanitizeCap(c: NodeCap): NodeCap {
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const out: NodeCap = { free_vram_mb: Number(c.free_vram_mb), subnet: String(c.subnet).slice(0, 64) };
  for (const k of ['cpu_factor', 'up_mbps', 'layer_vram_mb', 'cap_layers', 'total_vram_mb', 'layer_ms'] as const) {
    const v = n(c[k]);
    if (v !== undefined) out[k] = v;
  }
  if (c.gpu) out.gpu = String(c.gpu).slice(0, 64);
  return out;
}

/** The node proves it holds the key it announces by signing a message bound to this socket. */
export const announceMessage = (socketId: string) => `tide-swarm-announce:${socketId}`;
function verifyAnnounce(pubkeyB64: string, sigB64: string, socketId: string): boolean {
  try {
    const raw = Buffer.from(String(pubkeyB64), 'base64');
    const sig = Buffer.from(String(sigB64), 'base64');
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(announceMessage(socketId)), key, sig);
  } catch {
    return false;
  }
}

const log = (...a: unknown[]) => console.log(`[swarm ${new Date().toISOString().slice(11, 19)}]`, ...a);
