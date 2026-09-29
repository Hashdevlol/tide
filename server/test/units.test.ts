import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIDE_DB = join(mkdtempSync(join(tmpdir(), 'tide-unit-')), 't.db');

const { textCreditCost } = await import('@tide/shared');
const { trimToBudget } = await import('../src/orchestrator.ts');
const { coherent, makeCanary, gradeCanary, stripThink } = await import('../src/anticheat.ts');
const { scanText } = await import('../src/safety.ts');
const { createUser, getUser } = await import('../src/auth.ts');
const billing = await import('../src/billing.ts');
const { db } = await import('../src/db.ts');

test('credit cost: per-token, rounded up, minimum 1', () => {
  assert.equal(textCreditCost(0, 0), 1);
  assert.equal(textCreditCost(1200, 613), 1);           // "typical message"
  assert.equal(textCreditCost(0, 1_000_000), 900);       // $0.90 / M output
  assert.equal(textCreditCost(1_000_000, 0), 150);       // $0.15 / M input
  assert.equal(textCreditCost(1000, 4096), 4);           // hold for a native job
});

test('trimToBudget keeps system + newest, drops oldest turns', () => {
  const big = 'x'.repeat(4000); // ~1000 tokens
  const msgs = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: big },
    { role: 'assistant' as const, content: big },
    { role: 'user' as const, content: 'latest' },
  ];
  const out = trimToBudget(msgs, 1100)!;
  assert.deepEqual(out.map((m) => m.role), ['system', 'assistant', 'user']);
  assert.equal(out.at(-1)!.content, 'latest');
  assert.deepEqual(trimToBudget(msgs, 20)!.map((m) => m.content), ['sys', 'latest']);
  assert.equal(trimToBudget([{ role: 'user', content: 'y'.repeat(100_000) }], 1000), null);
});

test('coherence check', () => {
  assert.equal(coherent('The tide rises because the moon pulls on the ocean.'), true);
  assert.equal(coherent(''), false);
  assert.equal(coherent('<think>only thinking</think>'), false);
  assert.equal(coherent('a'.repeat(200)), false);
  assert.equal(coherent(Array(40).fill('spam').join(' ')), false);
  assert.equal(stripThink('<think>x</think>answer'), 'answer');
});

test('canary grading', () => {
  const c = makeCanary();
  assert.equal(gradeCanary(c, `<think>hmm</think>The answer is ${c.sum}. ${c.nonce}`), true);
  assert.equal(gradeCanary(c, `The answer is ${c.sum + 1}. ${c.nonce}`), false);
  assert.equal(gradeCanary(c, `The answer is ${c.sum}.`), false);
  assert.equal(gradeCanary(c, `${c.sum}1 ${c.nonce}`), false);
});

test('safety floor blocks only minor+sexual content', () => {
  assert.equal(scanText('How do tides work?').safe, true);
  assert.equal(scanText('Write an explicit sex scene between two adults').safe, true);
  assert.equal(scanText('a violent war story with kids in it').safe, true);
  assert.equal(scanText('sexual story about a 12 year old').safe, false);
  assert.equal(scanText('lolicon art').safe, false);
});

test('billing: credits lane holds, settles, refunds', () => {
  const u = createUser('dev', { name: 'bill-a' });
  billing.addCredits(u.id, 100, 'dev');
  // Exhaust the welcome prompts and the free grant so we hit the credits lane.
  db.prepare('UPDATE users SET free_prompts_used = 99 WHERE id = ?').run(u.id);
  const opts = { viaApiKey: true, ipHash: 'x', hasFreeCapacity: true };
  const r = billing.reserve(getUser(u.id)!, 10, opts);
  assert.ok('hold' in r);
  assert.equal(r.hold.lane, 'credits');
  assert.equal(billing.getBalance(u.id), 90);
  assert.equal(billing.settle(r.hold, 3, 'j1'), 3);
  assert.equal(billing.getBalance(u.id), 97);
  billing.refund(r.hold, 'j1'); // idempotent after settle
  assert.equal(billing.getBalance(u.id), 97);

  const r2 = billing.reserve(getUser(u.id)!, 5, opts);
  assert.ok('hold' in r2);
  billing.refund(r2.hold, 'j2');
  assert.equal(billing.getBalance(u.id), 97);

  const r3 = billing.reserve(getUser(u.id)!, 1000, opts);
  assert.ok('error' in r3 && r3.code === 'INSUFFICIENT_CREDITS');
});

