/**
 * Swarm control plane against Current's real planner and receipt verifier (python subprocesses).
 * Fake nodes stand in for GPUs but sign genuine shard-receipt/1 receipts with ed25519.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket } from 'socket.io-client';

process.env.TIDE_DB = join(mkdtempSync(join(tmpdir(), 'tide-swarm-')), 't.db');
process.env.TIDE_SWARM_PROFILE = JSON.stringify({ n_layers: 24, layer_vram_mb: 2000, kv_mb_per_layer: 100, layer_ms_base: 0.5, reserve_mb: 1000, head_reserve_mb: 2000, tail_reserve_mb: 1000, cap_layers: 12, head_layer_ms_mult: 1.3 });
process.env.TIDE_SWARM_LAYERS = '24';
process.env.SWARM_FORM_DEBOUNCE_MS = '100';

const { createTideServer } = await import('../src/app.ts');
const { announceMessage } = await import('../src/swarm.ts');
const { db } = await import('../src/db.ts');
const { newNodeKey, ReceiptSigner } = await import('../../node/src/receipt.ts');

const server = createTideServer();
await new Promise<void>((r) => server.http.listen(0, '127.0.0.1', () => r()));
const BASE = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
const sockets: Socket[] = [];
after(async () => { sockets.forEach((s) => s.close()); await server.close(); });

const post = (path: string, body: unknown, token?: string) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
const get = (path: string, token: string) => fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<any>);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } };

type Assign = { swarmId: string; lo: number; hi: number; head: boolean; tail: boolean; peers: { nodeId: string; pubkey: string; lo: number; hi: number }[] };
interface FakeNode { s: Socket; key: ReturnType<typeof newNodeKey>; session: string; assign?: Assign; nodeId?: string }
const fleet: FakeNode[] = [];
let tamper = false;

async function fakeNode(name: string, vram: number, subnet: string): Promise<FakeNode> {
  const { token } = await post('/api/auth/dev', { name });
  const { token: nt } = await post('/api/node-tokens', {}, token);
  const s = ioc(BASE, { transports: ['websocket'], auth: { token: nt }, reconnection: false });
  sockets.push(s);
  await new Promise<void>((r) => s.on('connect', () => r()));
  const n: FakeNode = { s, key: newNodeKey(), session: token };
  s.on('swarm:assign', (a: Assign) => { n.assign = a; setTimeout(() => s.emit('swarm:ready', { swarmId: a.swarmId }), 30); });
  s.on('swarm:dissolve', () => { n.assign = undefined; });
  s.on('swarm:probe_peers', ({ peers }) => s.emit('node:rtt', { rttMs: Object.fromEntries(peers.map((p: { nodeId: string }) => [p.nodeId, 5 + Math.random() * 5])) }));
  // The head plays coordinator: stream tokens, then return every stage's signed receipt.
  s.on('swarm:job', async (j: { swarmId: string; jobId: string; nonce: string; maxNew: number }) => {
    const words = 'The ring split the model into three blocks of layers and each block ran on a different machine.'.split(/(?<=\s)/);
    for (const w of words) { await sleep(5); s.emit('swarm:job_token', { jobId: j.jobId, delta: w }); }
    const stages = [...n.assign!.peers].sort((a, b) => a.lo - b.lo);
    const signers = stages.map((p) => {
      const owner = fleet.find((f) => f.key.pubkeyB64 === p.pubkey)!;
      return new ReceiptSigner(owner.key.privateKey, owner.key.pubkeyB64, { swarm_id: j.swarmId, job_id: j.jobId, layer_start: p.lo, layer_end: p.hi, nonce: tamper ? 'stale' : j.nonce });
    });
    for (let c = 0; c < 3; c++) {
      let prev = Buffer.from(`prompt-${c}`);
      signers.forEach((sg, i) => { const out = Buffer.from(`act-${i}-${c}`); sg.observe(prev, out); prev = out; });
    }
    s.emit('swarm:job_complete', { jobId: j.jobId, response: words.join(''), tokensGenerated: words.length, receipts: signers.map((x) => x.finalize()) });
  });
  const sig = sign(null, Buffer.from(announceMessage(s.id!)), n.key.privateKey).toString('base64');
  const ack: any = await s.emitWithAck('node:announce', { model: 'tide-swarm', pubkey: n.key.pubkeyB64, sig, cap: { free_vram_mb: vram, subnet } });
  assert.ok(ack.ok, JSON.stringify(ack));
  n.nodeId = ack.nodeId;
  fleet.push(n);
  return n;
}

function chat(s: Socket, content: string) {
  return new Promise<{ ack: any; text: string; done?: any; error?: any }>((resolve) => {
    const out: { ack: any; text: string; done?: any; error?: any } = { ack: null, text: '' };
    s.on('job:token', (m) => { if (m.jobId === out.ack?.jobId) out.text += m.token; });
    s.once('job:complete', (m) => { out.done = m; resolve(out); });
    s.once('job:error', (m) => { out.error = m; resolve(out); });
    s.emitWithAck('job:submit', { messages: [{ role: 'user', content }], model: 'tide-swarm' }).then((a) => { out.ack = a; if (a.error) resolve(out); });
  });
}

test('announce requires a node token and a valid key signature', async () => {
  const { token } = await post('/api/auth/dev', { name: 'sneaky' });
  const { token: nt } = await post('/api/node-tokens', {}, token);
  const s = ioc(BASE, { transports: ['websocket'], auth: { token: nt }, reconnection: false });
  sockets.push(s);
  await new Promise<void>((r) => s.on('connect', () => r()));
  const k = newNodeKey();
  const bad: any = await s.emitWithAck('node:announce', { model: 'tide-swarm', pubkey: k.pubkeyB64, sig: sign(null, Buffer.from('other'), k.privateKey).toString('base64'), cap: { free_vram_mb: 24000, subnet: '10.9.9' } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /signature/);
  s.close();
});

test('ring forms via shard.plan, serves a job, receipts verify, stages paid by layers', async () => {
  await fakeNode('gpu-a', 24000, '10.0.1');
  await fakeNode('gpu-b', 24000, '10.0.2');
  await fakeNode('gpu-c', 24000, '10.0.3');
  await until(() => server.orch.modelAvailability('tide-swarm') === 1);
  const inRing = fleet.filter((f) => f.assign);
  assert.ok(inRing.length >= 2, 'at least two stages');
  const lay = inRing.map((f) => f.assign!).sort((a, b) => a.lo - b.lo).map((a) => [a.lo, a.hi]);
  for (let i = 1; i < lay.length; i++) assert.equal(lay[i][0], lay[i - 1][1], 'contiguous blocks');
  assert.deepEqual(lay.flat()[0], 0);
  assert.equal(lay.at(-1)![1], 24, `layers tile the model: ${JSON.stringify(lay)}`);

  const { token } = await post('/api/auth/dev', { name: 'swarm-user' });
  await post('/api/credits/dev-add', { amount: 100 }, token);
  db.prepare("UPDATE users SET free_prompts_used = 99 WHERE display_name = 'swarm-user'").run();
  const c = ioc(BASE, { transports: ['websocket'], auth: { token }, reconnection: false });
  sockets.push(c);
  await new Promise<void>((r) => c.on('connect', () => r()));
  const r = await chat(c, 'How does the ring work?');
  assert.ok(r.done, JSON.stringify(r.error ?? r.ack));
  assert.match(r.text, /three blocks of layers/);

  // Settlement runs after completion (python verify); wait for the earnings rows.
  await until(() => (db.prepare("SELECT COUNT(*) n FROM node_earnings WHERE job_id LIKE ?").get(r.ack.jobId + '#%') as { n: number }).n === inRing.length);
  const rows = db.prepare('SELECT user_id, usd FROM node_earnings WHERE job_id LIKE ?').all(r.ack.jobId + '#%') as { user_id: string; usd: number }[];
  const total = rows.reduce((a, x) => a + x.usd, 0);
  assert.ok(Math.abs(total - (r.done.usage.credits / 1000) * 0.7) < 1e-9, `total node pay = 70% of revenue (${total})`);
  for (const f of inRing) {
    const e = await get('/api/earnings', f.session);
    const share = (f.assign!.hi - f.assign!.lo) / 24;
    assert.ok(Math.abs(e.balance.earned - total * share) < 1e-9, `stage [${f.assign!.lo},${f.assign!.hi}) paid by layers`);
  }
  c.close();
});

test('tampered receipts (stale nonce) pay nobody and strike the coordinator', async () => {
  tamper = true;
  const { token } = await post('/api/auth/dev', { name: 'swarm-user' });
  const c = ioc(BASE, { transports: ['websocket'], auth: { token }, reconnection: false });
  sockets.push(c);
  await new Promise<void>((r) => c.on('connect', () => r()));
  const r = await chat(c, 'again?');
  assert.ok(r.done);
  await sleep(1500);
  const n = (db.prepare("SELECT COUNT(*) n FROM node_earnings WHERE job_id LIKE ?").get(r.ack.jobId + '#%') as { n: number }).n;
  assert.equal(n, 0);
  const head = fleet.find((f) => f.assign?.head)!;
  assert.equal((await get('/api/earnings', head.session)).reputation.strikes, 1);
  tamper = false;
  c.close();
});

test('a stage leaving dissolves the ring; the pool re-forms without it', async () => {
  await fakeNode('gpu-d', 24000, '10.0.4');
  const leaver = fleet.find((f) => f.assign && !f.assign.head)!;
  leaver.s.close();
  fleet.splice(fleet.indexOf(leaver), 1);
  await until(() => server.orch.modelAvailability('tide-swarm') === 1 && !fleet.some((f) => f.assign && f.assign.peers.some((p) => p.nodeId === leaver.nodeId)), 10000);
  const ids = new Set(fleet.filter((f) => f.assign).map((f) => f.nodeId));
  assert.ok(!ids.has(leaver.nodeId));
});
