/**
 * Integration: a real server on a random port, fake nodes and clients over socket.io,
 * and the OpenAI-compatible HTTP API.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket } from 'socket.io-client';
import type { JobNewMsg } from '@tide/shared';

process.env.TIDE_DB = join(mkdtempSync(join(tmpdir(), 'tide-net-')), 't.db');
process.env.ADMIN_SECRET = 'test-admin-secret-0123456789';
const { createTideServer } = await import('../src/app.ts');
const { db } = await import('../src/db.ts');

const server = createTideServer();
await new Promise<void>((r) => server.http.listen(0, '127.0.0.1', () => r()));
const BASE = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
const sockets: Socket[] = [];
after(async () => { sockets.forEach((s) => s.close()); await server.close(); });

const post = (path: string, body: unknown, token?: string) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
const get = (path: string, token: string) => fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<any>);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(token?: string): Promise<Socket> {
  const s = ioc(BASE, { transports: ['websocket'], auth: { token }, reconnection: false });
  sockets.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}

type Behaviour = (job: JobNewMsg, s: Socket) => Promise<void> | void;

/** An honest toy model: streams words at ~100 tok/s and answers canaries correctly. */
const honest: Behaviour = async (job, s) => {
  const last = job.messages.at(-1)!.content;
  const nums = last.match(/\b\d+\b/g)?.map(Number) ?? [];
  const word = last.match(/\b[A-Z]{4,6}\b/)?.[0];
  const reply = nums.length >= 2 && word ? `${nums[0] + nums[1]} ${word}` : 'Tides are caused by the gravitational pull of the moon and the sun on the oceans of the earth.';
  let text = '';
  for (const w of reply.split(/(?<=\s)/)) { await sleep(10); text += w; s.emit('job:token', { jobId: job.jobId, token: w }); }
  s.emit('job:complete', { jobId: job.jobId, response: text, tokensGenerated: text.split(' ').length });
};

async function makeNode(ownerName: string, behaviour: Behaviour, tokPerSec = 30) {
  const { token } = await post('/api/auth/dev', { name: ownerName });
  const { token: nt } = await post('/api/node-tokens', {}, token);
  const s = await connect(nt);
  const ack: any = await s.emitWithAck('node:register', { model: 'tide-dev', tokPerSec, type: 'native' });
  assert.ok(ack.nodeId, JSON.stringify(ack));
  s.on('job:new', (job: JobNewMsg) => void behaviour(job, s));
  return { s, session: token as string, nodeId: ack.nodeId as string };
}

function chat(s: Socket, content: string, model = 'tide-dev') {
  return new Promise<{ ack: any; tokens: string[]; done?: any; error?: any }>((resolve) => {
    const out: { ack: any; tokens: string[]; done?: any; error?: any } = { ack: null, tokens: [] };
    const onTok = (m: any) => m.jobId === out.ack?.jobId && out.tokens.push(m.token);
    const finish = () => { s.off('job:token', onTok); resolve(out); };
    s.on('job:token', onTok);
    s.once('job:complete', (m) => { out.done = m; finish(); });
    s.once('job:error', (m) => { out.error = m; finish(); });
    s.emitWithAck('job:submit', { messages: [{ role: 'user', content }], model }).then((ack) => {
      out.ack = ack;
      if (ack.error) finish();
    });
  });
}

test('registration rules', async () => {
  const { token } = await post('/api/auth/dev', { name: 'reg' });
  const { token: nt } = await post('/api/node-tokens', {}, token);
  const s = await connect(nt);
  assert.match((await s.emitWithAck('node:register', { model: 'gpt-4', tokPerSec: 50, type: 'native' })).error, /not served/);
  assert.match((await s.emitWithAck('node:register', { model: 'tide-dev', tokPerSec: 1, type: 'native' })).error, /Too slow/);
  const anon = await post('/api/auth/anon', {});
  const a = await connect(anon.token);
  assert.match((await a.emitWithAck('node:register', { model: 'tide-dev', tokPerSec: 50, type: 'native' })).error, /Sign in/);
  s.close(); a.close();
});

test('no nodes -> NO_CAPACITY, nothing charged', async () => {
  const anon = await post('/api/auth/anon', {});
  const c = await connect(anon.token);
  const r = await chat(c, 'hello');
  assert.equal(r.ack.code, 'NO_CAPACITY');
  const me = await get('/api/me', anon.token);
  assert.equal(me.freePrompts.remaining, 5);
});

