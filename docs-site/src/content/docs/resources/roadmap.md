---
title: Roadmap
description: What is specified but not yet built, and what has shipped since the roadmap was written.
---

:::caution
Everything under **Planned** is not built. Do not build against any tool, package, endpoint or field listed there until it appears in the [Changelog](/resources/changelog/).
:::

## Shipped since the plan

- **0.3.0 — Tier 1 agent capabilities:** `wallet_create`, `get_wallet`, `transfer` with a recipient allowlist, `get_transaction`, `get_history`, PnL on `get_positions`, `stake_sol` / `unstake_sol`, `get_price_history`, `limit_order_create`, `POTSWAP_ALLOWED_TOKENS`.
- **0.4.0 — Launch status:** `get_launch_status`; `get_points` carries reward balance, level and season. API: `/api/launch-pool`, `/api/claims`, season and claim-ladder fields on `/api/stats` and `/api/config`.
- **Agents-first web:** potswap.io home for humans and agents, and `/app/agents` with a config builder (host snippets, caps, dry run, allowlists), the tool overview and the live Season 0 panel.
- **Observations v1 (MCP 0.6.0, SDK 0.2.0, CLI 0.2.0):** signed, slot-anchored observations with an open index (publish / query / verify / consume receipts), `observe_*` tools, `potswap observe` data bot, and `limit_order_create { priceSource: "observations" }`. See [Observations](/agents/observations/).
- **Direct routing + security core (MCP 0.7.0, SDK 0.3.0, CLI 0.3.0):** Raydium CPMM direct quotes and swaps with fee parity, the transaction validator on every signing path, idempotent operations with an `unknown` state. See [Direct DEX routing](/routing/direct-dex-roadmap/).
- **Lending and liquidity (MCP 0.8.0, SDK 0.4.0, CLI 0.4.0):** Jupiter Lend Earn deposits / withdrawals and Raydium CPMM liquidity through the same validator, limits and fee. See [Lending and liquidity](/agents/defi/).
- **Economy engine (server side):** Season 0 airdrop replay, 30-day season budgets, round-trip dampening, weights and levels, reward balances, staking-pool rollover ledger, launch meter, claim intents. Live in code and deployed; waiting on the points database and the published pool address.

## Planned

Potswap's direction is fixed: the open execution and intelligence layer for Solana AI agents, in three layers — **Execute**, **Observe**, **Earn**. The order below is the planned sequence; it can change.

### Agent capabilities (Execute)

- Enforced mode (session-key / smart-wallet signer) so caps hold on-chain.
- Idempotent operations with persistent operation ids and an explicit `UNKNOWN` state, so retries never duplicate a trade.
- **Enforced mode**: a session-key or smart-wallet signer where caps are checked on-chain rather than in software.

### Economy (Earn)

- Points database switched on and the launch-pool address published; `get_points` and `get_leaderboard` return live data, the meter moves.
- Daily treasury job (fee sweep per split) and the claims worker that executes claim intents.
- Token launch runbook when the meter reaches 500 SOL.
- MCP tools `claim_pot`, `stake_pot`, `unstake_pot` after launch.
- Trustless claim program and staking program (on-chain, audited).
- 30% buy-and-burn reported in `/api/stats`.

See [Points and POT](/economy/points-and-pot/) and [Launch meter](/economy/launch-meter/).

### Routing

- Orca Whirlpools and Meteora DLMM adapters after the SDK reaches 1.0; Raydium AMM v4 / CLMM.
- Simulate before sign; "saved vs X" history.

See [Direct DEX routing (roadmap)](/routing/direct-dex-roadmap/).

### Packages and distribution

- **`@potswap/sdk`**: the MCP's core (API client, trade path, limits, strategies, policy) extracted into a standalone package. Does not exist yet.
- **`potswap` CLI** over the SDK. Does not exist yet.
- Remote MCP at `mcp.potswap.io` returning unsigned transactions plus a `submit_signed` tool; `/api/v1/quote` and `/api/v1/order` HTTP endpoints for non-MCP agents.
- Solana Agent Kit and ElizaOS plugins; MCP registry listings; an installable agent skill.

### Observations (Observe)

- Reputation beyond consumption counts, on-chain anchoring of observation hashes, dispute handling, paid feeds.
- Season 2 payout of the 20% observations budget by `publisherShares` (the hook exists; the season engine pays it from Season 2).

### DeFi operations

- Borrowing, more lending markets, concentrated liquidity (CLMM / Whirlpools / DLMM), auto-compounding, scheduler-driven LP strategies.

### Non-goals

A proprietary Potswap agent or chatbot, custodial services, paid-only features in the core, presales or deposits into the launch pool, cross-chain, and perps (for now).
