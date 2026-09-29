import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,              -- 'anon' | 'wallet' | 'dev'
  wallet        TEXT UNIQUE,
  display_name  TEXT,
  plan          TEXT NOT NULL DEFAULT 'free',
  plan_expires  INTEGER,
  referral_code TEXT UNIQUE,
  referred_by   TEXT,
  free_prompts_used INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- API keys (sk-tide-...) and node tokens (tnt_...) are stored hashed only.
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash    TEXT UNIQUE NOT NULL,
  prefix      TEXT NOT NULL,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS node_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT UNIQUE NOT NULL,
  prefix      TEXT NOT NULL,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credit_tx (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,                 -- 'deposit' | 'job_hold' | 'job_refund' | 'dev' | ...
  ref        TEXT,
  created_at INTEGER NOT NULL
);

-- Daily plan grant usage per UTC day.
CREATE TABLE IF NOT EXISTS grant_usage (
  user_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Job metadata only. Prompts and outputs are never stored.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  node_id       TEXT,
  node_owner    TEXT,
  model         TEXT NOT NULL,
  lane          TEXT NOT NULL,
  source        TEXT NOT NULL,              -- 'chat' | 'api'
  status        TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  credits       INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at);

CREATE TABLE IF NOT EXISTS node_earnings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT UNIQUE NOT NULL,
  user_id     TEXT NOT NULL,                -- node owner
  usd         REAL NOT NULL,
  tokens      INTEGER NOT NULL,
  subsidized  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS earnings_user ON node_earnings(user_id, created_at);

CREATE TABLE IF NOT EXISTS referral_earnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT UNIQUE NOT NULL,
  user_id    TEXT NOT NULL,                 -- referrer
  usd        REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  address    TEXT NOT NULL,
  usd        REAL NOT NULL,
  status     TEXT NOT NULL,                 -- 'pending' | 'completed' | 'needs_review'
  tx         TEXT,
  created_at INTEGER NOT NULL
);

-- Anti-cheat state per node owner account.
CREATE TABLE IF NOT EXISTS node_reputation (
  user_id      TEXT PRIMARY KEY,
  strikes      INTEGER NOT NULL DEFAULT 0,
  banned       INTEGER NOT NULL DEFAULT 0,
  ban_reason   TEXT,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS canary_results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  passed     INTEGER NOT NULL,              -- 1 pass, 0 fail, -1 neutral (error)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS anon_usage (
  key   TEXT PRIMARY KEY,                   -- 'ip:<hash>:<day>' | 'sess:<id>'
  used  INTEGER NOT NULL DEFAULT 0
);

-- Treasury: virtual buckets over one real wallet, plus an append-only ledger.
CREATE TABLE IF NOT EXISTS treasury_buckets (
  bucket TEXT PRIMARY KEY,
  usd    REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS treasury_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  bucket     TEXT,
  usd        REAL NOT NULL,
  meta       TEXT,
  created_at INTEGER NOT NULL
);

-- Custodial USDC deposit address per user. Secret key is AES-256-GCM encrypted.
CREATE TABLE IF NOT EXISTS deposit_wallets (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key       TEXT UNIQUE NOT NULL,
  encrypted_secret TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
-- Raw token units already converted to credits but not yet swept (compare-and-set marker).
CREATE TABLE IF NOT EXISTS deposit_progress (
  user_id  TEXT NOT NULL,
  mint     TEXT NOT NULL,
  credited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, mint)
);
-- A sweep whose outcome we have not confirmed yet (reconciled on the next check).
CREATE TABLE IF NOT EXISTS sweep_pending (
  user_id     TEXT NOT NULL,
  mint        TEXT NOT NULL,
  sig         TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  last_valid  INTEGER NOT NULL,
  PRIMARY KEY (user_id, mint)
);
CREATE TABLE IF NOT EXISTS plan_intents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  plan         TEXT NOT NULL,
  months       INTEGER NOT NULL,
  expected_usd REAL NOT NULL,
  paid_usd     REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,              -- 'open' | 'paid' | 'cancelled' | 'expired'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Free-lane subsidy spend per UTC day / hour (worker payouts funded by the treasury).
CREATE TABLE IF NOT EXISTS subsidy_spend (
  period TEXT PRIMARY KEY,                  -- 'd:2026-09-28' | 'h:2026-09-28T14'
  usd    REAL NOT NULL DEFAULT 0
);
`);

for (const b of ['profit']) {
  db.prepare('INSERT OR IGNORE INTO treasury_buckets(bucket, usd) VALUES (?, 0)').run(b);
}

/** Run fn inside an IMMEDIATE transaction. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => Date.now();
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const utcHour = (t = Date.now()) => new Date(t).toISOString().slice(0, 13);
