import { useEffect, useMemo, useRef } from 'react';

/** Deterministic PRNG so the field is identical on every load. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Chip { x: number; y: number; s: number; o: number; front: boolean }

/**
 * The signature visual: a crowd of GPU chips receding into the paper. Idle chips are grey.
 * Random chips flash cash-green while they serve; every few seconds a decelerating scan
 * "routes" a prompt and one chip locks in.
 */
export function NodeField({ width = 1440, height = 440, seed = 7, onPick }: { width?: number; height?: number; seed?: number; onPick?: (i: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);

  const chips = useMemo(() => {
    const rnd = mulberry32(seed);
    const out: Chip[] = [];
    const rows = 13;
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);                       // 0 = far, 1 = near
      const s = 5 + Math.pow(t, 1.7) * 40;            // chip size
      const y = 28 + Math.pow(t, 1.35) * (height - 90);
      const gap = s * (1.7 + rnd() * 0.25);
      const n = Math.ceil(width / gap) + 2;
      const off = (r % 2) * gap * 0.5 - gap;
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.08) continue;                   // gaps in the crowd
        out.push({ x: off + i * gap + (rnd() - 0.5) * s * 0.3, y: y + (rnd() - 0.5) * s * 0.25, s, o: 0.22 + t * 0.78, front: t > 0.62 });
      }
    }
    return out;
  }, [width, height, seed]);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const els = Array.from(svg.querySelectorAll<SVGGElement>('g.nf-chip'));
    const light = (i: number, ms: number) => {
      const el = els[i];
      if (!el) return;
      el.classList.add('lit');
      setTimeout(() => el.classList.remove('lit'), ms);
    };
    const timers: number[] = [];
    // ambient: random chips serving tokens
    timers.push(window.setInterval(() => {
      for (let k = 0; k < 3; k++) light(Math.floor(Math.random() * els.length), 500 + Math.random() * 900);
    }, reduce ? 4000 : 380));
    // the route: a decelerating scan across near chips that locks on one
    const near = els.map((_, i) => i).filter((i) => chips[i]?.front);
    const route = () => {
      const steps = 14;
      let delay = 0;
      const pick = near[Math.floor(Math.random() * near.length)];
      for (let k = 0; k < steps; k++) {
        const cand = k === steps - 1 ? pick : near[Math.floor(Math.random() * near.length)];
        delay += 40 + Math.pow(k / steps, 2.4) * 260;
        timers.push(window.setTimeout(() => {
          els.forEach((e) => e.classList.remove('scan'));
          els[cand]?.classList.add('scan');
          if (k === steps - 1) {
            els[cand]?.classList.add('chosen');
            onPick?.(cand);
            timers.push(window.setTimeout(() => els[cand]?.classList.remove('chosen', 'scan'), 2600));
          }
        }, delay));
      }
    };
    if (!reduce) {
      timers.push(window.setTimeout(route, 1200));
      timers.push(window.setInterval(route, 5200));
    }
    return () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  }, [chips, onPick]);

  return (
    <svg ref={ref} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice" role="img" aria-label="A field of GPU nodes; one lights up to answer each prompt">
      <style>{`
        .nf-chip .b{fill:#C9C6BD;transition:fill .18s}
        .nf-chip.lit .b{fill:#19E57F}
        .nf-chip.scan .b{fill:#0C0C0C}
        .nf-chip.chosen .b{fill:#19E57F}
        .nf-chip.chosen .halo{opacity:1}
        .nf-chip .halo{opacity:0;transition:opacity .2s}
      `}</style>
      {chips.map((c, i) => (
        <g key={i} className="nf-chip" opacity={c.o} transform={`translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`}>
          <rect className="halo" x={-c.s * 0.35} y={-c.s * 0.35} width={c.s * 1.7} height={c.s * 1.7} fill="none" stroke="#0C0C0C" strokeWidth={Math.max(1, c.s / 14)} />
          {c.front && (
            <g fill="#0C0C0C">
              {[0.22, 0.5, 0.78].map((p) => <rect key={'t' + p} x={c.s * p - c.s * 0.04} y={-c.s * 0.14} width={c.s * 0.08} height={c.s * 0.14} />)}
              {[0.22, 0.5, 0.78].map((p) => <rect key={'b' + p} x={c.s * p - c.s * 0.04} y={c.s} width={c.s * 0.08} height={c.s * 0.14} />)}
            </g>
          )}
          <rect className="b" width={c.s} height={c.s} stroke={c.front ? '#0C0C0C' : 'none'} strokeWidth={c.front ? Math.max(1.2, c.s / 16) : 0} />
          {c.front && <rect x={c.s * 0.34} y={c.s * 0.34} width={c.s * 0.32} height={c.s * 0.32} fill="#0C0C0C" />}
        </g>
      ))}
    </svg>
  );
}
