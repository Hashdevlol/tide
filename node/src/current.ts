/**
 * Current mode: join a swarm that serves one large model split across several GPUs.
 *
 *   tide-node --mode current --token tnt_… --current-dir ~/tide/current --model-dir /models/m25 \
 *             --sidecar ~/bin/sidecar [--public-ip 1.2.3.4] [--vram-mb 30000] [--dry-run]
 *
 * Lifecycle (server side: server/src/swarm.ts):
 *   announce (pubkey + signature, measured VRAM, /24 subnet, libp2p addr) → answer RTT probes →
 *   swarm:assign {lo,hi,peers} → start sidecar tunnels + `python -m shard.stage` → swarm:ready →
 *   head only: `python -m shard.coordinate`, jobs in as NDJSON on stdin, tokens/receipts out on stdout.
 *
 * Status: EXPERIMENTAL. The control-plane protocol is tested end to end against the server; the
 * engine launch follows Current's documented CLIs (docs/INTEGRATION.md, shard/stage.py,
 * shard/coordinate.py, sidecar/README.md) and needs Linux + NVIDIA GPUs + a Current model dir.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { io, type Socket } from 'socket.io-client';

const PORTS = { libp2p: 29600, engine: 29610, forward: 29611, ret: 29612 };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58(buf: Buffer) {
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}

/** One ed25519 seed backs both identities: the engine's receipt key and the sidecar's libp2p PeerId. */
function loadIdentity(path: string) {
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* windows */ }
  }
  const seed = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (seed.length !== 32) throw new Error(`${path} is not a raw base64 ed25519 seed (Current's SHARD_NODE_KEY format)`);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const pub = (createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer).subarray(12);
  // libp2p: protobuf PrivateKey{Type=Ed25519, Data=seed||pub}; PeerId = identity multihash of PublicKey{Type, Data=pub}.
  const libp2pKey = Buffer.concat([Buffer.from([0x08, 0x01, 0x12, 0x40]), seed, pub]);
  const peerId = b58(Buffer.concat([Buffer.from([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]), pub]));
  return { priv, pubB64: pub.toString('base64'), libp2pKey, peerId };
}

function measureVram(override?: string): { free: number; gpu?: string } {
  if (override) return { free: Number(override) };
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free,name', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim().split('\n')[0];
    const [free, name] = out.split(',').map((s) => s.trim());
    return { free: Number(free), gpu: name };
  } catch {
    throw new Error('could not read free VRAM (nvidia-smi); pass --vram-mb');
  }
}

async function publicIp(override?: string) {
  if (override) return override;
  const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) }).catch(() => null);
  const ip = r?.ok ? (await r.text()).trim() : '';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('could not detect public IP; pass --public-ip');
  return ip;
}

function tcpRtt(host: string, port: number): Promise<number | null> {
  return new Promise((res) => {
    const t0 = performance.now();
    const s = connect({ host, port, timeout: 3000 });
    s.once('connect', () => { res(performance.now() - t0); s.destroy(); });
    s.once('error', () => res(null));
    s.once('timeout', () => { res(null); s.destroy(); });
  });
}

interface Assign {
  swarmId: string; model: string; manifestRef: string; layerCount: number; stageIndex: number; nstages: number;
  lo: number; hi: number; head: boolean; tail: boolean; coordinatorNodeId: string; swarmToken: string;
  peers: { nodeId: string; pubkey: string; index: number; lo: number; hi: number; addrs: string[] }[];
}

