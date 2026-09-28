/**
 * Live devnet check of the USDC rails with a throwaway 6-decimal test mint:
 * deposit -> credits -> sweep to treasury, plan purchase from a deposit, and a node payout.
 *
 *   npx tsx scripts/devnet-e2e.ts            (needs devnet SOL: airdrops to a fresh treasury)
 *   TREASURY_WALLET_KEY=<base58> npx tsx scripts/devnet-e2e.ts   (reuse a funded devnet key)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';

const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const conn = new Connection(rpc, 'confirmed');
const treasury = process.env.TREASURY_WALLET_KEY ? Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_WALLET_KEY)) : Keypair.generate();
console.log('treasury', treasury.publicKey.toBase58());

if ((await conn.getBalance(treasury.publicKey)) < 0.2 * LAMPORTS_PER_SOL) {
  console.log('requesting devnet airdrop…');
  const sig = await conn.requestAirdrop(treasury.publicKey, 0.5 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
}
console.log('treasury SOL', (await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL);

const mint = await createMint(conn, treasury, treasury.publicKey, null, 6);
console.log('test USDC mint', mint.toBase58());

process.env.TIDE_DB = join(mkdtempSync(join(tmpdir(), 'tide-devnet-')), 't.db');
process.env.TREASURY_WALLET_KEY = bs58.encode(treasury.secretKey);
process.env.DEPOSIT_WALLET_KEY = randomBytes(32).toString('hex');
process.env.USDC_MINT = mint.toBase58();
process.env.SOLANA_RPC_URL = rpc;

const { createUser, getUser } = await import('../src/auth.ts');
const { getBalance } = await import('../src/billing.ts');
const sol = await import('../src/solana.ts');
const { db } = await import('../src/db.ts');
const billing = await import('../src/billing.ts');

const assert = (c: unknown, m: string) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  ', m); };
const fund = async (owner: string, usd: number) => {
  const ata = await getOrCreateAssociatedTokenAccount(conn, treasury, mint, new PublicKey(owner), true);
  await mintTo(conn, treasury, mint, ata.address, treasury, BigInt(usd * 1e6));
};

// 1. Deposit $5 -> 2,500 credits, swept to treasury.
const alice = createUser('dev', { name: 'alice' });
const addr = sol.getOrCreateDepositWallet(alice.id);
await fund(addr, 5);
const r1 = await sol.checkDeposit(alice.id);
assert(r1.credited === 2500 && getBalance(alice.id) === 2500, `5 USDC -> ${r1.credited} credits`);
assert(!!r1.swept, `swept to treasury: ${r1.swept && sol.explorerTx(r1.swept)}`);
const depAta = await getAccount(conn, getAssociatedTokenAddressSync(mint, new PublicKey(addr), true));
assert(depAta.amount === 0n, 'deposit address emptied');
const r1b = await sol.checkDeposit(alice.id);
assert(r1b.credited === 0 && getBalance(alice.id) === 2500, 'second check does not double-credit');

// 2. Plan purchase: Pro x1 = $12, paid in two deposits, excess becomes credits.
const bob = createUser('dev', { name: 'bob' });
const baddr = sol.getOrCreateDepositWallet(bob.id);
sol.createIntent(bob.id, 'pro', 1);
await fund(baddr, 10);
const r2 = await sol.checkDeposit(bob.id);
assert(r2.heldUsd === 10 && !r2.planActivated, 'partial $10 held against the $12 plan');
await fund(baddr, 3);
const r3 = await sol.checkDeposit(bob.id);
assert(r3.planActivated === 'pro' && r3.credited === 500, `plan activated, $1 excess -> ${r3.credited} credits`);
assert(getUser(bob.id)!.plan === 'pro' && getUser(bob.id)!.plan_expires! > Date.now(), 'bob is on Pro');

// 3. Node payout: $2 USDC to a fresh wallet.
const owner = createUser('dev', { name: 'nodeowner' });
db.prepare('INSERT INTO node_earnings(job_id, user_id, usd, tokens, created_at) VALUES (?, ?, ?, ?, ?)').run('j1', owner.id, 3.5, 1000, Date.now());
const dest = Keypair.generate().publicKey.toBase58();
const id = billing.createPayout(owner.id, dest, 2);
const p = await sol.finishPayoutOnchain(id, dest);
assert(p.status === 'completed', `payout sent: ${p.url}`);
const destAta = await getAccount(conn, getAssociatedTokenAddressSync(mint, new PublicKey(dest), true));
assert(destAta.amount === 2_000_000n, 'recipient holds 2.000000 test-USDC');
assert(Math.abs(billing.nodeBalance(owner.id).available - 1.5) < 1e-9, 'remaining balance $1.50');

console.log('\nall devnet checks passed');
process.exit(0);
