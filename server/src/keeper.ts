/**
 * The keeper turns protocol margin into $TIDE value, once a day:
 *   1. resync every staking address with the chain
 *   2. buyback: swap the `buyback` bucket's USDC for $TIDE (Jupiter) and burn exactly what was received
 *   3. rewards: split the `staker_rewards` bucket across matured stake as claimable USDC
 *
 * Dry-run by default: nothing moves unless KEEPER_DRY_RUN=false.
 */
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { db, now, tx } from './db.ts';
import { conn, priority, solanaConfig, treasury } from './solana.ts';
import { bumpStat, distributeRewards, mintInfo, onchainStake, stakingEnabled, syncStake, tokenMint } from './staking.ts';

const env = process.env;
const log = (...a: unknown[]) => console.log(`[keeper ${new Date().toISOString()}]`, ...a);

export const keeperConfig = {
  dryRun: env.KEEPER_DRY_RUN !== 'false',
  minBuybackUsd: Number(env.KEEPER_MIN_BUYBACK_USD) || 5,
  slippageBps: Number(env.KEEPER_SLIPPAGE_BPS) || 500,
  utcHour: Number(env.KEEPER_UTC_HOUR ?? 15),
  jupiter: env.JUPITER_API ?? 'https://lite-api.jup.ag/swap/v1',
};

function bucket(name: string): number {
  return (db.prepare('SELECT usd FROM treasury_buckets WHERE bucket = ?').get(name) as { usd: number }).usd;
}
function bucketMove(name: string, delta: number, event: string, meta?: string) {
  db.prepare('UPDATE treasury_buckets SET usd = usd + ? WHERE bucket = ?').run(delta, name);
  db.prepare('INSERT INTO treasury_ledger(event, bucket, usd, meta, created_at) VALUES (?, ?, ?, ?, ?)').run(event, name, delta, meta ?? null, now());
}

