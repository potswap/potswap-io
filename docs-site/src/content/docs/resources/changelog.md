---
title: Changelog
description: Release notes for @potswap_io/mcp.
---

## CLI 0.5.0 · SDK 0.4.1

- `potswap admin sweep | claims | burn`: the owner-run treasury split, claims worker and buy-and-burn (dry-run until `--execute`), recording through `/api/admin/ledger` and `/api/admin/claims` with `CRON_SECRET`.
- SDK: `PublicConfig` carries `season`, `splits`, `potMint`, `claimsOpen`; claim and fee-split helpers exported.

## 0.8.0

Lending and liquidity (with @potswap_io/sdk 0.4.0 and @potswap_io/cli 0.4.0).

- `lend_markets`, `lend_positions`, `lend_deposit`, `lend_withdraw` on Jupiter Lend Earn: Jupiter builds the transaction, the validator checks it, the wallet signs, your RPC sends. Deposits pay the Potswap fee as a separate transfer after confirmation; withdrawals are free.
- `lp_pools`, `lp_position`, `lp_deposit`, `lp_withdraw` on Raydium CPMM pools: deposits built locally with the fee in the same transaction; withdrawals free.
- CLI: `potswap lend …` and `potswap lp …`.

## 0.7.0

Direct routing and the security core (with @potswap_io/sdk 0.3.0 and @potswap_io/cli 0.3.0).

- **Transaction validator** on every signing path: fee payer, program allow-list (+ `POTSWAP_ALLOWED_PROGRAMS`), no delegation / authority changes, CloseAccount only to the wallet, bounded System transfers; lookup-table programs allowed only for aggregator orders.
- **Idempotent operations**: `swap { opId }` records `pending → sent → ok | failed | unknown` in `operations.json`; repeats replay or refuse; new tool `get_operation`.
- **Raydium CPMM direct route**: `get_quote.direct` (net of the same fee), `swap { route: "direct" | "auto" }` built, validated and signed locally, sent through your RPC. Pool discovery via `GET /api/raydium/pools`. Direct execution is enabled once Potswap publishes `feeWallet` in `/api/config`.
- CLI: `potswap swap --route direct|auto --op-id <id>`.

## 0.6.0

Observations v1 (with @potswap_io/sdk 0.2.0 and @potswap_io/cli 0.2.0).

- New tools `observe_publish`, `observe_query`, `observe_verify`, `observe_consume`: signed, slot-anchored market observations on the open Potswap index.
- `limit_order_create` accepts `priceSource: "observations"` and `minPublishers`.
- SDK: `Signer.signMessage`, `signObservation`, `verifyObservation`, `signConsumption`, `observedPrice`; API client methods for the index.
- CLI: `potswap observe <mint…> --kinds … --interval …` (data bot) and `potswap observations <mint>`.

## 0.5.0

The MCP server now runs on `@potswap_io/sdk` (0.1.0); the `potswap` CLI (`@potswap_io/cli` 0.1.0) ships the same engine on the command line. Tool contracts unchanged (27 tools).

## 0.4.0

Launch status.

- New tool `get_launch_status`: launch-pool meter (SOL collected / 500 target, read from chain), current season and day, fee split in force, total unclaimed reward balances and the public claim ladder. Works without a wallet.
- `get_points` now carries `rewardBalanceSol` (20% of your net fees, set aside to buy POT after launch), `level` (Larva / Bee / Queen, up to ×1.25) and `season`.
- Potswap API: `/api/launch-pool`, `/api/claims` (wallet-signed claim intents; open at launch), `/api/stats` adds `unclaimedSol`, `claimLadder` and `season`, `/api/config` adds `splits`, `season`, `launchPool`, `claimsOpen`.

## 0.3.0

Tier 1 agent capabilities.

- `wallet_create` creates a keypair in `POTSWAP_STATE_DIR/wallet.json` (mode 0600) when no wallet is configured; the server loads it on later starts. The secret key is never returned.
- `get_wallet`: public key, funding instructions, active limits and allowlists, scheduler status.
- `transfer`: SOL and SPL / Token-2022 transfers built and signed locally, with recipient-ATA creation. No Potswap fee. Subject to `POTSWAP_ALLOWED_RECIPIENTS`, `POTSWAP_MAX_TRADE_SOL` and the 0.01 SOL reserve.
- `get_transaction` (status, fee, the wallet's SOL and token balance changes) and `get_history` (parsed swaps, transfers, other).
- `get_positions` now includes average cost, unrealised and realised PnL from the wallet's swap history.
- `stake_sol` / `unstake_sol`: SOL ↔ jitoSOL (default) or mSOL through the shared swap engine, with the normal fee and points.
- `get_price_history`: OHLCV candles from the token's top pool (`1m` to `1d`).
- `limit_order_create`: a price-triggered buy or sell that fills once through the strategy scheduler, then completes.
- New allowlists: `POTSWAP_ALLOWED_TOKENS` (every swap, strategy leg and stake must stay inside it) and `POTSWAP_ALLOWED_RECIPIENTS`.

## 0.2.0

Strategies and daemon mode.

- New strategy tools: `dca_create`, `rebalance_create`, `tpsl_create`, `strategy_list`, `strategy_pause`, `strategy_resume`, `strategy_delete`, `strategy_runs`.
- Scheduler runs inside the MCP server while the host is open; `npx -y @potswap_io/mcp --daemon` runs it headlessly 24/7.
- Local JSON state in `~/.potswap/strategies.json` (override with `POTSWAP_STATE_DIR`), atomic writes, redacted before writing; a PID lock keeps one scheduler per state directory.
- New limits: `POTSWAP_MAX_DAILY_SOL` (default 5) across all strategies per UTC day; `POTSWAP_MAX_STRATEGIES` (default 10). A strategy pauses itself after three consecutive failed legs.
- Fee schedule shared with the web app: 2.5% standard, 1% at or above $1,000, staker tier wired but disabled until launch. `get_quote` returns `feeTier`, `feeLabel` and `scheduledFeeBps`.
- `POTSWAP_DRY_RUN=true` applies to every strategy leg.

## 0.1.0

Initial release.

- Local stdio MCP server, run with `npx -y @potswap_io/mcp`; Node 20+.
- Tools: `search_tokens`, `get_token` (with risk badges), `get_trending`, `get_quote`, `swap`, `get_balances`, `get_positions`, `get_points`, `get_leaderboard`.
- Non-custodial local signing from `SOLANA_PRIVATE_KEY` or `SOLANA_KEYPAIR_PATH`; read-only mode without a key.
- Safety: `confirm: true` required for `swap`, `POTSWAP_MAX_TRADE_SOL` (1), `POTSWAP_MAX_SLIPPAGE_BPS` (300), `POTSWAP_DRY_RUN`, 0.01 SOL reserve, secret redaction on every output.
- Every error states whether funds were debited.
