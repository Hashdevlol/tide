/**
 * JS port of Current's receipt signer (current/shard/receipt.py, schema "shard-receipt/1").
 * A receipt commits to the activation hash-chain one stage saw for one job, signed with the
 * node's ed25519 key over the canonical JSON (sorted keys, no whitespace, minus "sig").
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export const SCHEMA = 'shard-receipt/1';

export interface Receipt {
  swarm_id: string; job_id: string; layer_start: number; layer_end: number; nonce?: string;
  schema: string; n_chunks: number; in_root: string; out_root: string; pubkey: string; sig: string;
}

export function canonical(obj: Record<string, unknown>): Buffer {
  const sortDeep = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sortDeep)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]))
      : v;
  const { sig: _sig, ...rest } = obj;
  return Buffer.from(JSON.stringify(sortDeep(rest)), 'utf8');
}

export function newNodeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, pubkeyB64: rawPub(publicKey) };
}

export function rawPub(pub: KeyObject): string {
  // SPKI DER for ed25519 is a fixed 12-byte prefix + the 32 raw key bytes.
  return (pub.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64');
}

export class ReceiptSigner {
  private inH = createHash('sha256');
  private outH = createHash('sha256');
  private n = 0;
  constructor(private key: KeyObject, private pubkeyB64: string, private meta: { swarm_id: string; job_id: string; layer_start: number; layer_end: number; nonce?: string }) {}

  observe(inBytes: Uint8Array, outBytes: Uint8Array) {
    this.inH.update(createHash('sha256').update(inBytes).digest());
    this.outH.update(createHash('sha256').update(outBytes).digest());
    this.n++;
  }

  finalize(): Receipt {
    const body = {
      ...this.meta, schema: SCHEMA, n_chunks: this.n, in_root: this.inH.digest('hex'), out_root: this.outH.digest('hex'), pubkey: this.pubkeyB64,
    };
    return { ...body, sig: sign(null, canonical(body), this.key).toString('base64') } as Receipt;
  }
}
