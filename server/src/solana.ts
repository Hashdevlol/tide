/**
 * USDC rails on Solana: custodial deposit addresses, deposit crediting + sweep to the
 * treasury, plan purchases paid from deposits, and USDC payouts to node owners.
 *
 * Disabled unless TREASURY_WALLET_KEY and DEPOSIT_WALLET_KEY are set. Defaults to devnet.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAccount, getMint, TokenAccountNotFoundError,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { PLANS, CREDITS_PER_USD_PURCHASED, type PlanId } from '@tide/shared';
import { db, now, tx } from './db.ts';
import { finishPayout } from './billing.ts';
import { getUser } from './auth.ts';

const env = process.env;
export const solanaConfig = {
  rpc: env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  // Circle's devnet USDC by default; mainnet USDC is EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
  usdcMint: env.USDC_MINT ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  cluster: env.SOLANA_CLUSTER ?? 'devnet',
};

function parseKeypair(v: string): Keypair {
  const s = v.trim();
  return Keypair.fromSecretKey(s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s));
}

let _conn: Connection | null = null;
let _treasury: Keypair | null = null;
let _aesKey: Buffer | null = null;
let _decimals: number | null = null;

export function solanaEnabled(): boolean {
  return !!(env.TREASURY_WALLET_KEY && env.DEPOSIT_WALLET_KEY && /^[0-9a-f]{64}$/i.test(env.DEPOSIT_WALLET_KEY));
}
export function conn() { return (_conn ??= new Connection(solanaConfig.rpc, 'confirmed')); }
export function treasury() { return (_treasury ??= parseKeypair(env.TREASURY_WALLET_KEY!)); }
function aesKey() { return (_aesKey ??= Buffer.from(env.DEPOSIT_WALLET_KEY!, 'hex')); }
const mint = () => new PublicKey(solanaConfig.usdcMint);
async function decimals() { return (_decimals ??= (await getMint(conn(), mint())).decimals); }
export const treasuryAddress = () => (solanaEnabled() ? treasury().publicKey.toBase58() : null);

// ------------------------------------------------------------------ custody
export function encrypt(secret: Uint8Array): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([c.update(secret), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
export function decrypt(stored: string): Uint8Array {
  const [iv, tag, data] = stored.split(':').map((h) => Buffer.from(h, 'hex'));
  const d = createDecipheriv('aes-256-gcm', aesKey(), iv);
  d.setAuthTag(tag);
  return Uint8Array.from(Buffer.concat([d.update(data), d.final()]));
}

export function getOrCreateDepositWallet(userId: string): string {
  const row = db.prepare('SELECT public_key FROM deposit_wallets WHERE user_id = ?').get(userId) as { public_key: string } | undefined;
  if (row) return row.public_key;
  const kp = Keypair.generate();
  db.prepare('INSERT OR IGNORE INTO deposit_wallets(user_id, public_key, encrypted_secret, created_at) VALUES (?, ?, ?, ?)').run(
    userId, kp.publicKey.toBase58(), encrypt(kp.secretKey), now(),
  );
  return (db.prepare('SELECT public_key FROM deposit_wallets WHERE user_id = ?').get(userId) as { public_key: string }).public_key;
}

function depositKeypair(userId: string): Keypair {
  const row = db.prepare('SELECT encrypted_secret FROM deposit_wallets WHERE user_id = ?').get(userId) as { encrypted_secret: string };
  return Keypair.fromSecretKey(decrypt(row.encrypted_secret));
}

async function tokenBalance(owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(conn(), getAssociatedTokenAddressSync(mint(), owner, true))).amount;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return 0n;
    throw e;
  }
}

export const priority = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(env.PRIORITY_FEE_MICROLAMPORTS) || 50_000 });

// ------------------------------------------------------------------ plan intents
export function openIntent(userId: string) {
  const row = db.prepare("SELECT * FROM plan_intents WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(userId) as
    | { id: number; plan: PlanId; months: number; expected_usd: number; paid_usd: number; expires_at: number } | undefined;
  if (row && row.expires_at < now()) {
    releaseIntent(userId, 'expired');
    return undefined;
  }
  return row;
}

/** Start a plan purchase: the next deposit(s) pay for it. Any money already held returns as credits. */
export function createIntent(userId: string, plan: PlanId, months: number) {
  if (!(plan in PLANS) || plan === 'free') throw new Error('Unknown plan');
  if (![1, 3, 12].includes(months)) throw new Error('months must be 1, 3 or 12');
  const u = getUser(userId)!;
  const current = u.plan_expires && u.plan_expires > now() ? (u.plan as PlanId) : 'free';
  if (PLANS[plan].priceUsd < PLANS[current].priceUsd) throw new Error(`You already have ${PLANS[current].name}; downgrade after it expires`);
  const released = releaseIntent(userId, 'cancelled');
  db.prepare("INSERT INTO plan_intents(user_id, plan, months, expected_usd, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'open', ?, ?)").run(
    userId, plan, months, PLANS[plan].priceUsd * months, now(), now() + 24 * 3600_000,
  );
  return { intent: openIntent(userId), releasedCredits: released };
}

