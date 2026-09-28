import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import {
  CREDITS_PER_USD, CREDITS_PER_USD_PURCHASED, PLANS, PRICE_IN_PER_M_USD, PRICE_OUT_PER_M_USD,
  type ChatMessage, type ErrorCode, type PlanId,
  IMAGE_CREDITS, IMAGE_MODEL, normalizeImageParams, type ImageParams,
} from '@tide/shared';
import { db, now, utcDay } from './db.ts';
import { config } from './config.ts';
import {
  createApiKey, createNodeToken, createSession, createUser, findOrCreateWalletUser, getUser, hashIp, resolveToken,
  revokeSession, signInMessage, verifyWalletSignIn, walletNonce, type Principal,
} from './auth.ts';
import {
  activePlan, addCredits, anonUsage, createPayout, getBalance, grantState, nodeBalance, subsidyRoom, treasurySummary,
} from './billing.ts';
import { publicCatalog, resolveModel } from './models.ts';
import type { Orchestrator } from './orchestrator.ts';
import {
  checkDeposit, createIntent, explorerTx, finishPayoutOnchain, getOrCreateDepositWallet, openIntent, releaseIntent, solanaConfig, solanaEnabled,
} from './solana.ts';
import * as staking from './staking.ts';
import { createAdmin } from './admin.ts';

type AuthedReq = Request & { principal?: Principal };

const ipOf = (req: Request) =>
  (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

function auth(required: boolean, kinds: Principal['kind'][] = ['session']) {
  return (req: AuthedReq, res: Response, next: NextFunction) => {
    const p = resolveToken(req.headers.authorization);
    if (p && kinds.includes(p.kind)) req.principal = p;
    if (required && !req.principal) return res.status(401).json({ error: { message: 'Unauthorized', type: 'invalid_request_error', code: 'unauthorized' } });
    next();
  };
}
const session = auth(true);
const signedIn = (req: AuthedReq, res: Response, next: NextFunction) =>
  req.principal!.user.kind === 'anon' ? res.status(403).json({ error: 'Sign in with a wallet first' }) : next();

/** Tiny fixed-window limiter keyed by string. */
function limiter(perWindow: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const t = now();
    const h = hits.get(key);
    if (!h || h.reset < t) { hits.set(key, { n: 1, reset: t + windowMs }); return true; }
    h.n++;
    return h.n <= perWindow;
  };
}