export async function syncAllStakes() {
  const users = db.prepare('SELECT user_id FROM staking_wallets').all() as { user_id: string }[];
  let ok = 0;
  for (const { user_id } of users) {
    try { syncStake(user_id, await onchainStake(user_id)); ok++; } catch (e) {
      // A failed read skips the wallet; never zero someone's stake because the RPC hiccuped.
      log(`stake read failed for ${user_id.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  log(`synced ${ok}/${users.length} staking addresses`);
}

export async function buybackAndBurn() {
  const budget = Math.floor(bucket('buyback') * 100) / 100;
  if (budget < keeperConfig.minBuybackUsd) return log(`buyback: $${budget.toFixed(2)} below minimum $${keeperConfig.minBuybackUsd}, accumulating`);
  if (solanaConfig.cluster !== 'mainnet-beta') return log(`buyback: $${budget.toFixed(2)} ready, but swaps need mainnet liquidity (cluster=${solanaConfig.cluster})`);
  const usdcRaw = Math.floor(budget * 1e6);
  const quote = await fetch(`${keeperConfig.jupiter}/quote?inputMint=${solanaConfig.usdcMint}&outputMint=${tokenMint()}&amount=${usdcRaw}&slippageBps=${keeperConfig.slippageBps}`).then((r) => r.json()) as { outAmount?: string; error?: string };
  if (!quote.outAmount) return log(`buyback: no route (${quote.error ?? 'unknown'}), accumulating`);
  log(`buyback: $${budget.toFixed(2)} -> ~${quote.outAmount} raw $TIDE`);
  if (keeperConfig.dryRun) return log('buyback: dry run, nothing sent');

  const t = treasury();
  const swap = await fetch(`${keeperConfig.jupiter}/swap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: t.publicKey.toBase58(), dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
  }).then((r) => r.json()) as { swapTransaction?: string; lastValidBlockHeight?: number };
  if (!swap.swapTransaction) return log('buyback: swap build failed, will retry next run');
  const vtx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  vtx.sign([t]);

  // Reserve the budget before broadcast; only a definite failure releases it.
  tx(() => bucketMove('buyback', -budget, 'buyback_reserve'));
  let sig: string;
  try {
    sig = await conn().sendRawTransaction(vtx.serialize(), { maxRetries: 3 });
  } catch (e) {
    tx(() => bucketMove('buyback', budget, 'buyback_release', (e as Error).message.slice(0, 200)));
    return log(`buyback: rejected before broadcast, released: ${(e as Error).message}`);
  }
  const conf = await conn().confirmTransaction({
    signature: sig, blockhash: vtx.message.recentBlockhash,
    lastValidBlockHeight: swap.lastValidBlockHeight ?? (await conn().getBlockHeight('confirmed')) + 150,
  }, 'confirmed').catch(() => null);
  if (!conf || conf.value.err) {
    db.prepare('INSERT INTO treasury_ledger(event, bucket, usd, meta, created_at) VALUES (?, ?, ?, ?, ?)').run('buyback_unknown', 'buyback', -budget, sig, now());
    return log(`buyback: outcome unknown for ${sig}; budget stays reserved for manual reconciliation`);
  }

  // Measure what we actually received from the confirmed transaction, never from a balance read.
  const { programId, decimals } = await mintInfo();
  const txInfo = await conn().getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const owner = t.publicKey.toBase58();
  const pick = (arr?: { mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null) =>
    BigInt(arr?.find((b) => b.mint === tokenMint() && b.owner === owner)?.uiTokenAmount.amount ?? '0');
  const received = pick(txInfo?.meta?.postTokenBalances) - pick(txInfo?.meta?.preTokenBalances);
  if (received <= 0n) return log(`buyback: swap ${sig} confirmed but no $TIDE received; flag for review`);

  const mint = new PublicKey(tokenMint());
  const ata = getAssociatedTokenAddressSync(mint, t.publicKey, false, programId);
  const burn = new Transaction().add(priority(), createBurnCheckedInstruction(ata, mint, t.publicKey, received, decimals, [], programId));
  const burnSig = await sendAndConfirmTransaction(conn(), burn, [t], { commitment: 'confirmed' });
  const burned = Number(received) / 10 ** decimals;
  bumpStat('tide_burned', burned);
  bumpStat('buyback_spent_usd', budget);
  db.prepare('INSERT INTO treasury_ledger(event, bucket, usd, meta, created_at) VALUES (?, ?, ?, ?, ?)').run('burn', null, budget, JSON.stringify({ swap: sig, burn: burnSig, tide: burned }), now());
  log(`burned ${burned} $TIDE (swap ${sig}, burn ${burnSig})`);
}

export function payStakers() {
  const pool = Math.floor(bucket('staker_rewards') * 1e6) / 1e6;
  if (pool <= 0) return log('rewards: pool empty');
  if (keeperConfig.dryRun) return log(`rewards: $${pool.toFixed(4)} would be split across matured stake (dry run)`);
  const r = tx(() => {
    const out = distributeRewards(pool);
    if (out.distributed > 0) bucketMove('staker_rewards', -out.distributed, 'staker_distribution', `${out.stakers} stakers`);
    return out;
  });
  if (r.stakers === 0) log(`rewards: no matured stakers, $${pool.toFixed(4)} rolls over`);
  else log(`rewards: $${r.distributed.toFixed(4)} credited to ${r.stakers} stakers (dust stays in pool)`);
}

export async function runKeeper() {
  if (!stakingEnabled()) return log('dormant: set TIDE_TOKEN_MINT, TREASURY_WALLET_KEY and DEPOSIT_WALLET_KEY');
  log(`run start (${keeperConfig.dryRun ? 'DRY RUN' : 'LIVE'})`);
  for (const [name, step] of [['sync', syncAllStakes], ['buyback', buybackAndBurn], ['rewards', payStakers]] as const) {
    try { await step(); } catch (e) { log(`${name} failed: ${(e as Error).message}`); }
  }
  log('run done');
}
