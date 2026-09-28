/**
 * Image mode: serve `tide-image` jobs from ComfyUI (real GPU) or a procedural mock (testing).
 *
 *   tide-node --mode image --token tnt_… --comfy http://127.0.0.1:8188 --comfy-ckpt sd_xl_base_1.0.safetensors
 *   tide-node --mode image --token tnt_… --comfy-workflow my-flux-api.json      (custom graph, see below)
 *   tide-node --mode image --token tnt_… --backend mock
 *
 * A custom workflow is a ComfyUI "API format" JSON where these strings are substituted:
 * "{{prompt}}", "{{negative}}", "{{width}}", "{{height}}", "{{steps}}", "{{cfg}}", "{{seed}}".
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { io, type Socket } from 'socket.io-client';
import { IMAGE_MODEL, type ImageJobMsg, type ImageParams, type RegisterAck } from '@tide/shared';

export interface ImageBackend {
  describe(): string;
  prepare(): Promise<void>;
  render(p: ImageParams, signal: AbortSignal): Promise<Buffer>; // PNG bytes
}

// ------------------------------------------------------------------ PNG encoding (RGB8)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; rgb.subarray(y * width * 3, (y + 1) * width * 3).forEach((v, i) => { raw[y * (width * 3 + 1) + 1 + i] = v; }); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ mock backend
/** Deterministic abstract "tide" art from prompt + seed, so the whole image path can be tested without a GPU. */
export class MockImageBackend implements ImageBackend {
  describe() { return 'mock image renderer'; }
  async prepare() {}
  async render(p: ImageParams, signal: AbortSignal): Promise<Buffer> {
    let h = p.seed >>> 0;
    for (const c of p.prompt) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0), (h ^= h >>> 13), (h >>> 0) / 4294967296);
    const hue = rnd(), f1 = 2 + rnd() * 6, f2 = 1 + rnd() * 4, ph = rnd() * 6.28;
    const hsl = (hh: number, s: number, l: number) => {
      const a = s * Math.min(l, 1 - l);
      const f = (n: number) => { const k = (n + hh * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
      return [f(0) * 255, f(8) * 255, f(4) * 255];
    };
    const { width: W, height: H } = p;
    const rgb = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      if (y % 64 === 0) { await new Promise((r) => setImmediate(r)); if (signal.aborted) throw new Error('aborted'); }
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const wave = Math.sin(u * f1 * 6.28 + ph + Math.sin(v * f2 * 6.28) * 1.5) * 0.5 + 0.5;
        const band = Math.sin((v + wave * 0.25) * 18) * 0.5 + 0.5;
        const [r, g, b] = hsl((hue + wave * 0.15 + v * 0.1) % 1, 0.65, 0.12 + band * 0.45 * (1 - v * 0.4));
        const i = (y * W + x) * 3;
        rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
      }
    }
    await new Promise((r) => setTimeout(r, 300 + p.steps * 20)); // pretend to diffuse
    return encodePng(W, H, rgb);
  }
}

// ------------------------------------------------------------------ ComfyUI backend
export class ComfyBackend implements ImageBackend {
  private clientId = randomUUID();
  constructor(private url: string, private ckpt?: string, private workflowPath?: string) {}
  describe() { return `ComfyUI @ ${this.url} (${this.workflowPath ? `workflow ${this.workflowPath}` : `checkpoint ${this.ckpt}`})`; }

  async prepare() {
    const r = await fetch(`${this.url}/system_stats`).catch(() => null);
    if (!r?.ok) throw new Error(`ComfyUI is not reachable at ${this.url} (start it with --listen)`);
    if (!this.workflowPath && !this.ckpt) throw new Error('--comfy-ckpt <checkpoint file> or --comfy-workflow <api.json> is required');
  }