export async function runCurrentNode(args: Record<string, string>, log: (s: string) => void, warn: (s: string) => void) {
  const dry = !!args['dry-run'];
  const currentDir = resolve(args['current-dir'] ?? 'current');
  const python = args.python ?? (process.platform === 'win32' ? 'python' : 'python3');
  const modelDir = args['model-dir'];
  const sidecarBin = args.sidecar;
  if (!dry) {
    if (!existsSync(join(currentDir, 'shard'))) throw new Error(`--current-dir ${currentDir} is not a Current checkout`);
    if (!modelDir) throw new Error('--model-dir (the model weights directory) is required');
    if (!sidecarBin || !existsSync(sidecarBin)) throw new Error('--sidecar <path to the built Current sidecar binary> is required (see current/sidecar/README.md)');
  }
  const keyPath = args.key ?? process.env.SHARD_NODE_KEY ?? join(homedir(), '.shard_node_key');
  const id = loadIdentity(keyPath);
  const work = join(tmpdir(), `tide-current-${id.peerId.slice(-8)}`);
  mkdirSync(work, { recursive: true });
  const libp2pKeyPath = join(work, 'libp2p.key');
  writeFileSync(libp2pKeyPath, id.libp2pKey, { mode: 0o600 });

  const vram = measureVram(args['vram-mb']);
  const ip = await publicIp(args['public-ip']);
  const subnet = args.subnet ?? ip.split('.').slice(0, 3).join('.');
  const addr = `/ip4/${ip}/tcp/${PORTS.libp2p}/p2p/${id.peerId}`;
  log(`current mode · peer ${id.peerId} · ${vram.gpu ?? 'GPU'} ${Math.round(vram.free / 1024)} GB free · ${dry ? 'DRY RUN' : currentDir}`);

  const url = args.url ?? 'http://localhost:3001';
  const socket: Socket = io(url, { transports: ['websocket'], auth: { token: args.token }, reconnectionDelay: 2000 });
  const procs: ChildProcess[] = [];
  let coord: ChildProcess | null = null;
  let assign: Assign | null = null;

  const stopAll = () => {
    for (const p of procs.splice(0)) p.kill();
    coord = null;
    assign = null;
  };

  const launch = (name: string, cmd: string, argv: string[], env: Record<string, string>, onLine?: (l: string) => void) => {
    log(`${name}: ${cmd} ${argv.join(' ')}`);
    if (dry) return null;
    const p = spawn(cmd, argv, { cwd: currentDir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(p);
    let buf = '';
    p.stdout!.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine?.(line); }
    });
    p.stderr!.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
    p.on('exit', (code) => {
      if (assign && procs.includes(p)) {
        warn(`${name} exited (${code}); leaving the ring`);
        socket.disconnect(); stopAll(); setTimeout(() => socket.connect(), 2000);
      }
    });
    return p;
  };

  const announce = () => {
    const sig = sign(null, Buffer.from(`tide-swarm-announce:${socket.id}`), id.priv).toString('base64');
    socket.emit('node:announce', {
      model: args.model ?? 'tide-swarm', pubkey: id.pubB64, sig, addrs: [addr],
      cap: { free_vram_mb: vram.free, subnet, gpu: vram.gpu, ...(args['up-mbps'] ? { up_mbps: Number(args['up-mbps']) } : {}) },
    }, (r: { ok: boolean; nodeId?: string; reason?: string }) => {
      if (!r.ok) { warn(`announce refused: ${r.reason}`); process.exit(2); }
      log(`in the pool as ${r.nodeId}; waiting for a ring…`);
    });
  };
  socket.on('connect', announce);
  socket.on('disconnect', (why) => { warn(`disconnected (${why})`); stopAll(); });
  socket.on('node:kicked', ({ reason }) => { warn(`removed: ${reason}`); process.exit(3); });

  socket.on('swarm:probe_peers', async ({ peers }: { peers: { nodeId: string; addrs: string[] }[] }) => {
    const rttMs: Record<string, number> = {};
    await Promise.all(peers.map(async (p) => {
      const m = p.addrs.map((a) => a.match(/^\/ip4\/([\d.]+)\/tcp\/(\d+)/)).find(Boolean);
      if (!m) return;
      const ms = await tcpRtt(m[1], Number(m[2]));
      if (ms !== null) rttMs[p.nodeId] = ms;
    }));
    socket.emit('node:rtt', { rttMs });
  });

  socket.on('swarm:assign', (a: Assign) => {
    stopAll();
    assign = a;
    log(`assigned to ${a.swarmId}: stage ${a.stageIndex + 1}/${a.nstages}, layers [${a.lo},${a.hi})${a.head ? ' — coordinator' : ''}`);
    const byIndex = [...a.peers].sort((x, y) => x.index - y.index);
    const next = byIndex[a.stageIndex + 1];
    const prev = byIndex[a.stageIndex - 1];
    const tail = byIndex[byIndex.length - 1];
    const headPeer = byIndex[0];
    const pid = (p?: { addrs: string[] }) => p?.addrs[0]?.split('/p2p/')[1];

    // 1. Tunnels: inbound activations -> our engine; our engine's next hop -> the next stage.
    const sc = ['-key', libp2pKeyPath, '-listen', `/ip4/0.0.0.0/tcp/${PORTS.libp2p}`, '-inbound', `127.0.0.1:${PORTS.engine}`, '-announce', `/ip4/${ip}/tcp/${PORTS.libp2p}`];
    if (next) sc.push('-forward', `127.0.0.1:${PORTS.forward}=${next.addrs.join(',')}`);
    if (a.head && tail) sc.push('-forward', `127.0.0.1:${PORTS.ret}=${tail.addrs.join(',')}`);
    for (const allowed of [pid(prev), a.tail ? pid(headPeer) : undefined].filter(Boolean)) sc.push('-allow', allowed!);
    launch('sidecar', sidecarBin ?? 'sidecar', sc, {});

    // 2. Our block of layers.
    const env = { SHARD_SWARM_TOKEN: a.swarmToken, SHARD_NODE_KEY: keyPath, SHARD_RECEIPTS: '1', SHARD_TRANSPORT: 'libp2p', M25_ENGINE_BIND: '127.0.0.1' };
    const st = ['-m', 'shard.stage', '--stage', String(a.stageIndex), '--nstages', String(a.nstages), '--lo', String(a.lo), '--hi', String(a.hi),
      '--port', String(PORTS.engine), '--dir', modelDir ?? '<model-dir>', '--receipts'];
    if (next) st.push('--next', `127.0.0.1:${PORTS.forward}`);
    launch('stage', python, st, env, (line) => {
      if (line.startsWith('SHARD_STAGE_READY')) { log('stage ready'); socket.emit('swarm:ready', { swarmId: a.swarmId }); }
      else if (line.startsWith('SHARD_STAGE_FATAL')) warn(line);
    });
    if (dry) setTimeout(() => socket.emit('swarm:ready', { swarmId: a.swarmId }), 500);

    // 3. The head also runs the coordinator once the whole ring is up.
    if (a.head) {
      const assignmentsPath = join(work, `${a.swarmId}.assignments.json`);
      writeFileSync(assignmentsPath, JSON.stringify(Object.fromEntries(a.peers.map((p) => [p.pubkey, [p.lo, p.hi]]))));
      socket.once('swarm:ring_ready', ({ swarmId }) => {
        if (swarmId !== assign?.swarmId) return;
        coord = launch('coordinator', python, ['-m', 'shard.coordinate', '--head', `127.0.0.1:${PORTS.engine}`, '--tail', `127.0.0.1:${PORTS.ret}`,
          '--dir', modelDir ?? '<model-dir>', '--receipts'], { ...env, SHARD_ASSIGNMENTS: assignmentsPath }, (line) => {
          const sp = line.indexOf(' ');
          const tag = sp > 0 ? line.slice(0, sp) : line;
          let m: any = {};
          try { m = JSON.parse(line.slice(sp + 1)); } catch { return; }
          if (tag === 'SHARD_COORD_READY') log('coordinator ready — serving');
          else if (tag === 'SHARD_JOB_TOKEN') socket.emit('swarm:job_token', { jobId: m.jobId, delta: m.delta });
          else if (tag === 'SHARD_JOB_DONE') socket.emit('swarm:job_complete', { jobId: m.jobId, response: m.response, tokensGenerated: m.tokensGenerated, receipts: m.receipts });
          else if (tag === 'SHARD_JOB_FATAL') socket.emit('swarm:job_error', { jobId: m.jobId, error: m.error });
        });
      });
    }
  });

  socket.on('swarm:job', (j: { swarmId: string; jobId: string; messages: unknown[]; nonce: string; maxNew: number; reasoning: boolean }) => {
    if (!coord?.stdin) { socket.emit('swarm:job_error', { jobId: j.jobId, error: dry ? 'dry run: no coordinator' : 'coordinator not running' }); return; }
    coord.stdin.write(JSON.stringify({ jobId: j.jobId, swarmId: j.swarmId, nonce: j.nonce, messages: j.messages, maxNew: j.maxNew, reasoning: j.reasoning }) + '\n');
  });
  socket.on('swarm:dissolve', ({ reason }) => { warn(`ring dissolved: ${reason}`); stopAll(); });

  const shutdown = () => { stopAll(); socket.close(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
