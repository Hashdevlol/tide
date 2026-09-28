import type { NodeType } from '@tide/shared';
import { config } from './config.ts';
import type { SwarmModel } from './swarm.ts';

export interface ModelEntry {
  id: string;                 // public model id
  name: string;
  description: string;
  nodeType: NodeType;         // which kind of node serves it
  /** Model strings a node may register with to serve this entry. */
  nodeModels: string[];
  inputBudget: number;        // max prompt tokens (older turns trimmed to fit)
  outputCap: number;          // max output tokens, also the credit hold basis
  outputCapThink: number;
  devOnly?: boolean;
  /** Served by a Current swarm (one model split across several nodes) instead of single nodes. */
  swarm?: SwarmModel;
}

// Browser nodes run these WebLLM prebuilt models (see web/src/earn/engine.ts).
export const BROWSER_MODELS = ['Qwen3-4B-q4f16_1-MLC', 'Qwen3-1.7B-q4f16_1-MLC'];

export const CATALOG: ModelEntry[] = [
  {
    id: 'tide-max',
    name: 'Tide Max',
    description: 'Flagship open model served by native GPU nodes. Thinking + tool calling.',
    nodeType: 'native',
    nodeModels: ['tide-max', ...(process.env.TIDE_MAX_NODE_MODELS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])],
    inputBudget: 12_000,
    outputCap: 4096,
    outputCapThink: 8192,
  },
  {
    id: 'tide-lite',
    name: 'Tide Lite',
    description: 'Small fast model served by browser nodes over WebGPU.',
    nodeType: 'browser',
    nodeModels: BROWSER_MODELS,
    inputBudget: 1_800,
    outputCap: 2048,
    outputCapThink: 2048,
  },
  {
    id: 'tide-swarm',
    name: 'Tide Swarm',
    description: 'A frontier-size open model split layer-by-layer across community GPUs by Current. Every answer is backed by signed receipts.',
    nodeType: 'native',
    nodeModels: [],
    inputBudget: 12_000,
    outputCap: 512,
    outputCapThink: 512,
    swarm: {
      profile: process.env.TIDE_SWARM_PROFILE ? JSON.parse(process.env.TIDE_SWARM_PROFILE) : 'nvidia/MiniMax-M2.5-NVFP4',
      layerCount: Number(process.env.TIDE_SWARM_LAYERS) || 62,
      manifestRef: process.env.TIDE_SWARM_MANIFEST ?? 'mf1:m25-nvfp4-v1',
    },
  },
  {
    id: 'tide-dev',
    name: 'Tide Dev (mock)',
    description: 'Deterministic mock model for local testing. Dev builds only.',
    nodeType: 'native',
    nodeModels: ['tide-dev'],
    inputBudget: 4_000,
    outputCap: 512,
    outputCapThink: 512,
    devOnly: true,
  },
];

export const DEFAULT_MODEL = 'tide-max';

/** Resolve a public model id (with optional "-think" suffix) to a catalog entry. */
export function resolveModel(id: string | undefined): { entry: ModelEntry; think: boolean } | null {
  let mid = (id || DEFAULT_MODEL).trim();
  let think = false;
  if (mid.endsWith('-think')) { think = true; mid = mid.slice(0, -'-think'.length); }
  const entry = CATALOG.find((m) => m.id === mid && (!m.devOnly || !config.isProd));
  return entry ? { entry, think } : null;
}

export const publicCatalog = () => CATALOG.filter((m) => !m.devOnly || !config.isProd);

export function nodeServes(entry: ModelEntry, nodeModel: string, nodeType: NodeType): boolean {
  return entry.nodeType === nodeType && entry.nodeModels.includes(nodeModel);
}

export function knownNodeModel(model: string, type: NodeType): boolean {
  return publicCatalog().some((e) => nodeServes(e, model, type));
}
