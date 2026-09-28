import { useCallback, useEffect, useState } from 'react';
import type { PlanId } from '@tide/shared';
import { api, errMsg } from './api';

export interface PlanIntent { id: number; plan: PlanId; months: number; expected_usd: number; paid_usd: number; expires_at: number }

export type DepositInfo =
  | { enabled: false }
  | { enabled: true; address: string; mint: string; cluster: string; creditsPerUsd: number; intent: PlanIntent | null };

export interface DepositCheck {
  credited: number;
  planActivated?: PlanId;
  heldUsd?: number;
  balanceUsd: number;
  balance: number;
  sweptUrl?: string;
  message?: string;
}

let cachedCluster: string | null = null;

export const explorerTx = (tx: string, cluster = cachedCluster ?? 'devnet') =>
  `https://explorer.solana.com/tx/${tx}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;
export const explorerAddr = (addr: string, cluster = cachedCluster ?? 'devnet') =>
  `https://explorer.solana.com/address/${addr}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;
export const clusterLabel = (c: string) => (c === 'mainnet-beta' ? 'mainnet' : c);

export function useDeposit(enabled = true) {
  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const d = await api<DepositInfo>('/api/deposit');
      if (d.enabled) cachedCluster = d.cluster;
      setInfo(d);
      setError(null);
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { if (enabled) reload(); }, [enabled, reload]);
  return { info, error, reload };
}

export async function checkDeposit(): Promise<DepositCheck> {
  return api<DepositCheck>('/api/deposit/check', { body: {} });
}

export function describeCheck(r: DepositCheck): string {
  const parts: string[] = [];
  if (r.credited > 0) parts.push(`Credited ${r.credited.toLocaleString('en-US')} credits.`);
  if (r.planActivated) parts.push(`${r.planActivated[0].toUpperCase() + r.planActivated.slice(1)} plan activated.`);
  if (r.heldUsd) parts.push(`$${r.heldUsd.toFixed(2)} applied toward your plan purchase.`);
  if (r.message) parts.push(r.message);
  if (!parts.length) parts.push('No new deposit found yet. Transfers can take a few seconds to confirm.');
  return parts.join(' ');
}