test('anon chat streams through a node, owner is paid from the subsidy', async () => {
  const node = await makeNode('owner-1', honest);
  const anon = await post('/api/auth/anon', {});
  const c = await connect(anon.token);
  const r = await chat(c, 'What causes tides?');
  assert.equal(r.ack.lane, 'free');
  assert.ok(r.done, JSON.stringify(r.error));
  assert.match(r.tokens.join(''), /moon/);
  assert.equal(r.done.usage.outputTokens, r.tokens.length);
  const me = await get('/api/me', anon.token);
  assert.equal(me.freePrompts.remaining, 4);
  const earn = await get('/api/earnings', node.session);
  assert.equal(earn.totals.jobs, 1);
  assert.ok(earn.balance.earned > 0);
  node.s.close();
  await sleep(50);
});

test('node error before any token -> full refund; disconnect -> requeued to another node', async () => {
  const bad = await makeNode('owner-bad', (job, s) => { s.emit('job:error', { jobId: job.jobId, error: 'CUDA OOM' }); });
  const { token } = await post('/api/auth/dev', { name: 'payer-1' });
  await post('/api/credits/dev-add', { amount: 100 }, token);
  db.prepare("UPDATE users SET free_prompts_used = 99, plan = 'free' WHERE display_name = 'payer-1'").run();
  const { key } = await post('/api/api-keys', {}, token);
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tide-dev', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 503);
  assert.equal((await get('/api/credits', token)).balance, 100);
  bad.s.close();
  await sleep(50);

  // A node that vanishes mid-job before streaming: the job moves to the next node.
  const flaky = await makeNode('owner-flaky', (_job, s) => { s.close(); });
  await sleep(20);
  const good = await makeNode('owner-good', honest);
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tide-dev', messages: [{ role: 'user', content: 'hi' }] }),
  }).then((x) => x.json() as Promise<any>);
  assert.match(r.choices[0].message.content, /moon/, JSON.stringify(r));
  assert.equal(r.usage.credits, 1);
  assert.equal((await get('/api/credits', token)).balance, 99);
  flaky.s.close(); good.s.close();
  await sleep(50);
});

test('streaming API with usage chunk', async () => {
  const node = await makeNode('owner-stream', honest);
  const { token } = await post('/api/auth/dev', { name: 'payer-stream' });
  await post('/api/credits/dev-add', { amount: 50 }, token);
  const { key } = await post('/api/api-keys', {}, token);
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tide-dev', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'tides?' }] }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const body = await res.text();
  const frames = body.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => f.slice(6));
  assert.equal(frames.at(-1), '[DONE]');
  const parsed = frames.slice(0, -1).map((f) => JSON.parse(f));
  assert.equal(parsed[0].choices[0].delta.role, 'assistant');
  assert.equal(parsed.at(-2).choices[0].finish_reason, 'stop');
  assert.ok(parsed.at(-1).usage.completion_tokens > 5);
  const text = parsed.map((p) => p.choices[0]?.delta?.content ?? '').join('');
  assert.match(text, /gravitational/);
  node.s.close();
  await sleep(50);
});

