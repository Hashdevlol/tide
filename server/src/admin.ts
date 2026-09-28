/**
 * Operator console API. Every route requires header `x-admin-token: $ADMIN_SECRET`.
 * Disabled entirely when ADMIN_SECRET is unset (or shorter than 16 chars).
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { db, now, tx, utcDay, utcHour } from './db.ts';
import { addCredits, getBalance, nodeBalance, treasurySummary } from './billing.ts';
import { getUser } from './auth.ts';
import type { Orchestrator } from './orchestrator.ts';

const secret = () => process.env.ADMIN_SECRET ?? '';

function guard(req: Request, res: Response, next: NextFunction) {
  const s = secret();
  const got = String(req.headers['x-admin-token'] ?? '');
  if (s.length < 16) return res.status(404).json({ error: 'Admin console disabled (set ADMIN_SECRET, 16+ chars)' });
  if (got.length !== s.length || !timingSafeEqual(Buffer.from(got), Buffer.from(s))) return res.status(401).json({ error: 'Bad admin token' });
  next();
}

const one = <T>(sql: string, ...a: (string | number | null)[]) => db.prepare(sql).get(...a) as T;

export function createAdmin(orch: Orchestrator) {
  const r = express.Router();
  r.use(express.json());
  r.use(guard);

  r.get('/overview', (_req, res) => {
    const dayStart = new Date(utcDay() + 'T00:00:00Z').getTime();
    const users = db.prepare('SELECT kind, COUNT(*) n FROM users GROUP BY kind').all();
    const jobsToday = one<{ n: number; t: number; c: number }>(
      "SELECT COUNT(*) n, COALESCE(SUM(output_tokens),0) t, COALESCE(SUM(credits),0) c FROM jobs WHERE created_at >= ?", dayStart);
    const jobsAll = one<{ n: number; t: number; c: number }>("SELECT COUNT(*) n, COALESCE(SUM(output_tokens),0) t, COALESCE(SUM(credits),0) c FROM jobs");
    const paidCreditsToday = one<{ c: number }>("SELECT COALESCE(SUM(credits),0) c FROM jobs WHERE created_at >= ? AND lane = 'credits'", dayStart).c;
    const earned = one<{ s: number }>('SELECT COALESCE(SUM(usd),0) s FROM node_earnings').s;
    const referral = one<{ s: number }>('SELECT COALESCE(SUM(usd),0) s FROM referral_earnings').s;
    const paidOut = one<{ s: number }>("SELECT COALESCE(SUM(usd),0) s FROM payouts WHERE status IN ('pending','completed','needs_review')").s;
    const payouts = db.prepare('SELECT status, COUNT(*) n, COALESCE(SUM(usd),0) usd FROM payouts GROUP BY status').all();
    const creditsOutstanding = one<{ s: number }>('SELECT COALESCE(SUM(balance),0) s FROM credits').s;
    const subsidy = {
      today: one<{ usd: number } | undefined>('SELECT usd FROM subsidy_spend WHERE period = ?', 'd:' + utcDay())?.usd ?? 0,
      hour: one<{ usd: number } | undefined>('SELECT usd FROM subsidy_spend WHERE period = ?', 'h:' + utcHour())?.usd ?? 0,
    };
    res.json({
      users, jobsToday, jobsAll, paidCreditsToday, subsidy,
      liabilities: { nodeOwed: Math.max(0, earned + referral - paidOut), creditsOutstanding },
      payouts, treasury: treasurySummary(), network: orch.stats(), nodes: orch.adminNodes(),
    });
  });

  r.get('/users', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const like = `%${q}%`;
    const rows = db.prepare(
      `SELECT u.id, u.kind, u.wallet, u.display_name, u.plan, u.plan_expires, u.created_at, c.balance credits,
              (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id) jobs,
              (SELECT COALESCE(SUM(usd),0) FROM node_earnings e WHERE e.user_id = u.id) earned,
              r.strikes, r.banned
         FROM users u LEFT JOIN credits c ON c.user_id = u.id LEFT JOIN node_reputation r ON r.user_id = u.id
        WHERE (? = '' OR u.id LIKE ? OR u.wallet LIKE ? OR u.display_name LIKE ?) AND u.kind != 'anon'
        ORDER BY u.created_at DESC LIMIT 100`,
    ).all(q, like, like, like);
    res.json({ users: rows });
  });

  r.get('/users/:id', (req, res) => {
    const u = getUser(String(req.params.id));
    if (!u) return res.status(404).json({ error: 'No such user' });
    res.json({
      user: u, credits: getBalance(u.id), node: nodeBalance(u.id),
      transactions: db.prepare('SELECT delta, reason, ref, created_at FROM credit_tx WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(u.id),
      payouts: db.prepare('SELECT * FROM payouts WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id),
      reputation: db.prepare('SELECT * FROM node_reputation WHERE user_id = ?').get(u.id) ?? null,
      canaries: db.prepare('SELECT passed, created_at FROM canary_results WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id),
      liveNodes: orch.nodesForOwner(u.id),
    });
  });

  r.post('/credits', (req, res) => {
    const { userId, delta, reason } = req.body ?? {};
    const d = Math.trunc(Number(delta));
    if (!getUser(String(userId)) || !d) return res.status(400).json({ error: 'userId and non-zero integer delta required' });
    if (getBalance(userId) + d < 0) return res.status(400).json({ error: 'Balance would go negative' });
    addCredits(userId, d, 'admin', String(reason ?? '').slice(0, 120) || undefined);
    audit('credits', { userId, delta: d, reason });
    res.json({ balance: getBalance(userId) });
  });

  r.get('/reputation', (_req, res) => {
    res.json({
      rows: db.prepare(
        `SELECT r.*, u.display_name, u.wallet,
                (SELECT COUNT(*) FROM canary_results c WHERE c.user_id = r.user_id AND passed = 1) canary_pass,
                (SELECT COUNT(*) FROM canary_results c WHERE c.user_id = r.user_id AND passed = 0) canary_fail
           FROM node_reputation r LEFT JOIN users u ON u.id = r.user_id
          ORDER BY r.banned DESC, r.strikes DESC LIMIT 200`,
      ).all(),
    });
  });

  r.post('/unban', (req, res) => {
    const id = String(req.body?.userId ?? '');
    const c = db.prepare('UPDATE node_reputation SET banned = 0, ban_reason = NULL, strikes = 0, updated_at = ? WHERE user_id = ?').run(now(), id);
    // Clear the canary window too, otherwise the very next failed probe re-bans on the old history.
    db.prepare('DELETE FROM canary_results WHERE user_id = ?').run(id);
    audit('unban', { userId: id });
    res.json({ unbanned: c.changes > 0 });
  });

  r.post('/kick', (req, res) => {
    const ok = orch.adminKick(String(req.body?.nodeId ?? ''), String(req.body?.reason ?? 'removed by operator'));
    audit('kick', req.body);
    res.json({ kicked: ok });
  });

  r.get('/payouts', (req, res) => {
    const status = String(req.query.status ?? '');
    const rows = db.prepare(
      `SELECT p.*, u.display_name, u.wallet FROM payouts p LEFT JOIN users u ON u.id = p.user_id
        WHERE (? = '' OR p.status = ?) ORDER BY p.id DESC LIMIT 200`,
    ).all(status, status);
    res.json({ payouts: rows });
  });

  /**
   * Resolve a payout. 'completed' needs the tx signature you verified on-chain; 'failed' releases the
   * amount back to the owner's withdrawable balance (only do this once you are sure nothing was sent).
   */
  r.post('/payouts/:id', (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status ?? '');
    if (!['completed', 'failed', 'needs_review'].includes(status)) return res.status(400).json({ error: 'status must be completed | failed | needs_review' });
    if (status === 'completed' && !req.body?.tx) return res.status(400).json({ error: 'tx signature required to mark completed' });
    const r2 = tx(() => {
      const row = db.prepare('SELECT status FROM payouts WHERE id = ?').get(id) as { status: string } | undefined;
      if (!row) return null;
      if (row.status === 'completed') throw new Error('Already completed');
      db.prepare('UPDATE payouts SET status = ?, tx = COALESCE(?, tx) WHERE id = ?').run(status, req.body?.tx ?? null, id);
      return status;
    });
    if (!r2) return res.status(404).json({ error: 'No such payout' });
    audit('payout', { id, status, tx: req.body?.tx });
    res.json({ id, status: r2 });
  });

  r.get('/audit', (_req, res) => {
    res.json({ rows: db.prepare("SELECT event, usd, meta, created_at FROM treasury_ledger WHERE event LIKE 'admin:%' ORDER BY id DESC LIMIT 100").all() });
  });

  r.use((err: Error, _req: Request, res: Response, _next: NextFunction) => res.status(400).json({ error: err.message }));
  return r;
}

function audit(action: string, meta: unknown) {
  db.prepare('INSERT INTO treasury_ledger(event, bucket, usd, meta, created_at) VALUES (?, NULL, 0, ?, ?)').run(`admin:${action}`, JSON.stringify(meta ?? {}), now());
}
