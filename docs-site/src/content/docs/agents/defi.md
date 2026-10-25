---
title: Lending and liquidity
description: Put idle balances to work through the same engine — Jupiter Lend Earn deposits and Raydium CPMM liquidity — with the same limits, validator and fee as swaps.
---

Since `@potswap_io/mcp` 0.8.0 (`@potswap_io/sdk` 0.4.0, `@potswap_io/cli` 0.4.0) an agent can lend and provide liquidity without leaving the toolkit. One protocol each, chosen for simplicity and auditability; both run through the non-custodial path: build or fetch the transaction → [validator](/security/limits-and-policies/#the-transaction-validator) → local signature → your RPC.

## Lending: Jupiter Lend Earn

| Tool | Does |
|---|---|
| `lend_markets` | Earn markets (USDC, USDT, SOL, JupUSD, EURC, USDS, …) with `supplyApyPct`, `rewardsApyPct`, `totalAssets`, `assetMint`, `shareToken`. No wallet. |
| `lend_positions {wallet?}` | Your positions: `shares`, `underlying`, `underlyingUsd`. |
| `lend_deposit {mint, amount, confirm}` | Deposits into the market for `mint`. Without `confirm` it returns the plan (APY, fee). With it: Jupiter builds the transaction (through Potswap's proxy), the validator checks it (Jupiter Lend program allow-listed; lookup tables allowed since Jupiter is a trusted builder), the wallet signs, your RPC sends and confirms. |
| `lend_withdraw {mint, amount? \| all, confirm}` | Withdraws an amount or the whole position. **Free.** |

Deposits count against `POTSWAP_MAX_TRADE_SOL` and `POTSWAP_ALLOWED_TOKENS`.

**The fee on deposits.** Entries pay the scheduled Potswap fee (2.5%, 1% at or above $1,000) on the deposited token, like a swap. Because the deposit transaction is pre-built by Jupiter, the fee is a **separate transfer sent after the deposit confirms**. If that transfer fails the deposit stands and the result says `feeCollected: false` with the reason; no points accrue for it. Until Potswap publishes `feeWallet` in `/api/config`, no fee is charged on lending (and no points), and the plan says so.

```json
{ "tool": "lend_deposit", "arguments": { "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "amount": 25, "confirm": true } }
```

Result: `signature`, `explorerUrl`, `market`, `supplyApyPct`, `feeBps`, `fee`, `feeSignature`, `feeCollected`, `feeNote`, `pointsAdded`.

## Liquidity: Raydium CPMM

Built on the [direct routing](/routing/direct-dex-roadmap/) adapter, so pool state is read from chain and the transaction is built locally.

| Tool | Does |
|---|---|
| `lp_pools {mintA, mintB}` | CPMM pools for the pair with live reserves (net of protocol and fund fees), LP supply, trade fee, TVL, `swapEnabled`. |
| `lp_position {poolId, wallet?}` | LP balance, share of the pool and the two token amounts it represents at current reserves. |
| `lp_deposit {poolId, mint, amount, maxSlippageBps?, confirm}` | `amount` of `mint` (one side); the other side and the LP amount follow the reserves: `lp = floor(amount × lpSupply / reserve)`, `other = ceil(lp × otherReserve / lpSupply)`. The Potswap fee comes off the given side **in the same transaction** (wrap SOL → fee transfer → LP account → `deposit(lp, max0, max1)` → unwrap). `maximum_token_*` = amounts × (1 + slippage), default 50 bps. |
| `lp_withdraw {poolId, lpAmount? \| pct?, maxSlippageBps?, confirm}` | Burns LP tokens for both sides with `minimum_token_*` = share × (1 − slippage). **Free.** |

The plan returned without `confirm` shows both token amounts, the LP tokens and the fee, so an agent can check the other side's balance before committing; the tool refuses with a plain message when that balance is short.

```json
{ "tool": "lp_deposit", "arguments": { "poolId": "47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4", "mint": "So11111111111111111111111111111111111111112", "amount": 0.05, "confirm": true } }
```

## CLI

```bash
potswap lend markets
potswap lend deposit USDC 25 --confirm
potswap lend withdraw USDC all --confirm
potswap lp pools SOL USDC
potswap lp deposit <poolId> SOL 0.05 --confirm
potswap lp withdraw <poolId> 50% --confirm
```

## What is not here

Borrowing, leverage, other lending markets, concentrated liquidity (Raydium CLMM, Orca Whirlpools, Meteora DLMM), auto-compounding and scheduler-driven LP strategies are not built. Every refusal and failure says whether funds were debited.
