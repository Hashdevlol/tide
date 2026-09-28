import type { SVGProps } from 'react';

const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
type P = SVGProps<SVGSVGElement>;

export const IconSend = (p: P) => <svg {...base} {...p}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
export const IconStop = (p: P) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><rect x="7" y="7" width="10" height="10" rx="2" /></svg>;
export const IconCopy = (p: P) => <svg {...base} {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
export const IconCheck = (p: P) => <svg {...base} {...p}><path d="M20 6 9 17l-5-5" /></svg>;
export const IconRefresh = (p: P) => <svg {...base} {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></svg>;
export const IconTrash = (p: P) => <svg {...base} {...p}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>;
export const IconPlus = (p: P) => <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>;
export const IconMenu = (p: P) => <svg {...base} {...p}><path d="M4 6h16M4 12h16M4 18h10" /></svg>;
export const IconX = (p: P) => <svg {...base} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const IconChevron = (p: P) => <svg {...base} {...p}><path d="m6 9 6 6 6-6" /></svg>;
export const IconArrow = (p: P) => <svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
