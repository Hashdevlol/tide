import { createHash, createPublicKey, randomBytes, randomUUID, verify as edVerify, createHmac, timingSafeEqual } from 'node:crypto';
import { db, now } from './db.ts';
import { config } from './config.ts';

export interface User {
  id: string;
  kind: 'anon' | 'wallet' | 'dev';
  wallet: string | null;
  display_name: string | null;
  plan: string;
  plan_expires: number | null;
  referral_code: string | null;
  referred_by: string | null;
  free_prompts_used: number;
  created_at: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const rand = (n = 24) => randomBytes(n).toString('base64url');

const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newReferralCode(): string {
  for (;;) {
    const bytes = randomBytes(6);
    const code = [...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
    if (!db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code)) return code;
  }
}

export function getUser(id: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function createUser(kind: User['kind'], opts: { wallet?: string; name?: string; ref?: string } = {}): User {
  const id = randomUUID();
  let referredBy: string | null = null;
  if (opts.ref && /^[a-z0-9]{4,12}$/.test(opts.ref)) {
    const r = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(opts.ref) as { id: string } | undefined;
    if (r) referredBy = r.id;
  }
  db.prepare(
    `INSERT INTO users(id, kind, wallet, display_name, referral_code, referred_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, opts.wallet ?? null, opts.name ?? null, kind === 'anon' ? null : newReferralCode(), referredBy, now());
  db.prepare('INSERT INTO credits(user_id, balance) VALUES (?, 0)').run(id);
  return getUser(id)!;
}

// ---------- sessions ----------
const SESSION_TTL = 30 * 24 * 3600 * 1000;

export function createSession(userId: string): string {
  const token = `tide_s_${rand()}`;
  db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token), userId, now(), now() + SESSION_TTL,
  );
  return token;
}

export function revokeSession(token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// ---------- API keys / node tokens ----------
export function createApiKey(userId: string, name?: string) {
  const key = `sk-tide-${rand(24)}`;
  const id = randomUUID();
  db.prepare('INSERT INTO api_keys(id, user_id, key_hash, prefix, name, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, userId, sha256(key), key.slice(0, 12), name ?? null, now(),
  );
  return { id, key };
}

export function createNodeToken(userId: string, name?: string) {
  const count = (db.prepare('SELECT COUNT(*) n FROM node_tokens WHERE user_id = ? AND revoked = 0').get(userId) as { n: number }).n;
  if (count >= 5) throw new Error('Maximum of 5 active node tokens per account');
  const token = `tnt_${rand(24)}`;
  const id = randomUUID();
  db.prepare('INSERT INTO node_tokens(id, user_id, token_hash, prefix, name, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, userId, sha256(token), token.slice(0, 8), name ?? null, now(),
  );
  return { id, token };
}

export type Principal =
  | { kind: 'session'; user: User }
  | { kind: 'apikey'; user: User; keyId: string }
  | { kind: 'node'; user: User };

/** Resolve any bearer credential to a user. */
export function resolveToken(token: string | undefined | null): Principal | null {
  if (!token) return null;
  token = token.replace(/^Bearer\s+/i, '').trim();
  if (token.startsWith('tide_s_')) {
    const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as
      | { user_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at < now()) return null;
    const user = getUser(row.user_id);
    return user ? { kind: 'session', user } : null;
  }
  if (token.startsWith('sk-tide-')) {
    const row = db.prepare('SELECT id, user_id FROM api_keys WHERE key_hash = ? AND revoked = 0').get(sha256(token)) as
      | { id: string; user_id: string } | undefined;
    if (!row) return null;
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
    const user = getUser(row.user_id);
    return user ? { kind: 'apikey', user, keyId: row.id } : null;
  }
  if (token.startsWith('tnt_')) {
    const row = db.prepare('SELECT id, user_id FROM node_tokens WHERE token_hash = ? AND revoked = 0').get(sha256(token)) as
      | { id: string; user_id: string } | undefined;
    if (!row) return null;
    db.prepare('UPDATE node_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
    const user = getUser(row.user_id);
    return user ? { kind: 'node', user } : null;
  }
  return null;
}

// ---------- Solana wallet sign-in ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

/** Stateless nonce: "<expiry>.<hmac>" — valid 5 minutes. */
export function walletNonce(wallet: string): string {
  const exp = now() + 5 * 60_000;
  const mac = createHmac('sha256', config.secret).update(`${wallet}:${exp}`).digest('base64url').slice(0, 22);
  return `${exp}.${mac}`;
}

export const signInMessage = (wallet: string, nonce: string) =>
  `Sign in to Tide\n\nWallet: ${wallet}\nNonce: ${nonce}\n\nThis request will not trigger a transaction or cost any fees.`;

export function verifyWalletSignIn(wallet: string, nonce: string, signatureB58: string): boolean {
  const [expStr, mac] = nonce.split('.');
  const exp = Number(expStr);
  if (!exp || exp < now()) return false;
  const expected = createHmac('sha256', config.secret).update(`${wallet}:${exp}`).digest('base64url').slice(0, 22);
  if (!mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const pub = base58Decode(wallet);
  const sig = base58Decode(signatureB58);
  if (pub.length !== 32 || sig.length !== 64) return false;
  // Wrap the raw 32-byte ed25519 key in SPKI DER so node:crypto can use it.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return edVerify(null, Buffer.from(signInMessage(wallet, nonce)), key, sig);
}

export function findOrCreateWalletUser(wallet: string, ref?: string): User {
  const u = db.prepare('SELECT * FROM users WHERE wallet = ?').get(wallet) as User | undefined;
  return u ?? createUser('wallet', { wallet, name: `${wallet.slice(0, 4)}…${wallet.slice(-4)}`, ref });
}

export const hashIp = (ip: string) => createHmac('sha256', config.secret).update(ip).digest('hex').slice(0, 24);
