---
title: Introduction
description: What Potswap is, who it is for, and what exists today versus what is planned.
---

Potswap is Solana DeFi infrastructure for AI agents. It is not an agent itself: it is the swap engine, the safety rails and the rewards layer that any agent can plug into through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

## What you get

- **Best-route swaps.** Every order is quoted through Jupiter Swap V2 meta-aggregation, where Metis, JupiterZ, DFlow and OKX compete and the best net route wins. See [How routing works](/routing/how-routing-works/).
- **A wallet of its own.** `wallet_create` gives an agent a keypair stored on your machine; `transfer`, `get_transaction` and `get_history` cover the operations around trading. See the [tools reference](/agents/mcp-tools/#wallet-and-operations).
- **Standing strategies.** DCA, portfolio rebalancing, take-profit / stop-loss and limit orders run as sequences of ordinary swaps, inside your MCP host or as a 24/7 daemon. See [Strategies](/agents/strategies/).
- **Liquid staking.** `stake_sol` / `unstake_sol` move between SOL and jitoSOL or mSOL at the best route.
- **Token research.** Search, full token records with audit data and risk badges (`riskLevel` 0 safe to 3 danger), and trending / new / top / graduating lists.
- **Wallet views.** SOL and SPL balances with USD values, positions with average cost and PnL, price history, POT points, reward balance, level and the leaderboard.
- **Rewards.** Potswap charges a fee inside the swap; the fee you pay is credited back to your wallet as POT points. See [Points and POT](/economy/points-and-pot/).

## How it is built

- **Non-custodial and local-first.** The MCP server runs on your machine and signs with your own keypair. The secret never leaves the process and is redacted from every output, log line and state file. See [Non-custodial by design](/security/non-custodial/).
- **Safe by default.** Every write tool requires `confirm: true`. Per-trade cap 1 SOL, slippage cap 3%, daily strategy cap 5 SOL, token and recipient allowlists, dry-run mode, and a 0.01 SOL reserve that is always kept. Every error states whether funds were debited. See [Limits and policies](/security/limits-and-policies/).
- **$0 to run.** The server talks only to `potswap.io`, which proxies Jupiter and an RPC with its own keys. You need no API keys. Bring your own RPC if you trade a lot.
- **Open source.** MIT licensed. See [License](/resources/license/).

## What exists today

The package [`@potswap_io/mcp`](https://www.npmjs.com/package/@potswap_io/mcp) (version 0.4.0) ships 27 tools. That is the surface documented as *available* on this site. The Potswap API behind it serves quotes, orders, token data, points, the launch meter and claims.

The economy engine (Season 0 airdrop replay, 30-day seasons, reward balances, claim ladder, launch meter) is built and deployed; it reports `enabled: false` / `0 / 500 SOL` until Potswap switches on the points database and publishes the pool address. The token itself, the on-chain claim and staking programs, the `@potswap/sdk` package, the `potswap` CLI, direct DEX adapters and a remote MCP endpoint are not built. Those items are marked **Roadmap** or **Planned** wherever they appear, and collected on the [Roadmap](/resources/roadmap/) page.

## Where to go next

1. [Quickstart](/getting-started/quickstart/): configure your host and get a first quote.
2. [MCP tools reference](/agents/mcp-tools/): every tool, input and output.
3. [Configuration](/agents/configuration/): every environment variable.
