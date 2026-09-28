/**
 * $TIDE staking (custodial model).
 *
 * Each account gets a server-held staking address. Sending $TIDE there *is* staking: the on-chain
 * balance is the stake. Stake is tracked in lots so that only stake held >= 24h ("matured") earns —
 * that stops people from depositing right before a distribution. Withdrawals consume the youngest
 * lots first (LIFO). There is no lockup.
 *
 * Matured stake earns: a pro-rata share of the daily staker_rewards bucket (paid in USDC), and
 * node owners with >= 500k matured $TIDE get the boosted 80% revenue share.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAccount, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TokenAccountNotFoundError,
} from '@solana/spl-token';
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { db, now, tx } from './db.ts';
import { conn, decrypt, encrypt, priority, sendUsdc, solanaEnabled, treasury } from './solana.ts';

export const STAKE_MIN_AGE_MS = 24 * 3600_000;
export const WORKER_STAKE_THRESHOLD = 500_000; // whole $TIDE
export const MIN_UNSTAKE = 1_000;              // whole $TIDE, unless withdrawing everything
export const MIN_CLAIM_USD = 1;

db.exec(`
CREATE TABLE IF NOT EXISTS staking_wallets (
  user_id          TEXT PRIMARY KEY,
  public_key       TEXT UNIQUE NOT NULL,
  encrypted_secret TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stake_lots (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount  REAL NOT NULL,                  -- whole tokens (UI units)
  since   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stake_lots_user ON stake_lots(user_id, since);
CREATE TABLE IF NOT EXISTS staking_rewards (
  user_id       TEXT PRIMARY KEY,
  claimable_usd REAL NOT NULL DEFAULT 0,
  claimed_usd   REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reward_claims (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  usd        REAL NOT NULL,
  address    TEXT NOT NULL,
  status     TEXT NOT NULL,               -- 'pending' | 'completed' | 'needs_review'
  tx         TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS treasury_stats (
  key   TEXT PRIMARY KEY,
  value REAL NOT NULL DEFAULT 0
);
`);

export const tokenMint = () => process.env.TIDE_TOKEN_MINT ?? '';
export const stakingEnabled = () => solanaEnabled() && !!tokenMint();

// ------------------------------------------------------------------ lot ledger (pure DB, unit-tested)

/** Reconcile lots to an observed balance: growth opens a new lot, shrink eats youngest lots first. */
export function syncStake(userId: string, observed: number, at = now()) {
  tx(() => {
    const lots = db.prepare('SELECT id, amount FROM stake_lots WHERE user_id = ? ORDER BY since DESC, id DESC').all(userId) as { id: number; amount: number }[];
    const total = lots.reduce((a, l) => a + l.amount, 0);
    if (observed <= 0) {
      db.prepare('DELETE FROM stake_lots WHERE user_id = ?').run(userId);
    } else if (observed > total + 1e-9) {
      db.prepare('INSERT INTO stake_lots(user_id, amount, since) VALUES (?, ?, ?)').run(userId, observed - total, at);
    } else if (observed < total - 1e-9) {
      let remove = total - observed;
      for (const l of lots) {
        if (remove <= 1e-9) break;
        if (l.amount <= remove + 1e-9) {
          db.prepare('DELETE FROM stake_lots WHERE id = ?').run(l.id);
          remove -= l.amount;
        } else {
          db.prepare('UPDATE stake_lots SET amount = ? WHERE id = ?').run(l.amount - remove, l.id);
          remove = 0;
        }
      }
    }
  });
}

export function stakeOf(userId: string, at = now()) {
  const rows = db.prepare('SELECT amount, since FROM stake_lots WHERE user_id = ?').all(userId) as { amount: number; since: number }[];
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const matured = rows.filter((r) => r.since <= at - STAKE_MIN_AGE_MS).reduce((a, r) => a + r.amount, 0);
  const nextMaturity = rows.filter((r) => r.since > at - STAKE_MIN_AGE_MS).map((r) => r.since + STAKE_MIN_AGE_MS).sort()[0] ?? null;
  return { total, matured, nextMaturity };
}

export const hasNodeBoost = (userId: string) => stakeOf(userId).matured >= WORKER_STAKE_THRESHOLD;

/**
 * Split `poolUsd` across stakers pro-rata by matured stake. Returns the amount actually
 * distributed (rounding dust stays with the caller). Floors each share to 1e-6 USD.
 */
export function distributeRewards(poolUsd: number, at = now()): { distributed: number; stakers: number } {
  if (poolUsd <= 0) return { distributed: 0, stakers: 0 };
  const rows = db.prepare('SELECT user_id, SUM(amount) m FROM stake_lots WHERE since <= ? GROUP BY user_id HAVING m > 0').all(at - STAKE_MIN_AGE_MS) as { user_id: string; m: number }[];
  const total = rows.reduce((a, r) => a + r.m, 0);
  if (total <= 0) return { distributed: 0, stakers: 0 };
  let distributed = 0;
  tx(() => {
    for (const r of rows) {
      const share = Math.floor((poolUsd * r.m / total) * 1e6) / 1e6;
      if (share <= 0) continue;
      db.prepare('INSERT INTO staking_rewards(user_id, claimable_usd) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET claimable_usd = claimable_usd + excluded.claimable_usd').run(r.user_id, share);
      distributed += share;
    }
  });
  return { distributed, stakers: rows.length };
}

export function rewardsOf(userId: string) {
  const r = db.prepare('SELECT claimable_usd, claimed_usd FROM staking_rewards WHERE user_id = ?').get(userId) as { claimable_usd: number; claimed_usd: number } | undefined;
  return { claimable: r?.claimable_usd ?? 0, claimed: r?.claimed_usd ?? 0 };
}