export function createApi(orch: Orchestrator) {
  const app = express.Router();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/stats', (_req, res) => res.json(orch.stats()));
  app.get('/api/swarm', (_req, res) => res.json(orch.swarmView()));

  // ------------------------------------------------------------------ auth
  const anonLimit = limiter(20, 3600_000);
  app.post('/api/auth/anon', (req, res) => {
    const existing = resolveToken(req.body?.token);
    const ipHash = hashIp(ipOf(req));
    if (existing && existing.kind === 'session') {
      const u = existing.user;
      return res.json({ token: req.body.token, user: publicUser(u), ...(u.kind === 'anon' ? anonUsage(u.id, ipHash) : {}) });
    }
    if (!anonLimit(ipHash)) return res.status(429).json({ error: 'Too many sessions from this network' });
    const user = createUser('anon');
    res.json({ token: createSession(user.id), user: publicUser(user), ...anonUsage(user.id, ipHash) });
  });

  app.get('/api/auth/nonce', (req, res) => {
    const wallet = String(req.query.wallet ?? '');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return res.status(400).json({ error: 'Invalid wallet address' });
    const nonce = walletNonce(wallet);
    res.json({ nonce, message: signInMessage(wallet, nonce) });
  });

  app.post('/api/auth/wallet', (req, res) => {
    const { wallet, nonce, signature, ref } = req.body ?? {};
    try {
      if (!verifyWalletSignIn(String(wallet), String(nonce), String(signature))) return res.status(401).json({ error: 'Signature check failed' });
    } catch {
      return res.status(400).json({ error: 'Malformed sign-in request' });
    }
    const user = findOrCreateWalletUser(wallet, typeof ref === 'string' ? ref : undefined);
    res.json({ token: createSession(user.id), user: publicUser(user) });
  });

  // Local development login: no wallet needed. Disabled in production.
  app.post('/api/auth/dev', (req, res) => {
    if (config.isProd) return res.status(404).end();
    const name = String(req.body?.name ?? 'dev').slice(0, 32);
    let user = db.prepare("SELECT * FROM users WHERE kind = 'dev' AND display_name = ?").get(name) as ReturnType<typeof getUser>;
    user ??= createUser('dev', { name, ref: req.body?.ref });
    res.json({ token: createSession(user.id), user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const t = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (t) revokeSession(t);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ account
  app.get('/api/me', session, (req: AuthedReq, res) => {
    const u = req.principal!.user;
    const ipHash = hashIp(ipOf(req));
    res.json({
      user: publicUser(u),
      credits: getBalance(u.id),
      plan: { id: activePlan(u), expiresAt: u.plan_expires },
      grant: u.kind === 'anon' ? null : grantState(u),
      freePrompts: u.kind === 'anon'
        ? anonUsage(u.id, ipHash)
        : { used: u.free_prompts_used, limit: config.freePromptLimit, remaining: Math.max(0, config.freePromptLimit - u.free_prompts_used) },
      freePaused: !subsidyRoom(10),
      config: pricingConfig(),
    });
  });

  app.get('/api/pricing', (_req, res) => res.json(pricingConfig()));

  // ------------------------------------------------------------------ API keys
  app.get('/api/api-keys', session, signedIn, (req: AuthedReq, res) => {
    const keys = db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC').all(req.principal!.user.id);
    res.json({ keys });
  });
  app.post('/api/api-keys', session, signedIn, (req: AuthedReq, res) => {
    const n = (db.prepare('SELECT COUNT(*) n FROM api_keys WHERE user_id = ? AND revoked = 0').get(req.principal!.user.id) as { n: number }).n;
    if (n >= 5) return res.status(400).json({ error: 'Maximum of 5 active API keys' });
    res.json(createApiKey(req.principal!.user.id, String(req.body?.name ?? '').slice(0, 40) || undefined));
  });
  app.delete('/api/api-keys/:id', session, signedIn, (req: AuthedReq, res) => {
    const r = db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?').run(String(req.params.id), req.principal!.user.id);
    res.json({ revoked: r.changes > 0 });
  });

  // ------------------------------------------------------------------ node tokens
  app.get('/api/node-tokens', session, signedIn, (req: AuthedReq, res) => {
    const tokens = db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM node_tokens WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC').all(req.principal!.user.id);
    res.json({ tokens });
  });
  app.post('/api/node-tokens', session, signedIn, (req: AuthedReq, res) => {
    try {
      res.json(createNodeToken(req.principal!.user.id, String(req.body?.name ?? '').slice(0, 40) || undefined));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.delete('/api/node-tokens/:id', session, signedIn, (req: AuthedReq, res) => {
    const r = db.prepare('UPDATE node_tokens SET revoked = 1 WHERE id = ? AND user_id = ?').run(String(req.params.id), req.principal!.user.id);
    res.json({ revoked: r.changes > 0 });
  });

  // ------------------------------------------------------------------ credits / plans
  app.get('/api/credits', session, (req: AuthedReq, res) => {
    const u = req.principal!.user;
    const limit = Math.min(500, Math.max(1, Number(req.query.tx) || 20));
    const transactions = db.prepare('SELECT delta, reason, ref, created_at FROM credit_tx WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(u.id, limit);
    res.json({ balance: getBalance(u.id), transactions, grant: u.kind === 'anon' ? null : grantState(u) });
  });

  // Until the USDC deposit rail is live (phase 2), local builds can mint test credits.
  app.post('/api/credits/dev-add', session, signedIn, (req: AuthedReq, res) => {
    if (!config.allowDevCredits) return res.status(403).json({ error: 'Disabled' });
    const amount = Math.min(10_000, Math.max(1, Math.floor(Number(req.body?.amount) || 1000)));
    addCredits(req.principal!.user.id, amount, 'dev');
    res.json({ credited: amount, balance: getBalance(req.principal!.user.id) });
  });

  app.post('/api/plans/dev-activate', session, signedIn, (req: AuthedReq, res) => {
    if (!config.allowDevCredits) return res.status(403).json({ error: 'Disabled' });
    const plan = String(req.body?.plan) as PlanId;
    if (!(plan in PLANS)) return res.status(400).json({ error: 'Unknown plan' });
    const u = req.principal!.user;
    const base = u.plan === plan && u.plan_expires && u.plan_expires > now() ? u.plan_expires : now();
    db.prepare('UPDATE users SET plan = ?, plan_expires = ? WHERE id = ?').run(plan, plan === 'free' ? null : base + 30 * 86_400_000, u.id);
    res.json({ plan, expiresAt: getUser(u.id)!.plan_expires });
  });

  // ------------------------------------------------------------------ usage
  app.get('/api/usage', session, (req: AuthedReq, res) => {
    const uid = req.principal!.user.id;
    const byModel = db.prepare(
      "SELECT model, COUNT(*) requests, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(credits) credits FROM jobs WHERE user_id = ? GROUP BY model",
    ).all(uid);
    const daily = db.prepare(
      "SELECT date(created_at/1000, 'unixepoch') day, COUNT(*) requests, SUM(credits) credits FROM jobs WHERE user_id = ? AND created_at > ? GROUP BY day ORDER BY day",
    ).all(uid, now() - 365 * 86_400_000);
    res.json({ byModel, daily });
  });

  // ------------------------------------------------------------------ nodes / earnings
  app.get('/api/earnings', session, signedIn, (req: AuthedReq, res) => {
    const uid = req.principal!.user.id;
    const recent = db.prepare('SELECT job_id, usd, tokens, subsidized, created_at FROM node_earnings WHERE user_id = ? ORDER BY id DESC LIMIT 25').all(uid);
    const payouts = db.prepare('SELECT id, address, usd, status, tx, created_at FROM payouts WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(uid);
    const totals = db.prepare('SELECT COUNT(*) jobs, COALESCE(SUM(tokens),0) tokens FROM node_earnings WHERE user_id = ?').get(uid);
    const rep = db.prepare('SELECT strikes, banned, ban_reason FROM node_reputation WHERE user_id = ?').get(uid) ?? { strikes: 0, banned: 0 };
    res.json({ balance: nodeBalance(uid), totals, recent, payouts, reputation: rep, nodes: orch.nodesForOwner(uid) });
  });

  const payoutLimit = limiter(1, 5_000);
  app.post('/api/payouts', session, signedIn, async (req: AuthedReq, res) => {
    const uid = req.principal!.user.id;
    if (!payoutLimit(uid)) return res.status(429).json({ error: 'Wait a few seconds' });
    const address = String(req.body?.address ?? '');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return res.status(400).json({ error: 'Invalid Solana address' });
    try {
      const id = createPayout(uid, address, Number(req.body?.amount));
      if (!solanaEnabled()) return res.json({ id, status: 'pending', message: 'Queued — USDC payouts are processed by an operator on this server' });
      const r = await finishPayoutOnchain(id, address);
      res.json({ id, ...r });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  // ------------------------------------------------------------------ USDC deposits + plan checkout
  app.get('/api/deposit', session, signedIn, (req: AuthedReq, res) => {
    if (!solanaEnabled()) return res.json({ enabled: false });
    const uid = req.principal!.user.id;
    res.json({
      enabled: true, address: getOrCreateDepositWallet(uid), mint: solanaConfig.usdcMint, cluster: solanaConfig.cluster,
      creditsPerUsd: CREDITS_PER_USD_PURCHASED, intent: openIntent(uid) ?? null,
    });
  });

  const depositLimit = limiter(1, 10_000);
  app.post('/api/deposit/check', session, signedIn, async (req: AuthedReq, res) => {
    const uid = req.principal!.user.id;
    if (!depositLimit(uid)) return res.status(429).json({ error: 'Checked a moment ago — try again in 10 seconds' });
    try {
      const r = await checkDeposit(uid);
      res.json({ ...r, balance: getBalance(uid), sweptUrl: r.swept ? explorerTx(r.swept) : undefined });
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
  });

  app.get('/api/plans', session, signedIn, (req: AuthedReq, res) => {
    const u = req.principal!.user;
    res.json({ plan: { id: activePlan(u), expiresAt: u.plan_expires }, intent: solanaEnabled() ? openIntent(u.id) ?? null : null, grant: grantState(u) });
  });
  const planLimit = limiter(1, 3_000);
  app.post('/api/plans/buy', session, signedIn, (req: AuthedReq, res) => {
    const uid = req.principal!.user.id;
    if (!solanaEnabled()) return res.status(503).json({ error: 'USDC checkout is not configured on this server' });
    if (!planLimit(uid)) return res.status(429).json({ error: 'Slow down' });
    try {
      const r = createIntent(uid, String(req.body?.plan) as PlanId, Number(req.body?.months) || 1);
      res.json({ ...r, depositWallet: getOrCreateDepositWallet(uid) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.post('/api/plans/cancel', session, signedIn, (req: AuthedReq, res) => {
    res.json({ releasedCredits: releaseIntent(req.principal!.user.id, 'cancelled') });
  });

  app.get('/api/referrals', session, signedIn, (req: AuthedReq, res) => {
    const u = req.principal!.user;
    const referred = (db.prepare('SELECT COUNT(*) n FROM users WHERE referred_by = ?').get(u.id) as { n: number }).n;
    const earned = (db.prepare('SELECT COALESCE(SUM(usd),0) s FROM referral_earnings WHERE user_id = ?').get(u.id) as { s: number }).s;
    res.json({ code: u.referral_code, referredCount: referred, earnedUsd: earned });
  });

  app.get('/api/treasury', (_req, res) => {
    const b = treasurySummary();
    const st = staking.stats();
    const paidToNodes = (db.prepare('SELECT COALESCE(SUM(usd),0) s FROM node_earnings').get() as { s: number }).s;
    res.json({
      launched: staking.stakingEnabled(), tokenMint: staking.tokenMint() || null,
      pendingBuyback: b.buyback ?? 0, pendingStakerRewards: b.staker_rewards ?? 0, paidToNodes,
      totalStaked: staking.totalStaked(), tideBurned: st.tide_burned ?? 0, buybackSpentUsd: st.buyback_spent_usd ?? 0,
      stakerRewardsPaidUsd: st.staker_rewards_paid_usd ?? 0,
    });
  });

  // ------------------------------------------------------------------ $TIDE staking
  app.get('/api/staking', session, signedIn, async (req: AuthedReq, res) => {
    const uid = req.principal!.user.id;
    if (!staking.stakingEnabled()) return res.json({ enabled: false, threshold: staking.WORKER_STAKE_THRESHOLD });
    let stale = false;
    try { await staking.refreshStake(uid); } catch { stale = true; }
    res.json({
      enabled: true, stale, mint: staking.tokenMint(), address: staking.getOrCreateStakingWallet(uid),
      ...staking.stakeOf(uid), rewards: staking.rewardsOf(uid), boost: staking.hasNodeBoost(uid),
      threshold: staking.WORKER_STAKE_THRESHOLD, minAgeHours: staking.STAKE_MIN_AGE_MS / 3600_000,
    });
  });
  const stakeLimit = limiter(1, 5_000);
  app.post('/api/staking/unstake', session, signedIn, async (req: AuthedReq, res) => {
    const u = req.principal!.user;
    if (!staking.stakingEnabled()) return res.status(503).json({ error: 'Staking is not live yet' });
    if (!u.wallet) return res.status(400).json({ error: 'Sign in with a Solana wallet to unstake' });
    if (!stakeLimit(u.id)) return res.status(429).json({ error: 'Slow down' });
    const amount = req.body?.amount === 'all' || req.body?.amount == null ? null : Number(req.body.amount);
    try {
      const sig = await staking.unstake(u.id, u.wallet, amount);
      res.json({ tx: sig, url: explorerTx(sig), ...staking.stakeOf(u.id) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.post('/api/staking/claim', session, signedIn, async (req: AuthedReq, res) => {
    const u = req.principal!.user;
    if (!staking.stakingEnabled()) return res.status(503).json({ error: 'Staking is not live yet' });
    if (!u.wallet) return res.status(400).json({ error: 'Sign in with a Solana wallet to claim' });
    if (!stakeLimit(u.id)) return res.status(429).json({ error: 'Slow down' });
    try { res.json(await staking.claimRewards(u.id, u.wallet)); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // ------------------------------------------------------------------ OpenAI-compatible API
  const v1 = express.Router();
  const apiAuth = auth(true, ['apikey', 'session']);
  const perKey = limiter(Number(process.env.API_RATE_LIMIT_PER_MIN) || 60, 60_000);

  v1.get('/models', (_req, res) => {
    res.json({
      object: 'list',
      image_models: [{ id: IMAGE_MODEL, object: 'model', owned_by: 'tide', available: orch.stats().imageNodes > 0, nodes: orch.stats().imageNodes, pricing: { type: 'per_image', credits: IMAGE_CREDITS } }],
      data: publicCatalog().map((m) => ({
        id: m.id,
        object: 'model',
        created: 1767225600,
        owned_by: 'tide',
        name: m.name,
        description: m.description,
        available: orch.modelAvailability(m.id) > 0,
        nodes: orch.modelAvailability(m.id),
        context_window: m.inputBudget + m.outputCap,
        pricing: { type: 'per_token', usd_per_m_input: PRICE_IN_PER_M_USD, usd_per_m_output: PRICE_OUT_PER_M_USD },
      })),
    });
  });

  v1.get('/balance', apiAuth, (req: AuthedReq, res) => {
    const credits = getBalance(req.principal!.user.id);
    res.json({ object: 'balance', credits, usd: +(credits / CREDITS_PER_USD).toFixed(4), grant: grantState(req.principal!.user) });
  });

  v1.post('/images/generations', apiAuth, async (req: AuthedReq, res) => {
    const b = req.body ?? {};
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) return oaiError(res, 400, '`prompt` is required', 'invalid_request_error');
    if (b.n !== undefined && Number(b.n) !== 1) return oaiError(res, 400, 'Only n=1 is supported', 'invalid_request_error');
    if (b.response_format && b.response_format !== 'b64_json') return oaiError(res, 400, 'Only response_format=b64_json is supported', 'invalid_request_error');
    const [w, h] = String(b.size ?? '1024x1024').split('x').map(Number);
    const params = normalizeImageParams({ prompt: b.prompt, negativePrompt: b.negative_prompt, width: w, height: h, seed: b.seed, steps: b.steps, cfg: b.cfg });
    const out = await runImage(req, res, params, !!b.nsfw);
    if (res.headersSent || res.writableEnded) return;
    if (!out.ok) {
      const [status, type] = httpFor(out.code);
      return oaiError(res, out.code === 'UNAUTHORIZED' ? 403 : status, out.error, type, out.code);
    }
    res.json({
      created: Math.floor(now() / 1000), data: [{ b64_json: out.image }], model: IMAGE_MODEL,
      seed: out.params.seed, size: `${out.params.width}x${out.params.height}`, credits_charged: out.credits,
    });
  });

  v1.post('/chat/completions', apiAuth, (req: AuthedReq, res) => {
    const p = req.principal!;
    const key = p.kind === 'apikey' ? p.keyId : p.user.id;
    if (!perKey(key)) return oaiError(res, 429, 'Rate limit exceeded', 'rate_limit_exceeded');

    const body = req.body ?? {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) return oaiError(res, 400, '`messages` must be a non-empty array', 'invalid_request_error');
    const model = typeof body.model === 'string' ? body.model : undefined;
    if (!resolveModel(model)) return oaiError(res, 404, `The model \`${model}\` does not exist`, 'model_not_found');

    let messages: ChatMessage[];
    try {
      messages = body.messages.map(toChatMessage);
    } catch (e) {
      return oaiError(res, 400, (e as Error).message, 'invalid_request_error');
    }
    const tools = Array.isArray(body.tools) && body.tool_choice !== 'none' ? body.tools : undefined;
    const stream = !!body.stream;
    const includeUsage = !!body.stream_options?.include_usage;
    const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);
    const created = Math.floor(now() / 1000);
    const modelId = model ?? 'tide-max';
    let started = false;
    let finished = false;
    let ping: NodeJS.Timeout | undefined;
    let jobId = '';

    const chunk = (delta: object, finish: string | null, extra: object = {}) =>
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);

    const startStream = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      chunk({ role: 'assistant', content: '' }, null);
      ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    };
    const end = () => { finished = true; if (ping) clearInterval(ping); };

    const r = orch.submit({
      principal: p,
      ip: ipOf(req),
      messages,
      model,
      think: !!body.think,
      tools,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      maxTokens: Number(body.max_tokens ?? body.max_completion_tokens) || undefined,
      source: 'api',
      sink: {
        onToken(token) {
          if (!stream) return;
          startStream();
          chunk({ content: token }, null);
        },
        onComplete(out) {
          if (finished) return;
          end();
          const usage = { prompt_tokens: out.usage.inputTokens, completion_tokens: out.usage.outputTokens, total_tokens: out.usage.inputTokens + out.usage.outputTokens, credits: out.usage.credits };
          const toolCalls = out.toolCalls?.map((t, i) => ({ index: i, id: t.id ?? `call_${randomUUID().slice(0, 8)}`, type: 'function', function: t.function }));
          if (stream) {
            startStream();
            if (toolCalls) chunk({ tool_calls: toolCalls }, 'tool_calls');
            else chunk({}, out.finishReason);
            if (includeUsage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [], usage })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.json({
              id, object: 'chat.completion', created, model: modelId,
              choices: [{ index: 0, message: { role: 'assistant', content: toolCalls ? null : out.response, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: out.finishReason }],
              usage,
            });
          }
        },
        onError(error, code) {
          if (finished) return;
          end();
          if (started) {
            res.write(`data: ${JSON.stringify({ error: { message: error, type: 'server_error', code } })}\n\n`);
            res.end();
          } else {
            const [status, type] = httpFor(code);
            oaiError(res, status, error, type, code);
          }
        },
      },
    });

    if ('error' in r) {
      end();
      const [status, type] = httpFor(r.code);
      return oaiError(res, status, r.error, type, r.code);
    }
    jobId = r.jobId;
    orch.processQueue();
    res.on('close', () => { if (!finished) { end(); orch.abort(jobId, true); } });
  });

  // ------------------------------------------------------------------ images
  /** Run one image job and resolve when the node returns it (or fails). Aborts if the client leaves. */
  function runImage(req: AuthedReq, res: Response, params: ImageParams, nsfw: boolean) {
    return new Promise<{ ok: true; image: string; params: ImageParams; credits: number } | { ok: false; error: string; code: ErrorCode }>((resolve) => {
      let jobId = '';
      let settled = false;
      const r = orch.submitImage({
        principal: req.principal!, ip: ipOf(req), params, nsfw,
        sink: {
          onDone: (d) => { settled = true; resolve({ ok: true, ...d }); },
          onError: (error, code) => { settled = true; resolve({ ok: false, error, code }); },
        },
      });
      if ('error' in r) return resolve({ ok: false, error: r.error, code: r.code });
      jobId = r.jobId;
      res.on('close', () => { if (!settled) orch.abortImage(jobId); });
    });
  }

  const imgAuth = auth(true, ['session', 'apikey']);
  app.post('/api/images/generate', imgAuth, async (req: AuthedReq, res) => {
    const b = req.body ?? {};
    const params = normalizeImageParams({
      prompt: String(b.prompt ?? ''), negativePrompt: b.negative_prompt ?? b.negativePrompt,
      width: b.width, height: b.height, steps: b.steps, cfg: b.cfg, seed: b.seed,
    });
    const out = await runImage(req, res, params, !!b.nsfw);
    if (res.headersSent || res.writableEnded) return;
    if (!out.ok) {
      const [status] = httpFor(out.code);
      return res.status(out.code === 'UNAUTHORIZED' ? 403 : status).json({ error: out.error, code: out.code });
    }
    res.json({
      image: `data:image/png;base64,${out.image}`, model: IMAGE_MODEL, seed: out.params.seed,
      width: out.params.width, height: out.params.height, credits_charged: out.credits,
    });
  });

  app.use('/api/admin', createAdmin(orch));
  app.use('/v1', v1);
  app.use('/api/v1', v1);
  return app;
}

// ---------------------------------------------------------------------------------------------

function publicUser(u: NonNullable<ReturnType<typeof getUser>>) {
  return { id: u.id, kind: u.kind, wallet: u.wallet, name: u.display_name, plan: u.plan, referralCode: u.referral_code, createdAt: u.created_at };
}

function pricingConfig() {
  return {
    creditsPerUsd: CREDITS_PER_USD,
    creditsPerUsdPurchased: CREDITS_PER_USD_PURCHASED,
    textRate: { usdPerMInput: PRICE_IN_PER_M_USD, usdPerMOutput: PRICE_OUT_PER_M_USD },
    typicalMessageCredits: 1,
    plans: Object.values(PLANS),
    devCredits: config.allowDevCredits,
    day: utcDay(),
  };
}

/** Flatten OpenAI message shapes (content parts, tool calls) into the wire format nodes understand. */
function toChatMessage(m: any): ChatMessage {
  if (!m || typeof m !== 'object') throw new Error('Each message must be an object');
  const role = m.role;
  if (!['system', 'user', 'assistant', 'tool', 'developer'].includes(role)) throw new Error(`Invalid role: ${role}`);
  let content = '';
  if (typeof m.content === 'string') content = m.content;
  else if (Array.isArray(m.content)) content = m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n');
  const out: ChatMessage = { role: role === 'developer' ? 'system' : role, content };
  if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = String(m.tool_call_id);
  if (m.name) out.name = String(m.name);
  return out;
}

function httpFor(code?: ErrorCode): [number, string] {
  switch (code) {
    case 'UNAUTHORIZED': return [401, 'invalid_request_error'];
    case 'INSUFFICIENT_CREDITS':
    case 'FREE_EXHAUSTED': return [402, 'insufficient_quota'];
    case 'RATE_LIMIT': return [429, 'rate_limit_exceeded'];
    case 'UNKNOWN_MODEL': return [404, 'model_not_found'];
    case 'NO_CAPACITY':
    case 'TIMEOUT':
    case 'NODE_GONE':
    case 'NODE_ERROR': return [503, 'server_error'];
    case 'SAFETY': return [400, 'content_policy_violation'];
    default: return [400, 'invalid_request_error'];
  }
}

function oaiError(res: Response, status: number, message: string, type: string, code?: string) {
  if (res.headersSent) return;
  res.status(status).json({ error: { message, type, code: code ?? type } });
}
