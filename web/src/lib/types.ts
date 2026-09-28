import type { PlanId } from '@tide/shared';

export interface PublicUser {
  id: string;
  kind: 'anon' | 'wallet' | 'dev';
  wallet: string | null;
  name: string | null;
  plan: string;
  referralCode: string | null;
  createdAt: number;
}

export interface GrantState { plan: PlanId; total: number; used: number; remaining: number; resetsAt: number }

export interface PlanInfo { id: PlanId; name: string; priceUsd: number; dailyCredits: number }

export interface PricingConfig {
  creditsPerUsd: number;
  creditsPerUsdPurchased: number;
  textRate: { usdPerMInput: number; usdPerMOutput: number };
  typicalMessageCredits: number;
  plans: PlanInfo[];
  devCredits: boolean;
  day: string;
}

export interface Me {
  user: PublicUser;
  credits: number;
  plan: { id: PlanId; expiresAt: number | null };
  grant: GrantState | null;
  freePrompts: { used: number; remaining: number; limit: number };
  freePaused: boolean;
  config: PricingConfig;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
  nodes: number;
  context_window: number;
}

export interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } } | void>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array } | Uint8Array>;
}

declare global {
  interface Window {
    phantom?: { solana?: SolanaProvider };
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
    backpack?: SolanaProvider;
  }
}
