---
title: MCP tools reference
description: Every tool exposed by @potswap_io/mcp 0.8.0 with its inputs, outputs and error behaviour.
---

`@potswap_io/mcp` 0.8.0 registers 40 tools: research (4), trading (3), wallet and operations (8), rewards (3), strategies (9), the launch meter (1), observations (4), lending (4) and liquidity (4). Each returns a human-readable text summary plus `structuredContent` with the full JSON; both pass through secret redaction before leaving the process. Errors set `isError: true` and always state whether funds were debited.

Conventions used below:

- **Mint**: a base58 string of 32–44 characters. SOL is `So11111111111111111111111111111111111111112`; USDC is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- **UI units**: amounts are in the token's display units (`1` = 1 SOL), never raw lamports or base units.
- **Agent wallet**: the keypair loaded from `SOLANA_PRIVATE_KEY`, `SOLANA_KEYPAIR_PATH` or `POTSWAP_STATE_DIR/wallet.json` (created by `wallet_create`). Tools marked *wallet optional* fall back to it when `wallet` is omitted.
- **Write tools** (`swap`, `transfer`, `stake_sol`, `unstake_sol`, every `*_create`, `wallet_create`) require `confirm: true`; without it they return what they would do and change nothing. `POTSWAP_DRY_RUN=true` makes every write tool a report.

## Research

### `search_tokens`

Find tokens by name, symbol or mint address. Returns up to 20.

| Input | Type | Notes |
|---|---|---|
| `query` | string, 1–64 chars | name, symbol or mint |

Output: `tokens[]` with `mint`, `symbol`, `name`, `decimals`, `usdPrice`, `mcap`, `liquidity`, `isVerified`.

### `get_token`

Full token record with risk badges.

| Input | Type | Notes |
|---|---|---|
| `mint` | mint | required |

Output: `token` (price, mcap, liquidity, holder count, 5m / 1h / 6h / 24h stats, audit data), `riskBadges[]` (each with a `label`) and `riskLevel` from `0` (safe) to `3` (danger).

### `get_trending`

Discovery lists served from Potswap's edge cache, refreshed every 15 s.

| Input | Type | Default |
|---|---|---|
| `kind` | `new` \| `trending` \| `top` \| `graduating` | `trending` |
| `limit` | integer 1–50 | `20` |

Output: `kind` and `tokens[]` with `mint`, `symbol`, `name`, `usdPrice`, `mcap`, `liquidity`, `holders`, `change5m`, `change1h`, `bondingProgress`, `riskLevel`.

### `get_price_history`

OHLCV candles for a token from its top pool.

| Input | Type | Default |
|---|---|---|
| `mint` | mint | |
| `timeframe` | `1m` \| `5m` \| `15m` \| `1h` \| `4h` \| `1d` | `15m` |
| `limit` | integer 1–1000 | `100` |

Output: `mint`, `pool` (`id`, `name`, or `null`), `candles[]` with `time` (unix seconds), `open`, `high`, `low`, `close`, `volume`. A token without a pool returns an empty list and a `reason`.

## Trading

### `get_quote`

Best route across Metis, JupiterZ, DFlow and OKX. Works without a wallet.

| Input | Type | Notes |
|---|---|---|
| `inputMint` | mint | token to sell |
| `outputMint` | mint | token to buy |
| `amount` | number > 0 | UI units of the input token |
| `slippageBps` | integer 1–5000, optional | fixed slippage; omit for Jupiter's auto slippage |

Output:

| Field | Meaning |
|---|---|
| `inputMint`, `inputSymbol`, `outputMint`, `outputSymbol` | the pair |
| `inAmount`, `inAmountRaw` | input in UI units and raw units |
| `outAmount`, `price` | expected output and output-per-input |
| `priceImpactPct` | absolute price impact in percent |
| `slippageBps` | slippage the route was built with |
| `feeBps` | platform fee bps actually on the order (`0` when the fee is not configured) |
| `scheduledFeeBps`, `feeTier`, `feeLabel` | the tier the fee schedule chose (`standard`, `size`, `staker`); `feeTier` / `feeLabel` are `null` when the fee is off |
| `inputUsd` | USD value of the input at quote time, when a price is known |
| `router` | the router that won the meta-aggregation |
| `requestId`, `expiresAt` | Jupiter order id and expiry |
| `direct` | the best Raydium CPMM pool for the pair, net of the same fee (`poolId`, `outAmount`, `priceImpactPct`, `poolTradeFeeBps`, `savedVsAggregatorPct`, `tvlUsd`), or `null`. See [Direct DEX routing](/routing/direct-dex-roadmap/) |

Errors: `No route for this pair right now`, `Amount too small for this route`, `Potswap is busy; retry in a few seconds`. All end with `No funds were debited.`

### `swap`