test('billing: lanes order — welcome, then grant, then credits; API keys skip free lanes', () => {
  const u = createUser('dev', { name: 'bill-b' });
  const web = { viaApiKey: false, ipHash: 'y', hasFreeCapacity: true };
  const r = billing.reserve(getUser(u.id)!, 2, web);
  assert.ok('hold' in r && r.hold.subsidyKind === 'welcome');
  db.prepare('UPDATE users SET free_prompts_used = 99 WHERE id = ?').run(u.id);
  const g = billing.reserve(getUser(u.id)!, 2, web);
  assert.ok('hold' in g && g.hold.lane === 'grant' && g.hold.subsidyKind === 'free_grant');
  assert.equal(billing.grantState(getUser(u.id)!).used, 2);
  billing.refund(g.hold, 'g');
  assert.equal(billing.grantState(getUser(u.id)!).used, 0);
  const api = billing.reserve(getUser(u.id)!, 2, { ...web, viaApiKey: true });
  assert.ok('error' in api);
});

test('billing: anon session cap and earnings split', () => {
  const anon = createUser('anon');
  const opts = { viaApiKey: false, ipHash: 'anon-ip', hasFreeCapacity: true };
  for (let i = 0; i < 5; i++) assert.ok('hold' in billing.reserve(getUser(anon.id)!, 1, opts));
  const over = billing.reserve(getUser(anon.id)!, 1, opts);
  assert.ok('error' in over && over.code === 'FREE_EXHAUSTED');

  // Paid job: node gets 70%, referrer 5%, the rest is platform revenue.
  const referrer = createUser('dev', { name: 'ref' });
  const payer = createUser('dev', { name: 'payer', ref: getUser(referrer.id)!.referral_code! });
  const owner = createUser('dev', { name: 'owner' });
  billing.addCredits(payer.id, 1000, 'dev');
  db.prepare('UPDATE users SET free_prompts_used = 99 WHERE id = ?').run(payer.id);
  const r = billing.reserve(getUser(payer.id)!, 100, { viaApiKey: true, ipHash: 'p', hasFreeCapacity: true });
  assert.ok('hold' in r);
  const charged = billing.settle(r.hold, 100, 'job-split');
  const before = billing.treasurySummary();
  const usd = billing.recordEarning({ jobId: 'job-split', ownerId: owner.id, payerId: payer.id, hold: r.hold, charged, tokens: 50 });
  assert.ok(Math.abs(usd - 0.07) < 1e-9);
  assert.equal(billing.recordEarning({ jobId: 'job-split', ownerId: owner.id, payerId: payer.id, hold: r.hold, charged, tokens: 50 }), 0, 'paid once');
  assert.ok(Math.abs(billing.nodeBalance(referrer.id).referral - 0.005) < 1e-9);
  const after = billing.treasurySummary();
  assert.ok(Math.abs(after.profit - before.profit - 0.025) < 1e-9);
});

test('payouts: minimum, balance, one in flight', () => {
  const owner = createUser('dev', { name: 'payee' });
  db.prepare('INSERT INTO node_earnings(job_id, user_id, usd, tokens, created_at) VALUES (?, ?, ?, ?, ?)').run('pj', owner.id, 5, 10, Date.now());
  assert.throws(() => billing.createPayout(owner.id, 'addr', 0.5), /Minimum/);
  assert.throws(() => billing.createPayout(owner.id, 'addr', 50), /Insufficient/);
  const id = billing.createPayout(owner.id, 'addr', 3);
  assert.throws(() => billing.createPayout(owner.id, 'addr', 1), /in progress/);
  assert.equal(billing.nodeBalance(owner.id).available, 2);
  billing.finishPayout(id, true, 'sig');
  assert.equal(billing.nodeBalance(owner.id).available, 2);
});
