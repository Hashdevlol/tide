import { useEffect, useRef } from 'react';

/**
 * A sea of GPU nodes: each dot is a node, rows form waves, bright dots are serving jobs.
 * `activity` (0..1) raises how often dots light up — tie it to live network load.
 */
export function Sea({ activity = 0.3, className = 'sea', horizon = 0.42 }: { activity?: number; className?: string; horizon?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const act = useRef(activity);
  act.current = activity;

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let W = 0, H = 0, raf = 0, visible = true;
    const rows = 22;
    const gap = 26;
    let hot = new Float32Array(0);
    let cols = 0;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const size = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / gap) + 1;
      hot = new Float32Array(rows * cols);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(cv);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(cv);

    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden) return;
      const t = reduce ? 0 : ms / 1000;
      ctx.clearRect(0, 0, W, H);
      const p = 0.00025 + act.current * 0.0016;
      for (let r = 0; r < rows; r++) {
        const depth = r / rows;
        const y0 = H * horizon + depth * depth * H * (1 - horizon + 0.2);
        const a = 0.12 + depth * 0.5, s = 0.6 + depth * 2.2;
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const x = c * gap + (r % 2) * (gap / 2);
          const wave = Math.sin(c * 0.18 + t * 1.1 + r * 0.35) * (10 + depth * 26) + Math.sin(c * 0.05 - t * 0.6) * 18 * depth;
          if (Math.random() < p) hot[i] = 1;
          hot[i] *= 0.985;
          const h = hot[i];
          ctx.fillStyle = h > 0.05 ? `rgba(61,255,194,${0.35 + h * 0.65})` : `rgba(127,216,255,${a * 0.55})`;
          ctx.beginPath(); ctx.arc(x, y0 + wave, s + h * 2.5, 0, 7); ctx.fill();
          if (h > 0.2) {
            ctx.fillStyle = `rgba(61,255,194,${h * 0.12})`;
            ctx.beginPath(); ctx.arc(x, y0 + wave, s + 14 * h, 0, 7); ctx.fill();
          }
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, [horizon]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
