---
title: Direct DEX routing
description: The Raydium CPMM direct route next to the aggregator — how it is quoted, how the same fee is charged, how the transaction is built and validated locally — and the adapters still to come.
---

Potswap quotes every order through Jupiter Swap V2 meta-aggregation. Since `@potswap_io/mcp` 0.7.0 (`@potswap_io/sdk` 0.3.0) it also quotes and executes **directly against a Raydium CPMM pool** when one exists for the pair. The direct route is the fallback proof: Potswap keeps working, and stays honest about price, even if the aggregator is down or wrong.

## What you see in `get_quote`

```json
"direct": {
  "poolId": "47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4",
  "router": "raydium-cpmm",
  "outAmount": 0.98,
  "priceImpactPct": 1.02,
  "poolTradeFeeBps": 30,
  "savedVsAggregatorPct": -5.3,
  "tvlUsd": 580
}
```

`direct` is `null` when no CPMM pool exists for the pair, when the pool is paused or empty, or when pool data could not be read. The comparison is **net of the same Potswap fee**: the direct quote deducts the scheduled fee from the input before the pool math, exactly as the aggregator route carries it inside the order. A negative `savedVsAggregatorPct` means the aggregator is better, which is the usual case for liquid pairs.

## How the direct route works

1. **Discovery**: `GET /api/raydium/pools?mint1&mint2` (Raydium's public API behind Potswap's edge cache, 60 s) lists CP-Swap pools for the pair; up to three, by TVL, are read.
2. **Pool state**: the SDK reads `PoolState`, `AmmConfig` and both vault accounts through your RPC, nets protocol and fund fees out of the vaults, checks the pool is open and swaps are enabled.
3. **Quote**: constant product with the pool's `tradeFeeRate` (fee on input, ceiling rounding on the new output reserve, matching the program).
4. **Transaction** (`swap { route: "direct" }`): built on your machine as one v0 transaction: compute budget → (wrap SOL into the wallet's wSOL account) → **Potswap fee** as a token transfer of the scheduled bps to the published fee wallet → create the output account → `swap_base_input(amount_in − fee, minimum_out)` → (unwrap). `minimum_out` applies your `slippageBps` (default 50).
5. **Validator, sign, send**: the [instruction validator](/security/limits-and-policies/#the-transaction-validator) runs in strict mode (no lookup-table programs allowed); then the wallet signs, the SDK sends through your RPC and confirms. Outcomes follow the same shape as aggregator swaps and every message says whether funds were debited.

`route: "auto"` executes whichever of the two has the higher net output. The default stays `jupiter`.

## Fee parity

The direct route pays the same scheduled fee (2.5%, 1% at or above $1,000, staker tier) as a transfer of the input token to Potswap's **fee wallet**, published as `feeWallet` in `GET /api/config`. Until that address is published, direct quotes still appear but direct execution is refused with `Direct route is not enabled yet: Potswap has not published its fee wallet. The aggregator route works as usual. No funds were debited.` Points for direct swaps start once the fee wallet's token accounts are added to the points indexer; the docs will say so when it happens.

## Limits of this version

- One adapter: Raydium CP-Swap (constant product). Raydium AMM v4 / CLMM, Orca Whirlpools and Meteora DLMM are **not** built; they follow after the SDK reaches 1.0.
- No simulate-before-sign and no "saved vs X" history yet.
- The pool read is three RPC calls; agents on the shared Potswap RPC should not quote direct in tight loops.

## Roadmap

- Orca Whirlpools and Meteora DLMM adapters, then AMM v4 / CLMM.
- Simulate before sign; aggregator-vs-direct comparison history.
- Enforced mode (session keys / smart wallet) so caps hold on-chain, not only in software.