Executes at the best route, signing with the agent wallet. Requires `confirm: true`; otherwise it returns the quote only. Protected by `POTSWAP_MAX_TRADE_SOL`, `POTSWAP_MAX_SLIPPAGE_BPS`, `POTSWAP_ALLOWED_TOKENS` and the 0.01 SOL reserve.

| Input | Type | Notes |
|---|---|---|
| `inputMint`, `outputMint`, `amount`, `slippageBps` | as `get_quote` | |
| `confirm` | boolean | default `false`; must be `true` to sign |
| `maxSlippageBps` | integer 1–5000, optional | alias used when `slippageBps` is omitted |
| `route` | `jupiter` \\| `direct` \\| `auto` | default `jupiter`; `direct` builds a Raydium CPMM swap locally (same fee); `auto` takes the better net output |
| `opId` | string 4–64, optional | idempotency key; a repeat returns the stored result (see [Idempotent operations](/security/limits-and-policies/#idempotent-operations)) |

Outcomes:

| Outcome | Returned |
|---|---|
| No wallet | error `Wallet not configured. Set SOLANA_PRIVATE_KEY or SOLANA_KEYPAIR_PATH, or run wallet_create. No funds were debited.` |
| Token outside the allowlist | error `Token not in POTSWAP_ALLOWED_TOKENS. No funds were debited.` (checked before any quote) |
| Refused by a limit | error `Refused by safety limit: … No funds were debited.` plus `quote` |
| Refused by the validator | error `Refused by the transaction validator: … No funds were debited.` plus `quote` |
| Repeated `opId` already done | success with `replayed: true` and the stored result; nothing is sent |
| Repeated `opId` still in flight / unknown | error naming the signature to check; `Funds may have been debited.` |
| `confirm` missing | `{ confirmRequired: true, quote }` |
| `POTSWAP_DRY_RUN` set | `{ dryRun: true, quote }`, nothing signed |
| Execution failed | error with the friendly message, plus `signature` and `explorerUrl` when a transaction was sent |
| Success | `signature`, `explorerUrl`, `inAmount`, `inputSymbol`, `outAmount`, `outputSymbol`, `router`, `feeBps`, `feeUsd`, `pointsAdded`, `solEquivalent` |

Execution path (aggregator): fresh order with the agent wallet as `taker` → validator → local signature → `POST /execute`. `pointsAdded` equals `feeUsd` when the Potswap fee is configured, else `0`. Direct route: pool read → local build → validator (strict) → sign → RPC send and confirm; `router` is `raydium-cpmm`.

### `get_operation`

| Input | Type | Default |
|---|---|---|
| `id` | string, optional | an `opId` passed to `swap` |
| `limit` | integer 1–100 | `20` |

With `id`: the record (`state`, `signature`, `result`, `error`, timestamps) or an error when unknown. Without: recent operations newest first.

## Wallet and operations

### `wallet_create`

Generates a new keypair and stores it at `POTSWAP_STATE_DIR/wallet.json` (mode 0600). Only when no wallet is configured.

| Input | Type | Notes |
|---|---|---|
| `confirm` | boolean | must be `true`; otherwise `Set confirm=true to create a wallet. Nothing was created.` |

Output: `publicKey`, `file`, `backup` (a reminder that the file is the only copy of the secret). The secret key is never returned. With a wallet already configured the tool fails with `A wallet is already configured (<pubkey>). Nothing was created.`; an existing file is never overwritten. The server signs with the new wallet immediately and loads it on later starts.

### `get_wallet`

No input. Returns `publicKey` (or `null`), `fund` (funding instructions, or the no-wallet message), `limits` (`maxTradeSol`, `maxDailySol`, `maxSlippageBps`, `dryRun`), `allowedTokens[]`, `allowedRecipients[]`, `schedulerActive`, `stateDir`, `api`, `rpc` (API key redacted).

### `transfer`

Sends SOL or an SPL / Token-2022 token from the agent wallet. **No Potswap fee.** Built and signed locally; the recipient's token account is created when missing.

| Input | Type | Notes |
|---|---|---|
| `to` | address (32–44 base58) | recipient wallet |
| `mint` | mint, optional | omit for SOL |
| `amount` | number > 0 | UI units |
| `confirm` | boolean | must be `true` to send |

Outcomes: no wallet → `Wallet not configured …`; recipient outside `POTSWAP_ALLOWED_RECIPIENTS` → `Recipient not in POTSWAP_ALLOWED_RECIPIENTS. No funds were debited.`; SOL-equivalent above `POTSWAP_MAX_TRADE_SOL` → `Refused by safety limit …`; SOL below the 0.01 reserve → `Insufficient SOL: balance …, keep at least 0.01 SOL for fees. No funds were debited.`; `confirm` missing → `{ confirmRequired: true }`; dry run → `{ dryRun: true }`; on-chain failure → `Transfer failed on-chain: … Check https://solscan.io/tx/<sig>`; success → `signature`, `explorerUrl`.

### `get_transaction`

| Input | Type | Notes |
|---|---|---|
| `signature` | string | transaction signature |
| `wallet` | address, optional | whose balance changes to report; defaults to the agent wallet |

Output: `status` (`processed` \| `confirmed` \| `finalized` \| `failed` \| `not found`), `slot`, `explorerUrl`, and for landed transactions `feeSol`, `error`, `solChange` and `tokenChanges[]` (`mint`, `change`) for the wallet. An unknown signature returns `not found` without an error.

### `get_history` (wallet optional)

| Input | Type | Default |
|---|---|---|
| `wallet` | address, optional | agent wallet |
| `limit` | integer 1–100 | `25` |

Output: `items[]` newest first, each with `signature`, `time`, `kind` (`swap` \| `transfer` \| `other`), `source`, `feeSol`, `failed`, and per kind: swaps carry `inMint`, `inAmount`, `outMint`, `outAmount`; transfers carry `direction` (`in` \| `out`), `counterparty`, `mint`, `amount`.

### `get_balances` (wallet optional)

SOL and SPL balances (Token and Token-2022 programs) with USD values.

| Input | Type | Notes |
|---|---|---|
| `wallet` | address, optional | defaults to the agent wallet |

Output: `wallet`, `totalUsd`, `balances[]` sorted by USD with `mint`, `amount`, `usd`. Fails with `Wallet not configured …` when neither `wallet` nor a key is available.

### `get_positions` (wallet optional)

Holdings with PnL from the wallet's swap history (average-cost method, up to the last 100 swaps).

Input: `wallet` (optional). Output: `wallet`, `sol`, `solUsd`, `positions[]` with `mint`, `amount`, `avgCostUsd`, `costBasisUsd`, `valueUsd`, `unrealisedUsd`, `realisedUsd`. Fields are omitted when no price or no cost basis is known.

### `stake_sol` / `unstake_sol`

Liquid staking as a swap: SOL → jitoSOL (Jito) or mSOL (Marinade) at the best route, and back. Same fee, points, limits and allowlist as `swap`.

| Input | Type | Default |
|---|---|---|
| `amount` | number > 0 | UI units of the input (SOL for staking, jitoSOL / mSOL for unstaking) |
| `provider` | `jito` \| `marinade` | `jito` |
| `confirm` | boolean | `false` |
| `maxSlippageBps` | integer 1–5000, optional | |

Outcomes as `swap`.

## Rewards

### `get_points` (wallet optional)

Points and rewards for a wallet.

Input: `wallet` (optional). Output: `{ enabled: true, … }` with points this epoch, all-time, POT allocated and claimable, next unlock, **`rewardBalanceSol`** (20% of the wallet's net fees, in SOL, to buy POT after launch), `claimsOpen`, **`level`** (`Larva` \| `Bee` \| `Queen`, `multiplier` up to 1.25, `nextAt`) and **`season`** (`n`, `dayIndex`, `start`, `end`); or `{ enabled: false, wallet, note }` while the points engine is not switched on.

### `get_leaderboard`

Top wallets by Potswap fee paid, with POT allocated. No input. Returns `{ enabled: false, note }` while the points engine is not switched on.

### `get_launch_status`

No input, no wallet needed. Returns the launch meter from `/api/launch-pool` (`enabled`, `address`, `balanceSol`, `targetSol`, `pct`, `remainingSol`, `reached`, `launch`, `season`, `splits`, `rules`) plus `unclaimedSol`, `claimLadder[]` (`minPriceUsd`, `maxPriceUsd`, `totalSol`, `claims`) and `potDistributedMicro` from `/api/stats`. See [Launch meter](/economy/launch-meter/).

## Observations

`observe_publish {kind, mint, value, unit?, source, ttlSec?, note?}` (wallet required), `observe_query {mint?, kind?, publisher?, limit?, includeStale?}`, `observe_verify {observation}`, `observe_consume {id}` (wallet required). Full description on [Observations](/agents/observations/).

## Lending and liquidity

`lend_markets`, `lend_positions {wallet?}`, `lend_deposit {mint, amount, confirm}`, `lend_withdraw {mint, amount? | all, confirm}` (Jupiter Lend Earn) and `lp_pools {mintA, mintB}`, `lp_position {poolId, wallet?}`, `lp_deposit {poolId, mint, amount, maxSlippageBps?, confirm}`, `lp_withdraw {poolId, lpAmount? | pct?, maxSlippageBps?, confirm}` (Raydium CPMM). Entries pay the Potswap fee, exits are free. Full description on [Lending and liquidity](/agents/defi/).

## Strategies

All `*_create` tools require a wallet and `confirm: true`; otherwise nothing is created and the error says so. At most `POTSWAP_MAX_STRATEGIES` (default 10) strategies may be active at once. Every created strategy includes `maxSlippageBps` (optional, 1–5000) applied to each of its legs, and every leg respects `POTSWAP_ALLOWED_TOKENS`. See [Strategies](/agents/strategies/) for the engine semantics.

Create tools return `{ strategy, schedulerActive, runs }` with the strategy record, whether this process runs the scheduler, and up to 3 recent runs. The first DCA leg runs at creation when a scheduler is attached.

### `dca_create`

| Input | Type | Notes |
|---|---|---|
| `inputMint`, `outputMint` | mint | must differ |
| `amountPerRun` | number > 0 | UI units of the input token per run |
| `intervalMinutes` | integer 5 – 43,200 (30 days) | |
| `totalRuns` | integer 1–1000, optional | omit for open-ended |
| `maxSlippageBps` | integer 1–5000, optional | |
| `confirm` | boolean | must be `true` |

### `rebalance_create`

| Input | Type | Notes |
|---|---|---|
| `targets` | `{ mint: percent }` | 2–6 assets, must include SOL, must sum to 100 (±0.5) |
| `driftPct` | number 1–50 | default `5` |
| `checkIntervalMinutes` | integer 15 – 10,080 (7 days) | default `60` |
| `minTradeUsd` | number ≥ 1 | default `5`; smaller legs are skipped |
| `maxSlippageBps` | integer 1–5000, optional | |
| `confirm` | boolean | must be `true` |

Keys are mints, not symbols.

### `tpsl_create`

| Input | Type | Notes |
|---|---|---|
| `mint` | mint | the position to protect |
| `sellPct` | number 1–100 | default `100` |
| `takeProfitPct` | number > 0, optional | sell when price ≥ entry × (1 + pct/100) |
| `stopLossPct` | number 0–99, optional | sell when price ≤ entry × (1 − pct/100) |
| `trailingPct` | number 0–99, optional | sell when price ≤ high-water × (1 − pct/100) |
| `exitMint` | mint | default SOL; must differ from `mint` |
| `maxSlippageBps` | integer 1–5000, optional | |
| `confirm` | boolean | must be `true` |

At least one of `takeProfitPct`, `stopLossPct`, `trailingPct` is required. The entry price is the price at creation; if no price is available the tool fails with `No price available for this token right now; try again in a moment. Nothing was created.`

### `limit_order_create`

A price-triggered swap that fills once, then completes. Runs through the strategy scheduler (needs this host open or the daemon).

| Input | Type | Notes |
|---|---|---|
| `side` | `buy` \| `sell` | |
| `mint` | mint | the token bought or sold |
| `quoteMint` | mint | default SOL; must differ from `mint` |
| `amount` | number > 0 | input amount in UI units: quote (SOL) amount for buys, token amount for sells |
| `triggerPriceUsd` | number > 0 | |
| `condition` | `above` \| `below` | fill when the token's USD price is at or past the trigger |
| `expiresAt` | ISO datetime, optional | past this moment the order completes unfilled |
| `priceSource` | `potswap` \| `observations` | default `potswap`; `observations` uses the median of fresh signed observations (see [Observations](/agents/observations/)) |
| `minPublishers` | integer 1–50 | default `2`; distinct publishers required for an observation price |
| `maxSlippageBps` | integer 1–5000, optional | |
| `confirm` | boolean | must be `true` |

Nothing executes at creation. Each scheduler tick checks the price; when the condition holds the leg runs once through the standard swap path (fee, points, caps) and the order becomes `completed`. A missing price never fills.

### `strategy_list`

No input. Returns `schedulerActive`, `stateFile` and `strategies[]`, each with its record plus `lastRun`. Works without a wallet.

### `strategy_pause`, `strategy_resume`, `strategy_delete`

| Input | Type |
|---|---|
| `id` | string, the strategy id |

- `pause` sets `status: paused`, `pausedReason: "paused by user"`, clears `nextRunAt`.
- `resume` re-activates, resets the failure counter and schedules the next run from now (price-triggered kinds simply resume checking). Completed strategies cannot be resumed; create a new one.
- `delete` removes the strategy and keeps its run history.

### `strategy_runs`

| Input | Type | Default |
|---|---|---|
| `id` | string | |
| `limit` | integer 1–200 | `20` |

Returns `runs[]` newest first, each with `at`, `action`, `outcome` (`ok` \| `skipped` \| `failed` \| `dry-run` \| `no-op` \| `completed`), and when relevant `message`, `signature`, `inAmount`, `inputSymbol`, `outAmount`, `outputSymbol`, `feeUsd`, `pointsAdded`, `solEquivalent`.
