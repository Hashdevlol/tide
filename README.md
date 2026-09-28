# Tide

**Compute that flows where it's needed.** Tide is an open network for decentralized AI inference:
anyone can plug in a GPU and earn for every token it serves, and anyone can use open models through an
OpenAI-compatible API — no account wall, no prompt storage.

```
  chat / API client                          node owners
        │ prompt                                  │
        ▼                                         ▼
  ┌──────────────┐   job    ┌───────────────────────────┐   job:new   ┌────────────────────────┐
  │ web + /v1 API │ ───────▶ │ orchestrator (socket.io)  │ ──────────▶ │ tide-node (Ollama /    │
  │ (express)     │ ◀─────── │ queue · routing · billing │ ◀────────── │ llama.cpp / vLLM)      │
  └──────────────┘  tokens  │ canaries · anti-cheat     │   tokens    │ browser node (WebGPU)  │
                            └─────────────┬─────────────┘             └────────────────────────┘
                                          │ margin                      Current (sharded engine,
                                          ▼                             multi-GPU over WAN)
                   treasury ── keeper: buyback + burn $TIDE · USDC rewards to stakers
```

## Repository

| path | what |
| --- | --- |
| `shared/` | wire types + economics constants shared by everything |
| `server/` | HTTP API, OpenAI-compatible `/v1`, orchestrator, billing, Solana rails, staking, keeper |
| `node/` | `tide-node` — the agent a GPU owner runs (backends: Ollama, any OpenAI-compatible server, mock) |
| `web/` | React app: landing, chat, earn (incl. in-browser WebGPU node), pricing, settings, network, docs |
| `current/` | **Current**, the sharded multi-GPU engine — a fork of [leyten/shard](https://github.com/leyten/shard) (Apache-2.0, see `current/NOTICE`) |

## Quick start (local)

Requirements: Node 22+ (uses the built-in `node:sqlite`).

```bash
npm install
npm run dev                  # server on :3001 + web on :5173 (proxied), open http://localhost:5173
```

Serve something so chat has a node:

1. Open **Earn → On my machine**, sign in (a *Dev login* is available outside production), create a node token.
2. Run a node:

```bash
# mock model, no GPU needed (serves "tide-dev", dev servers only)
npx tsx node/src/index.ts --token tnt_… --url http://localhost:3001 --backend mock

# real model through Ollama (pulls qwen3:8b, builds "tide-max")
npx tsx node/src/index.ts --token tnt_… --url http://localhost:3001 --base-model qwen3:8b

# llama.cpp / LM Studio / vLLM / SGLang
npx tsx node/src/index.ts --token tnt_… --backend openai --upstream http://127.0.0.1:8080/v1 --upstream-model my-model
```

Or open **Earn → In this browser** to serve `tide-lite` from a WebGPU tab.

Production: `npm run build && NODE_ENV=production npm start` — the server serves `web/dist` itself.
Configuration lives in `server/.env` (see `server/.env.example`).

## API

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-tide-…" -H "Content-Type: application/json" \
  -d '{"model":"tide-max","stream":true,"messages":[{"role":"user","content":"explain tides in one line"}]}'
```

`GET /v1/models` · `POST /v1/chat/completions` (streaming, `stream_options.include_usage`, tool-call
passthrough, `max_tokens`, `-think` model suffix) · `GET /v1/balance`. Errors follow OpenAI's shape:
402 `insufficient_quota`, 429 rate limit, 503 no capacity, 404 `model_not_found`.

## How the network works

- **Routing.** Jobs queue FIFO and go to an idle node serving the model, picked at random weighted by
  measured speed. A node that drops before streaming anything gets its job re-queued to another node.
- **Billing: reserve, then settle.** Before dispatch the worst case (input + output cap) is reserved from
  the first lane that can pay: anonymous free prompts → welcome prompts → the daily plan grant → purchased
  credits. On completion it settles to the exact tokens delivered; if nothing was delivered it's refunded.
  Prices: $0.15 / M input, $0.90 / M output; 1 credit = $0.001; $1 of USDC buys 500 credits.
  Plans: Free 20 credits/day, Pro $12 (300/day), Max $30 (750/day).
- **Node pay.** 70% of what the user paid (80% with ≥ 500k matured $TIDE staked). Referrers get 5%.
  The rest is protocol margin → 50% buyback-and-burn, 50% USDC to stakers. Free prompts pay nodes from a
  capped treasury subsidy ($50/day, $3/hour).
- **Anti-cheat.** Canary probes (arithmetic + nonce echo), impossible-speed and coherence checks, strikes and
  persistent bans, per-account/IP node caps, minimum account age for free-lane jobs.
- **Privacy.** Prompts and outputs are never written to the database — only token counts for billing.
- **Safety floor.** Only content sexualising minors is blocked (prompt and streamed output). Nothing else is moderated.
- **USDC.** Each account gets a custodial deposit address; "check deposit" credits new USDC (or pays for an
  open plan purchase) and sweeps it to the treasury. Node earnings and staker rewards are paid out in USDC.
- **$TIDE.** Custodial staking: send $TIDE to your staking address; each lot matures after 24h; withdrawals
  take the youngest lots first; no lockup. The keeper (`npm run keeper -w server`) runs daily, dry-run by default.

## Tests

```bash
npm test                           # unit + socket/HTTP integration tests (server)
npm run test:devnet -w server      # live devnet USDC round trip (needs a funded devnet TREASURY_WALLET_KEY)
cd current && python -m pytest tests/test_plan.py tests/test_verify*.py   # Current control plane
```

## Status

| | |
| --- | --- |
| ✅ | orchestrator, billing lanes, OpenAI API, node agent (Ollama / OpenAI-compat / mock), anti-cheat, web app |
| ✅ | USDC deposits + plan checkout + payouts (code complete; devnet run needs a funded treasury) |
| ✅ | $TIDE custodial staking, rewards, keeper (dormant until `TIDE_TOKEN_MINT` is set) |
| ⏳ | Current swarm integration (node announce → placement → ring → receipts), needs NVIDIA GPUs to validate |
| ⏳ | image generation, web-search tool, self-custody on-chain staking program |

## Attribution

Tide is a clean-room reimplementation inspired by [c0mpute / compute.tech](https://compute.tech); no code
from `leyten/c0mpute` (unlicensed) is included. `current/` is a fork of `leyten/shard` under Apache-2.0.
