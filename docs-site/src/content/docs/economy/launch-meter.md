---
title: Launch meter
description: The public meter that tracks the fee-funded launch pool toward its 500 SOL target, what fills it, and what happens when it is full.
---

:::note[Status]
The meter is **live in the API, the web app and the MCP server** (`/api/launch-pool`, the landing page, `/app/earnings`, `get_launch_status`). It reads the pool balance from chain. Until Potswap publishes the launch-pool address it shows **0 / 500 SOL** with `enabled: false`. No fees are swept before the address is published and the Season 0 page has had legal review.
:::

## What it is

A single public number: the SOL balance of the **launch-pool address**, read from chain, shown against a fixed target of **X = 500 SOL**. When the meter reaches X, the POT token launches.

## What fills it

Only protocol fees. During Season 0 (pre-launch), **60% of every net fee** (net = after Jupiter's 20%) moves to the launch-pool address by a daily treasury job that sweeps the referral accounts. The address is a Squads multisig once it holds more than 50 SOL.

Nothing else can fill it:

- No deposits, presales or contributions are accepted from anyone. The meter is a legal boundary, not a fundraising target; the design calls for legal review before it passes 50%.
- The only way to move the meter is to trade through Potswap (web or MCP) and pay the fee.

## Where it shows

- **`GET /api/launch-pool`** — JSON, cached 60 s:

  ```json
  {
    "enabled": true,
    "address": "<launch pool address>",
    "balanceSol": 125.4,
    "targetSol": 500,
    "pct": 25.08,
    "remainingSol": 374.6,
    "reached": false,
    "launch": null,
    "season": { "n": 0, "dayIndex": null, "start": null, "end": null },
    "splits": { "launchPool": 0.6, "rewardBalances": 0.2, "burn": 0, "team": 0.2 },
    "rules": "Only protocol fees enter the pool. No deposits, presales or contributions are accepted."
  }
  ```

  `enabled: false` with `address: null` means the address is not published yet. An RPC failure adds `error: "Balance temporarily unavailable"` and keeps the shape.
- **Landing page and `/app/earnings`** — the meter card, next to points this epoch, reward balance (SOL), season and level.
- **MCP** — `get_launch_status` returns the same object plus `unclaimedSol`, `claimLadder` and `potDistributedMicro` from `/api/stats`.

## What happens at X

The launch runbook executes, scripted and auditable:

1. Mint 1,000,000,000 POT; revoke the mint authority.
2. Seed a Meteora / Raydium pool with 20% of supply and **all** pool SOL; lock the LP.
3. Publish the Season 0 Merkle snapshots (the 25% airdrop, replayed day by day: day *k* unlocks at launch + *k* days).
4. Start Season 1 (30 days, 20M POT ≈ 667k/day). `launch` in the API becomes the launch date; `season.n` becomes 1.

From that point, the fee split changes to 20% reward balances / 30% burn / 50% team and operations, the launch pool receives nothing further, and `/api/claims` opens so reward balances can buy POT.

## For agents

Read the meter as public information: an agent may use it to decide when a Season 0 position is worth building (every day traded earns a slice of the 250M airdrop). Potswap exposes no way to contribute to the pool except trading. See [Points and POT](/economy/points-and-pot/) for the full economy.
