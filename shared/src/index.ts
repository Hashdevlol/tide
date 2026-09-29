// Wire types and constants shared by the server, the node agent and the web app.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id?: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type NodeType = 'native' | 'browser' | 'image';

export interface NodeCapabilities {
  tools?: boolean;
  think?: boolean;
}

// ---- node -> orchestrator ----
export interface RegisterPayload {
  model: string;
  tokPerSec: number;
  type?: NodeType;
  capabilities?: NodeCapabilities;
  numCtx?: number;
  version?: string;
}
export type RegisterAck = { nodeId: string } | { error: string };

export interface JobTokenMsg { jobId: string; token: string }
export interface JobCompleteMsg {
  jobId: string;
  response: string;
  tokensGenerated: number;
  doneReason?: 'stop' | 'length' | 'tool_calls';
  /** Present when the model ended its turn by calling tools (API passthrough). */
  toolCalls?: ToolCall[];
}
export interface JobErrorMsg { jobId: string; error: string }

export interface NodeStatus {
  nodeId: string;
  model: string;
  type: NodeType;
  status: 'idle' | 'busy';
  tokPerSec: number;
  jobsCompleted: number;
  tokensGenerated: number;
  connectedAt: number;
}

// ---- orchestrator -> node ----
export interface JobNewMsg {
  jobId: string;
  messages: ChatMessage[];
  maxTokens: number;
  think: boolean;
  tools?: unknown[];
  temperature?: number;
}

// ---- client -> orchestrator ----
export interface SubmitPayload {
  messages: ChatMessage[];
  model?: string;
  think?: boolean;
}
export type SubmitAck = { jobId: string; lane: Lane } | { error: string; code?: ErrorCode };

export type Lane = 'free' | 'grant' | 'credits';

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'UNKNOWN_MODEL'
  | 'SAFETY'
  | 'RATE_LIMIT'
  | 'NO_CAPACITY'
  | 'FREE_EXHAUSTED'
  | 'INSUFFICIENT_CREDITS'
  | 'CONTEXT_TOO_LONG'
  | 'TIMEOUT'
  | 'NODE_ERROR'
  | 'NODE_GONE'
  | 'ABORTED';

export interface Usage { inputTokens: number; outputTokens: number; credits: number }

// ---- orchestrator -> client ----
export interface NetworkStats {
  nodesOnline: number;
  browserNodes: number;
  nativeNodes: number;
  imageNodes: number;
  byModel: Record<string, number>;
  busy: number;
  queueDepth: number;
  jobsCompleted: number;
  tokensGenerated: number;
  avgTokPerSec: number;
  at: number;
}

// ---- economics ----
export const CREDITS_PER_USD = 1000; // 1 credit = $0.001 of inference
export const CREDITS_PER_USD_PURCHASED = 500; // pay-as-you-go buys at half value; plans are the cheap path
export const PRICE_IN_PER_M_USD = 0.15;
export const PRICE_OUT_PER_M_USD = 0.9;
export const NODE_SHARE = 0.7;
export const REFERRAL_SHARE = 0.05;

/** Credits for a text job, rounded up, minimum 1. Integer math in micro-credits to avoid float drift. */
export function textCreditCost(inputTokens: number, outputTokens: number): number {
  // $/1M tok * 1000 credits/$ = credits per 1M tok -> micro-credits per token = that value
  const inMicro = Math.round(PRICE_IN_PER_M_USD * CREDITS_PER_USD); // credits per 1M input tokens
  const outMicro = Math.round(PRICE_OUT_PER_M_USD * CREDITS_PER_USD);
  const total = inputTokens * inMicro + outputTokens * outMicro; // in credits * 1e-6
  return Math.max(1, Math.ceil(total / 1_000_000));
}

export const PLANS = {
  free: { id: 'free', name: 'Free', priceUsd: 0, dailyCredits: 20 },
  pro: { id: 'pro', name: 'Pro', priceUsd: 12, dailyCredits: 300 },
  max: { id: 'max', name: 'Max', priceUsd: 30, dailyCredits: 750 },
} as const;
export type PlanId = keyof typeof PLANS;

export const estimateTokens = (s: string) => Math.ceil((s?.length ?? 0) / 4);

// ---- image generation ----
export const IMAGE_MODEL = 'tide-image';
export const IMAGE_CREDITS = 10; // flat price per image (~$0.01)

export interface ImageParams {
  prompt: string;
  negativePrompt?: string;
  width: number;   // 512..1536, multiple of 64
  height: number;
  steps: number;   // 10..60
  cfg: number;     // 1..15
  seed: number;
}
/** orchestrator -> image node */
export interface ImageJobMsg { jobId: string; params: ImageParams }
/** image node -> orchestrator */
export interface ImageResultMsg { jobId: string; image: string /* base64 PNG */ }
export interface ImageFailedMsg { jobId: string; error: string }

const snap64 = (v: number, d: number) => Math.min(1536, Math.max(512, Math.round((Number(v) || d) / 64) * 64));
const clamp = (v: number, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Number.isFinite(+v) && v !== null ? +v : d));
export function normalizeImageParams(p: Partial<ImageParams> & { prompt: string }): ImageParams {
  return {
    prompt: String(p.prompt ?? '').slice(0, 2000),
    negativePrompt: p.negativePrompt ? String(p.negativePrompt).slice(0, 1000) : undefined,
    width: snap64(p.width as number, 1024),
    height: snap64(p.height as number, 1024),
    steps: Math.round(clamp(p.steps as number, 10, 60, 28)),
    cfg: clamp(p.cfg as number, 1, 15, 4),
    seed: Number.isInteger(p.seed) && (p.seed as number) >= 0 ? (p.seed as number) % 2 ** 32 : Math.floor(Math.random() * 2 ** 32),
  };
}