export function bumpStat(key: string, v: number) {
  db.prepare('INSERT INTO treasury_stats(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value').run(key, v);
}
export function stats(): Record<string, number> {
  return Object.fromEntries((db.prepare('SELECT key, value FROM treasury_stats').all() as { key: string; value: number }[]).map((r) => [r.key, r.value]));
}
export function totalStaked() {
  return (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM stake_lots').get() as { s: number }).s;
}

// ------------------------------------------------------------------ chain I/O

let _mintInfo: { programId: PublicKey; decimals: number } | null = null;
export async function mintInfo() {
  if (_mintInfo) return _mintInfo;
  const pk = new PublicKey(tokenMint());
  const acct = await conn().getAccountInfo(pk);
  if (!acct) throw new Error('TIDE_TOKEN_MINT not found on chain');
  const programId = acct.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = await getMint(conn(), pk, 'confirmed', programId);
  return (_mintInfo = { programId, decimals: m.decimals });
}

export function getOrCreateStakingWallet(userId: string): string {
  const row = db.prepare('SELECT public_key FROM staking_wallets WHERE user_id = ?').get(userId) as { public_key: string } | undefined;
  if (row) return row.public_key;
  const kp = Keypair.generate();
  db.prepare('INSERT OR IGNORE INTO staking_wallets(user_id, public_key, encrypted_secret, created_at) VALUES (?, ?, ?, ?)').run(userId, kp.publicKey.toBase58(), encrypt(kp.secretKey), now());
  return (db.prepare('SELECT public_key FROM staking_wallets WHERE user_id = ?').get(userId) as { public_key: string }).public_key;
}

/** On-chain $TIDE balance (whole tokens) of a user's staking address. Throws on RPC failure. */
export async function onchainStake(userId: string): Promise<number> {
  const { programId, decimals } = await mintInfo();
  const owner = new PublicKey(getOrCreateStakingWallet(userId));
  try {
    const a = await getAccount(conn(), getAssociatedTokenAddressSync(new PublicKey(tokenMint()), owner, true, programId), 'confirmed', programId);
    return Number(a.amount) / 10 ** decimals;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return 0;
    throw e;
  }
}

export async function refreshStake(userId: string) {
  syncStake(userId, await onchainStake(userId));
  return stakeOf(userId);
}

/** Send $TIDE from the staking address back to the owner's wallet. amount=null withdraws everything. */
export async function unstake(userId: string, toWallet: string, amount: number | null): Promise<string> {
  const { programId, decimals } = await mintInfo();
  const current = await onchainStake(userId);
  syncStake(userId, current);
  const amt = amount === null ? current : amount;
  if (amt <= 0 || amt > current + 1e-9) throw new Error('Invalid amount');
  if (amount !== null && amt < MIN_UNSTAKE && Math.abs(amt - current) > 1e-9) throw new Error(`Minimum partial unstake is ${MIN_UNSTAKE.toLocaleString()} $TIDE`);
  const row = db.prepare('SELECT encrypted_secret FROM staking_wallets WHERE user_id = ?').get(userId) as { encrypted_secret: string };
  const stakeKp = Keypair.fromSecretKey(decrypt(row.encrypted_secret));
  const mint = new PublicKey(tokenMint());
  const dest = new PublicKey(toWallet);
  const t = treasury();
  const from = getAssociatedTokenAddressSync(mint, stakeKp.publicKey, true, programId);
  const to = getAssociatedTokenAddressSync(mint, dest, true, programId);
  const raw = BigInt(Math.round(amt * 10 ** decimals));
  const txn = new Transaction().add(
    priority(),
    createAssociatedTokenAccountIdempotentInstruction(t.publicKey, to, dest, mint, programId),
    createTransferCheckedInstruction(from, mint, to, stakeKp.publicKey, raw, decimals, [], programId),
  );
  txn.feePayer = t.publicKey;
  const sig = await sendAndConfirmTransaction(conn(), txn, [t, stakeKp], { commitment: 'confirmed' });
  syncStake(userId, Math.max(0, current - amt));
  return sig;
}

/** Pay out claimable USDC rewards. On an unconfirmed transfer the claim is held for review. */
export async function claimRewards(userId: string, toWallet: string) {
  const id = tx(() => {
    const { claimable } = rewardsOf(userId);
    const usd = Math.floor(claimable * 100) / 100;
    if (usd < MIN_CLAIM_USD) throw new Error(`Minimum claim is $${MIN_CLAIM_USD.toFixed(2)}`);
    if (db.prepare("SELECT 1 FROM reward_claims WHERE user_id = ? AND status = 'pending'").get(userId)) throw new Error('A claim is already in progress');
    db.prepare('UPDATE staking_rewards SET claimable_usd = claimable_usd - ? WHERE user_id = ?').run(usd, userId);
    return Number(db.prepare("INSERT INTO reward_claims(user_id, usd, address, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(userId, usd, toWallet, now()).lastInsertRowid);
  });
  const { usd } = db.prepare('SELECT usd FROM reward_claims WHERE id = ?').get(id) as { usd: number };
  try {
    const sig = await sendUsdc(toWallet, usd);
    tx(() => {
      db.prepare("UPDATE reward_claims SET status = 'completed', tx = ? WHERE id = ?").run(sig, id);
      db.prepare('UPDATE staking_rewards SET claimed_usd = claimed_usd + ? WHERE user_id = ?').run(usd, userId);
    });
    bumpStat('staker_rewards_paid_usd', usd);
    return { status: 'completed', usd, tx: sig };
  } catch (e) {
    db.prepare("UPDATE reward_claims SET status = 'needs_review' WHERE id = ?").run(id);
    console.error('[staking] claim transfer unconfirmed, needs review:', (e as Error).message);
    return { status: 'needs_review', usd };
  }
}
