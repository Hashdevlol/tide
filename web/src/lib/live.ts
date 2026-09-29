import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface FeedReceipt {
  hash: string; node: string; model: string; kind: 'text' | 'image';
  tokensIn: number; tokensOut: number; credits: number; paidUsd: number; ms: number | null; at: number;
}
export interface Feed { receipts: FeedReceipt[]; totals: { jobs: number; tokens: number } }

/** Public receipts of recently completed jobs; `fresh` holds hashes that arrived since the last poll. */
export function useFeed(intervalMs = 8000) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<Feed>('/api/feed?limit=24', { token: null }).then((f) => {
      if (!alive) return;
      const prev = seen.current;
      const next = new Set(f.receipts.map((r) => r.hash));
      setFresh(prev ? new Set([...next].filter((h) => !prev.has(h))) : new Set());
      seen.current = next;
      setFeed(f);
    }).catch(() => {});
    load();
    const t = setInterval(load, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [intervalMs]);
  return { feed, fresh };
}

/** Ease-out count toward `value`; returns the displayed number and a `bump` flag when it rises. */
export function useCountUp(value: number | undefined, ms = 900) {
  const [shown, setShown] = useState(value ?? 0);
  const [bump, setBump] = useState(0);
  const from = useRef(value ?? 0);
  useEffect(() => {
    if (value === undefined) return;
    const start = from.current;
    if (value === start) return;
    if (value > start && start !== 0) setBump((b) => b + 1);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { from.current = value; setShown(value); return; }
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(start + (value - start) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value, ms]);
  return { shown, bump };
}
