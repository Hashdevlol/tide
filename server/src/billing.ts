import {
  CREDITS_PER_USD, NODE_SHARE, NODE_SHARE_STAKED, PLANS, REFERRAL_SHARE, type ErrorCode, type Lane, type PlanId,
} from '@tide/shared';
import { db, now, tx, utcDay, utcHour } from './db.ts';
import { config } from './config.ts';
import type { User } from './auth.ts';

/**
 * A credit reservation for one job. Created before dispatch, settled once to the
 * real cost on completion, or refunded in full if nothing was delivered.
 */
export interface Hold {
  userId: string;
  lane: Lane;
  credits: number;          // amount reserved
  subsidized: boolean;      // true when the treasury (not the user) funds the node payout
  subsidyKind?: 'anon' | 'welcome' | 'free_grant' | 'plan';
  day: string;              // UTC day the draw was taken from (grant refunds go back to this day)
  anonIpKey?: string;
  done?: boolean;
}

export type ReserveResult = { hold: Hold } | { error: string; code: ErrorCode };

// ---------- balances ----------
export function getBalance(userId: string): number {
  return (db.prepare('SELECT balance FROM credits WHERE user_id = ?').get(userId) as { balance: number } | undefined)?.balance ?? 0;
}

export function addCredits(userId: string, delta: number, reason: string, ref?: string) {
  tx(() => {
    db.prepare('INSERT INTO credits(user_id, balance) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING').run(userId);
    db.prepare('UPDATE credits SET balance = balance + ? WHERE user_id = ?').run(delta, userId);
    db.prepare('INSERT INTO credit_tx(user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, delta, reason, ref ?? null, now());
  });
}

// ---------- plans / grants ----------
export function activePlan(user: User): PlanId {
  if (user.plan !== 'free' && user.plan_expires && user.plan_expires > now()) return user.plan as PlanId;
  return 'free';
}

export function grantState(user: User) {
  const plan = activePlan(user);
  const total = PLANS[plan].dailyCredits;
  const day = utcDay();
  const used = (db.prepare('SELECT used FROM grant_usage WHERE user_id = ? AND day = ?').get(user.id, day) as { used: number } | undefined)?.used ?? 0;
  const tomorrow = new Date(day + 'T00:00:00Z').getTime() + 86_400_000;
  return { plan, total, used, remaining: Math.max(0, total - used), resetsAt: tomorrow };
}

// ---------- treasury subsidy caps ----------
function subsidySpent() {
  const d = (db.prepare('SELECT usd FROM subsidy_spend WHERE period = ?').get('d:' + utcDay()) as { usd: number } | undefined)?.usd ?? 0;
  const h = (db.prepare('SELECT usd FROM subsidy_spend WHERE period = ?').get('h:' + utcHour()) as { usd: number } | undefined)?.usd ?? 0;
  return { d, h };
}

/** Would a worst-case node payout for this many credits still fit under today's free-subsidy caps? */
export function subsidyRoom(credits: number): boolean {
  const worst = (credits / CREDITS_PER_USD) * NODE_SHARE_STAKED;
  const { d, h } = subsidySpent();
  return d + worst <= config.subsidyDailyCapUsd && h + worst <= config.subsidyHourlyCapUsd;
}

function recordSubsidy(usd: number) {
  for (const p of ['d:' + utcDay(), 'h:' + utcHour()]) {
    db.prepare('INSERT INTO subsidy_spend(period, usd) VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET usd = usd + excluded.usd').run(p, usd);
  }
}

// ---------- anon ----------
export function anonUsage(userId: string, ipHash: string) {
  const sess = (db.prepare('SELECT used FROM anon_usage WHERE key = ?').get('sess:' + userId) as { used: number } | undefined)?.used ?? 0;
  const ip = (db.prepare('SELECT used FROM anon_usage WHERE key = ?').get(`ip:${ipHash}:${utcDay()}`) as { used: number } | undefined)?.used ?? 0;
  return {
    used: sess,
    remaining: Math.max(0, Math.min(config.anonPromptsPerSession - sess, config.anonPromptsPerIpDay - ip)),
    limit: config.anonPromptsPerSession,
  };
}

function bumpAnon(key: string, delta: number) {
  db.prepare('INSERT INTO anon_usage(key, used) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET used = MAX(0, used + excluded.used)').run(key, delta);
}

// ---------- reserve ----------
/**
 * Pick a funding lane and reserve `credits` against it. Lanes, first match wins:
 *   anon      -> free prompts only (session + per-IP caps, treasury subsidy caps)
 *   welcome   -> signed-in Free-plan users get a few lifetime free prompts (web only)
 *   grant     -> today's plan grant (Free grant is treasury-funded and web only)
 *   credits   -> purchased balance
 */
export function reserve(
  user: User,
  credits: number,
  opts: { viaApiKey: boolean; ipHash: string; hasFreeCapacity: boolean },
): ReserveResult {
  return tx((): ReserveResult => {
    const day = utcDay();

    if (user.kind === 'anon') {
      const u = anonUsage(user.id, opts.ipHash);
      if (u.remaining <= 0) return { error: 'Free prompts used up — sign in to keep going', code: 'FREE_EXHAUSTED' };
      if (!subsidyRoom(credits)) return { error: 'Free prompts are paused for today — sign in to continue', code: 'FREE_EXHAUSTED' };
      if (!opts.hasFreeCapacity) return { error: 'No nodes available for free prompts right now', code: 'NO_CAPACITY' };
      const ipKey = `ip:${opts.ipHash}:${day}`;
      bumpAnon('sess:' + user.id, 1);
      bumpAnon(ipKey, 1);
      return { hold: { userId: user.id, lane: 'free', credits, subsidized: true, subsidyKind: 'anon', day, anonIpKey: ipKey } };
    }

    const plan = activePlan(user);

    if (!opts.viaApiKey && plan === 'free' && user.free_prompts_used < config.freePromptLimit && subsidyRoom(credits) && opts.hasFreeCapacity) {
      db.prepare('UPDATE users SET free_prompts_used = free_prompts_used + 1 WHERE id = ?').run(user.id);
      return { hold: { userId: user.id, lane: 'free', credits, subsidized: true, subsidyKind: 'welcome', day } };
    }

    const grantAllowed = plan !== 'free' || (!opts.viaApiKey && subsidyRoom(credits) && opts.hasFreeCapacity);
    if (grantAllowed) {
      const g = grantState(user);
      if (g.remaining >= credits) {
        db.prepare('INSERT INTO grant_usage(user_id, day, used) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET used = used + excluded.used').run(user.id, day, credits);
        return { hold: { userId: user.id, lane: 'grant', credits, subsidized: true, subsidyKind: plan === 'free' ? 'free_grant' : 'plan', day } };
      }
    }

    const bal = getBalance(user.id);
    if (bal < credits) {
      return { error: `Insufficient credits: need ${credits}, have ${bal}`, code: 'INSUFFICIENT_CREDITS' };
    }
    db.prepare('UPDATE credits SET balance = balance - ? WHERE user_id = ?').run(credits, user.id);
    db.prepare('INSERT INTO credit_tx(user_id, delta, reason, created_at) VALUES (?, ?, ?, ?)').run(user.id, -credits, 'job_hold', now());
    return { hold: { userId: user.id, lane: 'credits', credits, subsidized: false, day } };
  });
}

/** Return `amount` credits to whichever lane funded the hold. */
function giveBack(h: Hold, amount: number, ref: string) {
  if (amount <= 0) return;
  if (h.lane === 'credits') {
    db.prepare('UPDATE credits SET balance = balance + ? WHERE user_id = ?').run(amount, h.userId);
    db.prepare('INSERT INTO credit_tx(user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(h.userId, amount, 'job_refund', ref, now());
  } else if (h.lane === 'grant') {
    db.prepare('UPDATE grant_usage SET used = MAX(0, used - ?) WHERE user_id = ? AND day = ?').run(amount, h.userId, h.day);
  }
}

/** Refund everything (nothing delivered). Idempotent. */
export function refund(h: Hold, ref: string) {
  if (h.done) return;
  h.done = true;
  tx(() => {
    if (h.lane === 'free') {
      if (h.subsidyKind === 'anon') {
        bumpAnon('sess:' + h.userId, -1);
        if (h.anonIpKey) bumpAnon(h.anonIpKey, -1);
      } else {
        db.prepare('UPDATE users SET free_prompts_used = MAX(0, free_prompts_used - 1) WHERE id = ?').run(h.userId);
      }
    } else {
      giveBack(h, h.credits, ref);
    }
  });
}

/** Settle to the real cost (never above the hold). Returns credits charged. Idempotent. */
export function settle(h: Hold, actual: number, ref: string): number {
  if (h.done) return 0;
  h.done = true;
  const charged = Math.min(Math.max(1, actual), h.credits);
  tx(() => giveBack(h, h.credits - charged, ref));
  return charged;
}

// ---------- earnings + treasury ----------
export function nodeShareFor(_ownerId: string): number {
  // Staked-boost hook: 0.8 once the owner has >= 500k $TIDE matured stake (phase 2).
  return NODE_SHARE;
}

/**
 * Pay the node owner for a completed job, credit any referrer, and realise the
 * protocol margin into the treasury. Called exactly once per job (UNIQUE job_id).
 */
export function recordEarning(p: {
  jobId: string; ownerId: string; payerId: string; hold: Hold; charged: number; tokens: number;
}): number {
  const { hold, charged } = p;
  // Free lanes never pay a node for serving its own owner's prompts.
  if (hold.subsidized && (hold.subsidyKind === 'anon' || hold.subsidyKind === 'welcome' || hold.subsidyKind === 'free_grant')) {
    if (p.ownerId === p.payerId) return 0;
    if (subsidySpent().d >= config.subsidyDailyCapUsd) return 0;
  }
  const share = nodeShareFor(p.ownerId);
  const usd = (charged / CREDITS_PER_USD) * share;
  return tx(() => {
    const r = db.prepare(
      'INSERT OR IGNORE INTO node_earnings(job_id, user_id, usd, tokens, subsidized, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(p.jobId, p.ownerId, usd, p.tokens, hold.subsidized ? 1 : 0, now());
    if (r.changes === 0) return 0;

    if (hold.subsidized && hold.subsidyKind !== 'plan') recordSubsidy(usd);

    if (!hold.subsidized) {
      const revenue = charged / CREDITS_PER_USD;
      let referral = 0;
      const payer = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(p.payerId) as { referred_by: string | null } | undefined;
      if (payer?.referred_by) {
        referral = revenue * REFERRAL_SHARE;
        db.prepare('INSERT OR IGNORE INTO referral_earnings(job_id, user_id, usd, created_at) VALUES (?, ?, ?, ?)').run(p.jobId, payer.referred_by, referral, now());
      }
      realizeMargin(revenue - usd - referral, p.jobId);
    }
    return usd;
  });
}

function bucketAdd(bucket: string, usd: number, event: string, meta?: string) {
  db.prepare('UPDATE treasury_buckets SET usd = usd + ? WHERE bucket = ?').run(usd, bucket);
  db.prepare('INSERT INTO treasury_ledger(event, bucket, usd, meta, created_at) VALUES (?, ?, ?, ?, ?)').run(event, bucket, usd, meta ?? null, now());
}

/** Margin -> pool (split burn / stakers) and profit. */
export function realizeMargin(margin: number, ref: string) {
  if (margin <= 0) return;
  const pool = margin * config.marginToPoolPct;
  bucketAdd('buyback', pool * config.poolBurnSplit, 'margin', ref);
  bucketAdd('staker_rewards', pool * (1 - config.poolBurnSplit), 'margin', ref);
  if (margin - pool > 0) bucketAdd('profit', margin - pool, 'margin', ref);
}

export function treasurySummary() {
  const rows = db.prepare('SELECT bucket, usd FROM treasury_buckets').all() as { bucket: string; usd: number }[];
  return Object.fromEntries(rows.map((r) => [r.bucket, r.usd]));
}

// ---------- node owner balance / payouts ----------
export function nodeBalance(userId: string) {
  const earned = (db.prepare('SELECT COALESCE(SUM(usd),0) s FROM node_earnings WHERE user_id = ?').get(userId) as { s: number }).s;
  const referral = (db.prepare('SELECT COALESCE(SUM(usd),0) s FROM referral_earnings WHERE user_id = ?').get(userId) as { s: number }).s;
  const paid = (db.prepare("SELECT COALESCE(SUM(usd),0) s FROM payouts WHERE user_id = ? AND status IN ('pending','completed','needs_review')").get(userId) as { s: number }).s;
  const today = (db.prepare('SELECT COALESCE(SUM(usd),0) s FROM node_earnings WHERE user_id = ? AND created_at >= ?').get(userId, new Date(utcDay() + 'T00:00:00Z').getTime()) as { s: number }).s;
  return { earned, referral, paid, today, available: Math.max(0, earned + referral - paid) };
}

export function createPayout(userId: string, address: string, usd: number) {
  return tx(() => {
    usd = Math.floor(usd * 100) / 100;
    if (usd < config.minWithdrawalUsd) throw new Error(`Minimum withdrawal is $${config.minWithdrawalUsd.toFixed(2)}`);
    if (db.prepare("SELECT 1 FROM payouts WHERE user_id = ? AND status = 'pending'").get(userId)) throw new Error('A payout is already in progress');
    if (nodeBalance(userId).available + 1e-9 < usd) throw new Error('Insufficient balance');
    const r = db.prepare("INSERT INTO payouts(user_id, address, usd, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(userId, address, usd, now());
    return Number(r.lastInsertRowid);
  });
}

export function finishPayout(id: number, ok: boolean, txSig?: string) {
  db.prepare('UPDATE payouts SET status = ?, tx = ? WHERE id = ?').run(ok ? 'completed' : 'needs_review', txSig ?? null, id);
}
