---
title: Non-custodial by design
description: Potswap never holds your keys or funds. The MCP server signs locally with your keypair, and Potswap's hosted services are read-only conveniences.
---

Potswap is infrastructure, not a custodian. Nothing in the system takes possession of your funds or your keys.

## What runs where

| Component | Where it runs | What it can do |
|---|---|---|
| `@potswap_io/mcp` | your machine (the MCP host's process, or `--daemon`) | loads your keypair, builds and signs transactions, enforces limits, stores strategies |
| Potswap API (`www.potswap.io`) | Cloudflare edge | proxies Jupiter quote / order / execute and an RPC with Potswap's own keys; serves token lists, the fee schedule and points data |
| Jupiter | Jupiter's infrastructure | builds the route and lands the signed transaction |
| Solana | the chain | executes the swap from your wallet |

The Potswap API never receives your secret key. It receives the order parameters, your **public** wallet address as `taker`, and the **already signed** transaction. It cannot alter a signed transaction, and it cannot sign one for you.

## Funds never leave your wallet unsigned

- `swap` and every strategy leg sign in-process with your keypair and submit through Jupiter's execute endpoint. If you do not sign, nothing moves.
- `swap` requires `confirm: true`. Without it, the tool returns the quote and `confirmRequired: true`.
- `POTSWAP_DRY_RUN=true` makes every signing path return what it would have done, signing nothing.
- Strategies run only in a process **you** start — your MCP host or the daemon. Potswap operates no server-side scheduler and cannot run a strategy on your behalf.

## Recommended setup

1. **Dedicated agent wallet.** Create a fresh keypair for the agent and fund it with only what the agent should control. Never give an agent your main wallet.
2. **Caps low until trusted.** Start with `POTSWAP_MAX_TRADE_SOL=0.25` or lower and `POTSWAP_DRY_RUN=true`; raise caps as the agent's behaviour proves out. See [Limits and policies](/security/limits-and-policies/).
3. **Own RPC for volume.** `SOLANA_RPC_URL` lets you bypass Potswap's shared RPC proxy for balance reads.
4. **Read the state file.** `~/.potswap/strategies.json` is plain JSON; audit what the agent set up with `strategy_list` and `strategy_runs`.

## What Potswap can see

The hosted API sees the public wallet address, the pair and amount of each order, and the resulting signature (which is public on-chain anyway). The points indexer reads fee transfers on-chain to credit points. No account, email or sign-up exists.

## What this version does not claim

Limits are enforced by the MCP server's software, not by the chain or a smart wallet. A compromised machine or a modified binary could bypass them. An *enforced mode* with a session-key or smart-wallet signer is a named roadmap item; until it exists Potswap does not describe its limits as "enforceable". See [Limits and policies](/security/limits-and-policies/#how-limits-are-enforced) and [Key handling](/security/key-handling/).