export function releaseIntent(userId: string, status: 'cancelled' | 'expired'): number {
  return tx(() => {
    const row = db.prepare("SELECT id, paid_usd FROM plan_intents WHERE user_id = ? AND status = 'open'").get(userId) as { id: number; paid_usd: number } | undefined;
    if (!row) return 0;
    db.prepare('UPDATE plan_intents SET status = ? WHERE id = ?').run(status, row.id);
    const credits = Math.floor(row.paid_usd * CREDITS_PER_USD_PURCHASED);
    if (credits > 0) {
      db.prepare('UPDATE credits SET balance = balance + ? WHERE user_id = ?').run(credits, userId);
      db.prepare('INSERT INTO credit_tx(user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, credits, 'plan_release', String(row.id), now());
    }
    return credits;
  });
}

/** Extend or upgrade a plan. Upgrades carry leftover time over, scaled by the price ratio. */
function activatePlan(userId: string, plan: PlanId, months: number) {
  const u = getUser(userId)!;
  const period = 30 * 86_400_000 * months;
  const active = u.plan_expires && u.plan_expires > now();
  let expires: number;
  if (active && u.plan === plan) expires = u.plan_expires! + period;
  else if (active && u.plan !== 'free') {
    const left = u.plan_expires! - now();
    const carried = left * (PLANS[u.plan as PlanId].priceUsd / PLANS[plan].priceUsd);
    expires = now() + period + carried;
  } else expires = now() + period;
  db.prepare('UPDATE users SET plan = ?, plan_expires = ? WHERE id = ?').run(plan, Math.floor(expires), userId);
}

// ------------------------------------------------------------------ deposits
export interface DepositResult { credited: number; planActivated?: PlanId; heldUsd?: number; balanceUsd: number; swept?: string; message?: string }

const checking = new Set<string>();

/**
 * Read the deposit address balance, convert the not-yet-credited part to credits (or apply it to an
 * open plan purchase), then sweep the tokens to the treasury.
 */
export async function checkDeposit(userId: string): Promise<DepositResult> {
  if (!solanaEnabled()) throw new Error('USDC deposits are not configured on this server');
  if (checking.has(userId)) throw new Error('A deposit check is already running');
  checking.add(userId);
  try {
    const owner = new PublicKey(getOrCreateDepositWallet(userId));
    const dec = await decimals();
    const onchain = await tokenBalance(owner);
    const m = solanaConfig.usdcMint;
    const markerRow = db.prepare('SELECT credited FROM deposit_progress WHERE user_id = ? AND mint = ?').get(userId, m) as { credited: number } | undefined;
    const marker = BigInt(markerRow?.credited ?? 0);
    const fresh = onchain - marker;
    const result: DepositResult = { credited: 0, balanceUsd: Number(onchain) / 10 ** dec };

    if (fresh > 0n) {
      const usd = Number(fresh) / 10 ** dec;
      tx(() => {
        // Compare-and-set: bail if another check moved the marker since we read it.
        const cur = (db.prepare('SELECT credited FROM deposit_progress WHERE user_id = ? AND mint = ?').get(userId, m) as { credited: number } | undefined)?.credited ?? 0;
        if (BigInt(cur) !== marker) throw new Error('Deposit state changed, retry');
        db.prepare('INSERT INTO deposit_progress(user_id, mint, credited) VALUES (?, ?, ?) ON CONFLICT(user_id, mint) DO UPDATE SET credited = excluded.credited').run(userId, m, Number(onchain));

        let remaining = usd;
        const intent = openIntent(userId);
        if (intent) {
          const need = intent.expected_usd - intent.paid_usd;
          const apply = Math.min(need, remaining);
          remaining -= apply;
          const paid = intent.paid_usd + apply;
          if (paid + 1e-9 >= intent.expected_usd) {
            db.prepare("UPDATE plan_intents SET paid_usd = ?, status = 'paid' WHERE id = ?").run(paid, intent.id);
            activatePlan(userId, intent.plan, intent.months);
            result.planActivated = intent.plan;
          } else {
            db.prepare('UPDATE plan_intents SET paid_usd = ? WHERE id = ?').run(paid, intent.id);
            result.heldUsd = paid;
          }
        }
        const credits = Math.floor(remaining * CREDITS_PER_USD_PURCHASED + 1e-9);
        if (credits > 0) {
          db.prepare('UPDATE credits SET balance = balance + ? WHERE user_id = ?').run(credits, userId);
          db.prepare('INSERT INTO credit_tx(user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, credits, 'deposit', `${usd} USDC`, now());
          result.credited = credits;
        }
      });
    } else if (onchain === 0n) {
      result.message = 'No USDC found at your deposit address yet';
    }

    // Sweep everything already credited to the treasury. The treasury pays the fee, so the
    // deposit address never needs SOL. Outcome-unknown sweeps are reconciled first.
    await reconcileSweep(userId, m);
    const credited = BigInt((db.prepare('SELECT credited FROM deposit_progress WHERE user_id = ? AND mint = ?').get(userId, m) as { credited: number } | undefined)?.credited ?? 0);
    const pending = db.prepare('SELECT 1 FROM sweep_pending WHERE user_id = ? AND mint = ?').get(userId, m);
    if (credited > 0n && !pending) {
      const dep = depositKeypair(userId);
      const t = treasury();
      const from = getAssociatedTokenAddressSync(mint(), dep.publicKey, true);
      const to = getAssociatedTokenAddressSync(mint(), t.publicKey, true);
      const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash('confirmed');
      const txn = new Transaction({ feePayer: t.publicKey, blockhash, lastValidBlockHeight }).add(
        priority(),
        createAssociatedTokenAccountIdempotentInstruction(t.publicKey, to, t.publicKey, mint()),
        createTransferCheckedInstruction(from, mint(), to, dep.publicKey, credited, dec),
      );
      txn.sign(t, dep);
      const sig = bs58.encode(txn.signature!);
      // Record before broadcast so a crash or timeout can never lose track of it.
      db.prepare('INSERT OR REPLACE INTO sweep_pending(user_id, mint, sig, amount, last_valid) VALUES (?, ?, ?, ?, ?)').run(userId, m, sig, Number(credited), lastValidBlockHeight);
      try {
        await conn().sendRawTransaction(txn.serialize(), { skipPreflight: false });
        await conn().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        result.swept = sig;
      } catch (e) {
        console.error('[solana] sweep not confirmed yet, will reconcile on next check:', (e as Error).message);
      }
      await reconcileSweep(userId, m);
    }
    return result;
  } finally {
    checking.delete(userId);
  }
}

/** Settle a recorded sweep: confirmed -> lower the marker; failed or expired -> forget it so it can retry. */
async function reconcileSweep(userId: string, m: string) {
  const p = db.prepare('SELECT sig, amount, last_valid FROM sweep_pending WHERE user_id = ? AND mint = ?').get(userId, m) as
    | { sig: string; amount: number; last_valid: number } | undefined;
  if (!p) return;
  const st = (await conn().getSignatureStatuses([p.sig], { searchTransactionHistory: true })).value[0];
  if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
    tx(() => {
      db.prepare('UPDATE deposit_progress SET credited = MAX(0, credited - ?) WHERE user_id = ? AND mint = ?').run(p.amount, userId, m);
      db.prepare('DELETE FROM sweep_pending WHERE user_id = ? AND mint = ?').run(userId, m);
      db.prepare('INSERT INTO treasury_ledger(event, bucket, usd, meta, created_at) VALUES (?, ?, ?, ?, ?)').run('deposit_sweep', null, p.amount / 10 ** (_decimals ?? 6), p.sig, now());
    });
  } else if (st?.err || (await conn().getBlockHeight('confirmed')) > p.last_valid) {
    db.prepare('DELETE FROM sweep_pending WHERE user_id = ? AND mint = ?').run(userId, m);
  }
}

// ------------------------------------------------------------------ payouts
export async function sendUsdc(toAddress: string, usd: number): Promise<string> {
  const dec = await decimals();
  const t = treasury();
  const dest = new PublicKey(toAddress);
  const from = getAssociatedTokenAddressSync(mint(), t.publicKey, true);
  const to = getAssociatedTokenAddressSync(mint(), dest, true);
  const amount = BigInt(Math.round(usd * 10 ** dec));
  const txn = new Transaction().add(
    priority(),
    createAssociatedTokenAccountIdempotentInstruction(t.publicKey, to, dest, mint()),
    createTransferCheckedInstruction(from, mint(), to, t.publicKey, amount, dec),
  );
  txn.feePayer = t.publicKey;
  return sendAndConfirmTransaction(conn(), txn, [t], { commitment: 'confirmed' });
}

export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${solanaConfig.cluster === 'mainnet-beta' ? '' : `?cluster=${solanaConfig.cluster}`}`;

/** Execute a pending payout row. On any failure it goes to needs_review and the balance stays held. */
export async function finishPayoutOnchain(id: number, address: string): Promise<{ status: string; tx?: string; url?: string; error?: string }> {
  const row = db.prepare("SELECT usd FROM payouts WHERE id = ? AND status = 'pending'").get(id) as { usd: number } | undefined;
  if (!row) return { status: 'unknown' };
  try {
    const sig = await sendUsdc(address, row.usd);
    finishPayout(id, true, sig);
    return { status: 'completed', tx: sig, url: explorerTx(sig) };
  } catch (e) {
    finishPayout(id, false);
    console.error('[solana] payout failed, needs review:', (e as Error).message);
    return { status: 'needs_review', error: 'Transfer could not be confirmed; an operator will review it' };
  }
}
