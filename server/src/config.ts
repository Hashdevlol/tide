import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);

export const config = {
  port: num(env.PORT, 3001),
  host: env.HOST ?? '0.0.0.0',
  dbPath: resolve(env.TIDE_DB ?? 'data/tide.db'),
  isProd: env.NODE_ENV === 'production',
  /** HMAC secret for anon tokens. Set it in production so tokens survive restarts. */
  secret: env.TIDE_SECRET ?? randomBytes(32).toString('hex'),
  allowDevCredits: env.ALLOW_DEV_CREDITS === 'true' || env.NODE_ENV !== 'production',
  webDist: resolve(env.WEB_DIST ?? '../web/dist'),

  // Anti-abuse
  maxNodesPerAccount: num(env.MAX_NODES_PER_ACCOUNT, 10),
  maxNodesPerIp: num(env.MAX_NODES_PER_IP, 10),
  minNodeAccountAgeHours: num(env.MIN_NODE_ACCOUNT_AGE_HOURS, env.NODE_ENV === 'production' ? 48 : 0),
  minTokPerSec: num(env.MIN_TOK_PER_SEC, 5),
  jobsPer5Min: num(env.JOBS_PER_5MIN, 20),

  // Free lane
  anonPromptsPerSession: num(env.ANON_PROMPTS_PER_SESSION, 5),
  anonPromptsPerIpDay: num(env.ANON_PROMPTS_PER_IP_DAY, env.NODE_ENV === 'production' ? 8 : 100), // localhost shares one IP in dev
  freePromptLimit: num(env.FREE_PROMPT_LIMIT, 5),
  subsidyDailyCapUsd: num(env.SUBSIDY_DAILY_CAP_USD, 50),
  subsidyHourlyCapUsd: num(env.SUBSIDY_HOURLY_CAP_USD, 3),

  // Timeouts (ms)
  queueTimeout: 180_000,
  firstTokenTimeout: 120_000,
  tokenGapTimeout: 60_000,
  jobCeiling: 600_000,
  canaryCeiling: 180_000,

  minWithdrawalUsd: 1,
  // Tokenomics split of realised margin (see treasury.ts)
  marginToPoolPct: num(env.MARGIN_TO_POOL_PCT, 1.0),
  poolBurnSplit: 0.5,
};
