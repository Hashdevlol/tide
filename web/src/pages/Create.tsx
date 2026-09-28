import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useNetworkStats } from '../lib/socket';
import { fmtInt } from '../lib/format';

const STYLES: { id: string; label: string; pos: string; neg: string }[] = [
  { id: 'none', label: 'None', pos: '', neg: '' },
  { id: 'photo', label: 'Photo', pos: 'photograph, natural light, 35mm, sharp focus, highly detailed', neg: 'illustration, painting, cartoon, 3d render' },
  { id: 'cinematic', label: 'Cinematic', pos: 'cinematic still, dramatic lighting, anamorphic, film grain, color graded', neg: 'flat lighting, amateur' },
  { id: 'anime', label: 'Anime', pos: 'anime illustration, clean line art, vibrant colors, studio quality', neg: 'photorealistic, 3d' },
  { id: 'digital', label: 'Digital art', pos: 'digital painting, concept art, intricate, trending on artstation', neg: 'photo' },
  { id: '3d', label: '3D', pos: '3d render, octane, soft global illumination, studio lighting', neg: 'flat, sketch' },
];
const RATIOS = [
  { id: 'square', label: 'Square', w: 1024, h: 1024 },
  { id: 'portrait', label: 'Portrait', w: 832, h: 1216 },
  { id: 'landscape', label: 'Landscape', w: 1216, h: 832 },
];
const NSFW_ACK = 'tide_nsfw_ack';

interface Item { id: string; image: string; prompt: string; style: string; width: number; height: number; seed: number; createdAt: number }

// ---------------------------------------------------------------- private history (IndexedDB, this browser only)
const DB = 'tide-create', STORE = 'images';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function histAll(): Promise<Item[]> {
  const d = await idb();
  return new Promise((res) => {
    const q = d.transaction(STORE).objectStore(STORE).getAll();
    q.onsuccess = () => res((q.result as Item[]).sort((a, b) => b.createdAt - a.createdAt));
    q.onerror = () => res([]);
  });
}
async function histPut(it: Item) { const d = await idb(); d.transaction(STORE, 'readwrite').objectStore(STORE).put(it); }
async function histDel(id: string) { const d = await idb(); d.transaction(STORE, 'readwrite').objectStore(STORE).delete(id); }