  private graph(p: ImageParams): Record<string, unknown> {
    if (this.workflowPath) {
      const vals: Record<string, string | number> = {
        prompt: p.prompt, negative: p.negativePrompt ?? '', width: p.width, height: p.height, steps: p.steps, cfg: p.cfg, seed: p.seed,
      };
      const sub = (v: unknown): unknown => {
        if (typeof v === 'string') {
          const whole = v.match(/^\{\{(\w+)\}\}$/);
          if (whole && whole[1] in vals) return vals[whole[1]];
          return v.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vals[k] ?? ''));
        }
        if (Array.isArray(v)) return v.map(sub);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
        return v;
      };
      return sub(JSON.parse(readFileSync(this.workflowPath, 'utf8'))) as Record<string, unknown>;
    }
    return {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: this.ckpt } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negativePrompt ?? 'blurry, low quality, watermark, text', clip: ['4', 1] } },
      '3': { class_type: 'KSampler', inputs: { seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'tide', images: ['8', 0] } },
    };
  }

  async render(p: ImageParams, signal: AbortSignal): Promise<Buffer> {
    const q = await fetch(`${this.url}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: this.graph(p), client_id: this.clientId }) });
    if (!q.ok) throw new Error(`ComfyUI rejected the workflow: ${(await q.text()).slice(0, 300)}`);
    const { prompt_id } = (await q.json()) as { prompt_id: string };
    const onAbort = () => { void fetch(`${this.url}/interrupt`, { method: 'POST' }).catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw new Error('aborted');
        await new Promise((r) => setTimeout(r, 750));
        const h = (await fetch(`${this.url}/history/${prompt_id}`).then((r) => r.json())) as Record<string, { status?: { status_str?: string }; outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>;
        const entry = h[prompt_id];
        if (!entry) continue;
        if (entry.status?.status_str === 'error') throw new Error('ComfyUI reported an error');
        const img = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
        if (!img) continue;
        const v = await fetch(`${this.url}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`);
        if (!v.ok) throw new Error(`could not fetch output image (${v.status})`);
        return Buffer.from(await v.arrayBuffer());
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

// ------------------------------------------------------------------ runner
export async function runImageNode(args: Record<string, string>, log: (s: string) => void, warn: (s: string) => void) {
  const backend: ImageBackend = args.backend === 'mock'
    ? new MockImageBackend()
    : new ComfyBackend(args.comfy ?? 'http://127.0.0.1:8188', args['comfy-ckpt'], args['comfy-workflow']);
  log(`image mode · ${backend.describe()}`);
  await backend.prepare();

  // Smoke test before joining: refuse to register if we can't produce a correctly-sized PNG.
  const test = await backend.render({ prompt: 'a calm ocean at dawn', width: 512, height: 512, steps: 10, cfg: 4, seed: 1 }, new AbortController().signal);
  if (test.readUInt32BE(16) !== 512 || test.readUInt32BE(20) !== 512) throw new Error('test render did not produce a 512x512 PNG');
  log('test render ok');

  const url = args.url ?? 'http://localhost:3001';
  const socket: Socket = io(url, { transports: ['websocket'], auth: { token: args.token }, reconnectionDelay: 2000 });
  const running = new Map<string, AbortController>();
  socket.on('connect', () => {
    socket.emit('node:register', { model: IMAGE_MODEL, tokPerSec: 0, type: 'image', version: '0.1.0' }, (r: RegisterAck) => {
      if ('error' in r) { warn(`registration refused: ${r.error}`); process.exit(2); }
      log(`online as ${r.nodeId} — serving ${IMAGE_MODEL} on ${url}`);
    });
  });
  socket.on('disconnect', (why) => warn(`disconnected (${why}), reconnecting…`));
  socket.on('node:kicked', ({ reason }) => { warn(`removed from network: ${reason}`); process.exit(3); });
  socket.on('image:job', async ({ jobId, params }: ImageJobMsg) => {
    const ctl = new AbortController();
    running.set(jobId, ctl);
    const t0 = Date.now();
    try {
      const png = await backend.render(params, ctl.signal);
      socket.emit('image:result', { jobId, image: png.toString('base64') });
      log(`image ${jobId.slice(4, 12)} · ${params.width}x${params.height} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      if (!ctl.signal.aborted) socket.emit('image:failed', { jobId, error: (e as Error).message });
    } finally {
      running.delete(jobId);
    }
  });
  socket.on('image:cancel', ({ jobId }) => running.get(jobId)?.abort());
  const shutdown = () => { socket.emit('node:unregister'); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