test('cheating nodes: impossible speed earns nothing; failed canaries get banned', async () => {
  const fast = await makeNode('owner-fast', (job, s) => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i} `);
    words.forEach((w) => s.emit('job:token', { jobId: job.jobId, token: w }));
    s.emit('job:complete', { jobId: job.jobId, response: words.join(''), tokensGenerated: 60 });
  });
  const anon = await post('/api/auth/anon', {});
  const c = await connect(anon.token);
  const r = await chat(c, 'hello there');
  assert.ok(r.done);
  const earn = await get('/api/earnings', fast.session);
  assert.equal(earn.totals.jobs, 0, 'speed cheater unpaid');
  assert.equal(earn.reputation.strikes, 1);
  fast.s.close();
  await sleep(50);

  // A node that answers everything with filler fails canaries three times in a row -> banned.
  const liar = await makeNode('owner-liar', (job, s) => {
    const t = 'I am a very real model and this is a real answer to your question.';
    s.emit('job:token', { jobId: job.jobId, token: t });
    s.emit('job:complete', { jobId: job.jobId, response: t, tokensGenerated: 15 });
  });
  const kicked = new Promise((res) => liar.s.once('node:kicked', res));
  const orch = server.orch as any;
  for (let i = 0; i < 3; i++) {
    const n = orch.nodes.get(liar.nodeId);
    if (!n) break;
    orch.sendCanary(n);
    await sleep(100);
  }
  await kicked;
  const again = await liar.s.emitWithAck('node:register', { model: 'tide-dev', tokPerSec: 30, type: 'native' });
  assert.match(again.error, /banned/);

  // An honest node passes.
  const good = await makeNode('owner-canary-ok', honest);
  orch.sendCanary(orch.nodes.get(good.nodeId));
  await sleep(300);
  const row = db.prepare("SELECT passed FROM canary_results WHERE node_id = ?").get(good.nodeId) as { passed: number };
  assert.equal(row.passed, 1);
  good.s.close();
});

test('abort mid-stream bills only what was delivered', async () => {
  const slow = await makeNode('owner-slow', async (job, s) => {
    for (let i = 0; i < 200; i++) { await sleep(5); if (!s.connected) return; s.emit('job:token', { jobId: job.jobId, token: `tok${i} ` }); }
  });
  let cancelled = false;
  slow.s.on('job:cancel', () => { cancelled = true; });
  const { token } = await post('/api/auth/dev', { name: 'payer-abort' });
  await post('/api/credits/dev-add', { amount: 100 }, token);
  db.prepare("UPDATE users SET free_prompts_used = 99 WHERE display_name = 'payer-abort'").run();
  const { key } = await post('/api/api-keys', {}, token);
  const ctl = new AbortController();
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', signal: ctl.signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tide-dev', stream: true, messages: [{ role: 'user', content: 'count' }] }),
  });
  const reader = res.body!.getReader();
  await reader.read(); await reader.read();
  ctl.abort();
  await sleep(200);
  assert.ok(cancelled, 'node told to stop');
  assert.equal((await get('/api/credits', token)).balance, 99);
  slow.s.close();
});

test('chat web_search: node calls the tool, orchestrator searches, answer continues with sources', async () => {
  const { searchProvider } = await import('../src/search.ts');
  searchProvider.run = async (q: string) => [{ title: 'Tide tables', url: 'https://example.com/tides', description: `results for ${q}`, content: 'High tide at 14:05.' }];
  const seen: JobNewMsg[] = [];
  const { token } = await post('/api/auth/dev', { name: 'owner-tools' });
  const { token: nt } = await post('/api/node-tokens', {}, token);
  const s = await connect(nt);
  await s.emitWithAck('node:register', { model: 'tide-dev', tokPerSec: 30, type: 'native', capabilities: { tools: true } });
  s.on('job:new', async (job: JobNewMsg) => {
    seen.push(job);
    if (seen.length === 1) {
      assert.equal((job.tools as any[])?.[0]?.function?.name, 'web_search');
      s.emit('job:token', { jobId: job.jobId, token: 'Let me check. ' });
      s.emit('job:complete', { jobId: job.jobId, response: 'Let me check. ', tokensGenerated: 3, doneReason: 'tool_calls',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"high tide today"}' } }] });
    } else {
      const tool = job.messages.find((m) => m.role === 'tool');
      assert.match(tool!.content, /High tide at 14:05/);
      const words = 'According to example.com high tide today is at 14:05 in the afternoon local time.'.split(/(?<=\s)/);
      for (const w of words) { await sleep(5); s.emit('job:token', { jobId: job.jobId, token: w }); }
      s.emit('job:complete', { jobId: job.jobId, response: words.join(''), tokensGenerated: words.length });
    }
  });
  const anon = await post('/api/auth/anon', {});
  const c = await connect(anon.token);
  const sources: any[] = [];
  let searched = '';
  c.on('job:searching', (m) => { searched = m.query; });
  c.on('job:sources', (m) => sources.push(...m.sources));
  const r = await chat(c, 'When is high tide today?');
  assert.ok(r.done, JSON.stringify(r.error));
  assert.equal(seen.length, 2);
  assert.equal(searched, 'high tide today');
  assert.equal(sources[0].url, 'https://example.com/tides');
  assert.match(r.tokens.join(''), /Let me check\. According to example\.com/);
  assert.ok(r.done.usage.outputTokens >= 10);
  s.close();
});

test('admin console: auth, credits, payout resolution, unban', async () => {
  const H = { 'content-type': 'application/json', 'x-admin-token': process.env.ADMIN_SECRET! };
  const adm = (path: string, body?: unknown) =>
    fetch(BASE + '/api/admin' + path, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H }).then(async (r) => ({ status: r.status, j: await r.json() as any }));
  assert.equal((await fetch(BASE + '/api/admin/overview')).status, 401);
  const ov = await adm('/overview');
  assert.equal(ov.status, 200);
  assert.ok(ov.j.jobsAll.n > 0 && Array.isArray(ov.j.nodes));

  const { token, user } = await post('/api/auth/dev', { name: 'admin-target' });
  assert.equal((await adm('/credits', { userId: user.id, delta: 250, reason: 'support' })).j.balance, 250);
  assert.equal((await adm('/credits', { userId: user.id, delta: -1000 })).status, 400);
  const found = await adm('/users?q=admin-target');
  assert.equal(found.j.users[0].credits, 250);

  // A payout that failed on-chain is released back to the owner's balance.
  db.prepare('INSERT INTO node_earnings(job_id, user_id, usd, tokens, created_at) VALUES (?, ?, ?, ?, ?)').run('adm-j', user.id, 4, 10, Date.now());
  const p = await post('/api/payouts', { address: 'So11111111111111111111111111111111111111112', amount: 3 }, token);
  assert.ok(p.id);
  assert.equal((await get('/api/earnings', token)).balance.available, 1);
  assert.equal((await adm(`/payouts/${p.id}`, { status: 'completed' })).status, 400, 'needs tx');
  assert.equal((await adm(`/payouts/${p.id}`, { status: 'failed' })).j.status, 'failed');
  assert.equal((await get('/api/earnings', token)).balance.available, 4);

  const banned = db.prepare("SELECT user_id FROM node_reputation WHERE banned = 1 LIMIT 1").get() as { user_id: string };
  assert.ok((await adm('/unban', { userId: banned.user_id })).j.unbanned);
  assert.ok((await adm('/audit')).j.rows.length >= 3);
});

test('image lane: generate, bill 10 credits, reject wrong-size PNGs, gate anon + NSFW', async () => {
  const { encodePng } = await import('../../node/src/image.ts');
  let cheat = false;
  const { token: ot } = await post('/api/auth/dev', { name: 'owner-image' });
  const { token: nt } = await post('/api/node-tokens', {}, ot);
  const s = await connect(nt);
  const ack: any = await s.emitWithAck('node:register', { model: 'tide-image', tokPerSec: 0, type: 'image' });
  assert.ok(ack.nodeId, JSON.stringify(ack));
  s.on('image:job', ({ jobId, params }: any) => {
    const w = cheat ? 64 : params.width, h = cheat ? 64 : params.height;
    s.emit('image:result', { jobId, image: encodePng(w, h, new Uint8Array(w * h * 3).fill(120)).toString('base64') });
  });

  const { token } = await post('/api/auth/dev', { name: 'artist' });
  await post('/api/credits/dev-add', { amount: 100 }, token);
  db.prepare("UPDATE users SET free_prompts_used = 99 WHERE display_name = 'artist'").run();
  db.prepare("INSERT INTO grant_usage(user_id, day, used) SELECT id, ?, 1000 FROM users WHERE display_name = 'artist'").run(new Date().toISOString().slice(0, 10));

  const r = await post('/api/images/generate', { prompt: 'a lighthouse at night', width: 640, height: 512, seed: 7 }, token);
  assert.match(r.image, /^data:image\/png;base64,/);
  assert.equal(r.width, 640);
  assert.equal(r.credits_charged, 10);
  assert.equal((await get('/api/credits', token)).balance, 90);

  const { key } = await post('/api/api-keys', {}, token);
  const v1 = await fetch(BASE + '/v1/images/generations', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'waves', size: '512x768' }) }).then((x) => x.json() as Promise<any>);
  assert.ok(v1.data[0].b64_json.length > 100, JSON.stringify(v1).slice(0, 200));
  assert.equal(v1.size, '512x768');
  assert.equal((await get('/api/credits', token)).balance, 80);

  cheat = true;
  const bad = await fetch(BASE + '/api/images/generate', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', width: 512, height: 512 }) });
  assert.equal(bad.status, 503);
  assert.equal((await get('/api/credits', token)).balance, 80, 'refunded');
  assert.equal((await get('/api/earnings', ot)).reputation.strikes, 1);

  const nsfw = await fetch(BASE + '/api/images/generate', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a nude figure study' }) });
  assert.equal(nsfw.status, 400);
  const anon = await post('/api/auth/anon', {});
  const a = await fetch(BASE + '/api/images/generate', { method: 'POST', headers: { authorization: `Bearer ${anon.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'waves' }) });
  assert.equal(a.status, 403);
  s.close();
});