export default function Create() {
  const { me, signedIn, openSignIn, refresh } = useAuth();
  const stats = useNetworkStats();
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [style, setStyle] = useState('none');
  const [ratio, setRatio] = useState('square');
  const [seed, setSeed] = useState('');
  const [nsfw, setNsfw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; code?: string } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [current, setCurrent] = useState<Item | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => { histAll().then((h) => { setItems(h); setCurrent(h[0] ?? null); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    return () => clearInterval(t);
  }, [busy]);

  const imageNodes = stats?.imageNodes ?? 0;

  const toggleNsfw = () => {
    if (nsfw) return setNsfw(false);
    if (localStorage.getItem(NSFW_ACK) || confirm('Allow 18+ content? You confirm you are an adult and that it is legal where you are. Content involving minors is always blocked.')) {
      localStorage.setItem(NSFW_ACK, '1');
      setNsfw(true);
    }
  };

  const generate = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || busy) return;
    if (!signedIn) return openSignIn('Sign in to create images. Each image costs 10 credits, and Free accounts get a daily credit grant.');
    const st = STYLES.find((s) => s.id === style)!;
    const r = RATIOS.find((x) => x.id === ratio)!;
    setBusy(true); setErr(null); setElapsed(0);
    ctl.current = new AbortController();
    try {
      const out = await api<{ image: string; seed: number; width: number; height: number }>('/api/images/generate', {
        body: {
          prompt: [prompt.trim(), st.pos].filter(Boolean).join(', '),
          negative_prompt: [negative.trim(), st.neg].filter(Boolean).join(', ') || undefined,
          width: r.w, height: r.h, seed: seed.trim() ? Number(seed) : undefined, nsfw,
        },
      });
      const it: Item = { id: crypto.randomUUID(), image: out.image, prompt: prompt.trim(), style: st.label, width: out.width, height: out.height, seed: out.seed, createdAt: Date.now() };
      setCurrent(it);
      setItems((xs) => [it, ...xs]);
      histPut(it).catch(() => {});
    } catch (x) {
      const e2 = x as ApiError;
      setErr({ msg: e2.message, code: (e2.body as any)?.code });
    } finally {
      setBusy(false);
      refresh();
    }
  }, [prompt, negative, style, ratio, seed, nsfw, busy, signedIn, openSignIn, refresh]);

  const remove = (id: string) => {
    histDel(id).catch(() => {});
    setItems((xs) => xs.filter((x) => x.id !== id));
    if (current?.id === id) setCurrent(null);
  };

  const r = RATIOS.find((x) => x.id === ratio)!;
  const spendable = me ? me.credits + (me.grant?.remaining ?? 0) : 0;

  return (
    <div className="page wrap create">
      <div className="create-head">
        <div>
          <div className="eyebrow">// create</div>
          <h1>Images, rendered by the network.</h1>
          <p className="muted">Every image is drawn on a community GPU. 10 credits each · private history stays in this browser.</p>
        </div>
        <div className="pill"><span className={`dot${imageNodes ? '' : ' off'}`} /> <span className="mono">{imageNodes} image node{imageNodes === 1 ? '' : 's'} online</span></div>
      </div>

      <div className="create-grid">
        <form className="card stack create-controls" onSubmit={generate}>
          <label className="field">
            <span>Prompt</span>
            <textarea className="textarea" rows={4} value={prompt} maxLength={2000} placeholder="A lighthouse on a cliff at night, waves crashing, bioluminescent sea…"
              onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); }} />
          </label>
          <div className="field">
            <span>Style</span>
            <div className="chips">
              {STYLES.map((s) => <button type="button" key={s.id} className={`chip${style === s.id ? ' on' : ''}`} onClick={() => setStyle(s.id)}>{s.label}</button>)}
            </div>
          </div>
          <div className="field">
            <span>Aspect</span>
            <div className="chips">
              {RATIOS.map((x) => (
                <button type="button" key={x.id} className={`chip${ratio === x.id ? ' on' : ''}`} onClick={() => setRatio(x.id)}>
                  <i className="ratio-glyph" style={{ aspectRatio: `${x.w} / ${x.h}` }} /> {x.label}
                </button>
              ))}
            </div>
          </div>
          <details className="create-adv">
            <summary className="small muted">Advanced</summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <label className="field"><span>Negative prompt</span><input className="input" value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="things to avoid" /></label>
              <label className="field"><span>Seed</span><input className="input mono" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} placeholder="random" /></label>
            </div>
          </details>
          <label className="row small" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={nsfw} onChange={toggleNsfw} /> Allow 18+ content
          </label>
          {err && (
            <div className={`notice ${err.code === 'INSUFFICIENT_CREDITS' ? 'warn' : 'danger'}`}>
              <span>
                {err.code === 'NO_CAPACITY' ? <>No image nodes are online right now. <Link className="link" to="/earn">Run one →</Link></>
                  : err.code === 'INSUFFICIENT_CREDITS' ? <>{err.msg}. <Link className="link" to="/settings#credits">Add credits →</Link></>
                  : err.msg}
              </span>
            </div>
          )}
          <button className="btn btn-foam" disabled={busy || !prompt.trim()}>
            {busy ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Rendering… {elapsed.toFixed(1)}s</> : 'Generate · 10 credits'}
          </button>
          {signedIn && <div className="tiny dim mono">{fmtInt(spendable)} credits available today</div>}
        </form>

        <div className="create-stage">
          <div className="canvas-frame" style={{ aspectRatio: current ? `${current.width} / ${current.height}` : `${r.w} / ${r.h}` }}>
            {busy ? <div className="canvas-wait"><span className="spinner" /><span className="small muted">A node is painting your image…</span></div>
              : current ? <img src={current.image} alt={current.prompt} />
              : <div className="canvas-wait"><span className="small muted">Your image appears here.</span></div>}
          </div>
          {current && !busy && (
            <div className="row-between small">
              <span className="muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.prompt}</span>
              <span className="row" style={{ gap: 8 }}>
                <span className="mono tiny dim">seed {current.seed} · {current.width}×{current.height}</span>
                <a className="btn btn-ghost btn-xs" href={current.image} download={`tide-${current.seed}.png`}>Download</a>
                <button className="btn btn-ghost btn-xs" onClick={() => { setPrompt(current.prompt); setSeed(String(current.seed)); }}>Reuse</button>
              </span>
            </div>
          )}
          {items.length > 0 && (
            <div className="gallery">
              {items.map((it) => (
                <div key={it.id} className={`thumb${current?.id === it.id ? ' on' : ''}`}>
                  <button onClick={() => setCurrent(it)} title={it.prompt}><img src={it.image} alt="" loading="lazy" /></button>
                  <button className="thumb-x" onClick={() => remove(it.id)} aria-label="Delete">×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
