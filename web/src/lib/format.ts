export const fmtInt = (n: number | null | undefined) => Math.round(n ?? 0).toLocaleString('en-US');

export function fmtCompact(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  return fmtInt(v);
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  const v = n ?? 0;
  const d = v !== 0 && Math.abs(v) < 0.01 ? 4 : digits;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtDate(ms: number | null | undefined, withTime = true): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return withTime
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

export const shortAddr = (a?: string | null) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
