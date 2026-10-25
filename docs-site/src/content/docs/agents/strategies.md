---
title: Strategies
description: DCA, rebalance and take-profit / stop-loss as standing orders; who runs the clock, where state lives, and the caps that apply to every leg.
---

Strategies are standing orders that keep running without you. Every leg is an ordinary Potswap swap through the same path as the `swap` tool (quote → limits → fresh order as taker → local signature → execute), so every leg pays the fee and earns POT points, and every leg is subject to the same safety limits.

Four kinds exist in version 0.4.0:

| Kind | Tool | What it does |
|---|---|---|
| DCA | `dca_create` | Buys a fixed amount of a token on a schedule. |
| Rebalance | `rebalance_create` | Keeps the wallet at target percentages, routing through SOL. |
| Take-profit / stop-loss | `tpsl_create` | Sells part of a position when its price crosses a level. |
| Limit order | `limit_order_create` | Buys or sells once when the token's USD price crosses a level, then completes. |

Tool inputs are listed in the [MCP tools reference](/agents/mcp-tools/#strategies).

## DCA

```json
{
  "tool": "dca_create",
  "arguments": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amountPerRun": 0.1,
    "intervalMinutes": 60,
    "totalRuns": 24,
    "confirm": true
  }
}
```

- The first leg runs at creation (when a scheduler is attached), then every `intervalMinutes`.
- `nextRunAt` is always set from the time the leg actually ran, so a window missed during downtime runs once and never as a burst of catch-up legs.
- When `totalRuns` is reached the strategy becomes `completed` and never runs again. Dry-run legs count toward `totalRuns`.

## Rebalance

```json
{
  "tool": "rebalance_create",
  "arguments": {
    "targets": {
      "So11111111111111111111111111111111111111112": 60,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 40
    },
    "driftPct": 5,
    "checkIntervalMinutes": 60,
    "confirm": true
  }
}
```

On each check the engine reads balances and prices, computes current weights, and acts only when some asset is more than `driftPct` percentage points from its target:

1. Sell overweight non-SOL assets to SOL.
2. Buy underweight assets from SOL.

Legs worth less than `minTradeUsd` (default $5) are skipped. Assets not listed in `targets` are never touched. When nothing drifts the check is logged as `no-op` and nothing is swapped.

A target the engine cannot price is excluded from the weights (the remaining targets are re-normalised) and a run is logged with `No price for <mint>; it is excluded until one is available.`

## Take-profit / stop-loss

```json
{
  "tool": "tpsl_create",
  "arguments": {
    "mint": "<BONK mint>",
    "sellPct": 50,
    "takeProfitPct": 50,
    "stopLossPct": 20,
    "trailingPct": 15,
    "confirm": true
  }
}
```

- The entry price is the price at creation. Price is checked on every scheduler tick (every 30 s) while a scheduler runs.
- Triggers, evaluated in this order: take-profit at `entry × (1 + takeProfitPct/100)`; trailing stop at `highWater × (1 − trailingPct/100)`, armed only once the high-water mark is above entry; stop-loss at `entry × (1 − stopLossPct/100)`.
- When a trigger fires the engine sells `sellPct` of the wallet's current balance of `mint` to `exitMint` (default SOL) once, then marks the strategy `completed`.
- If the wallet holds none of the mint at trigger time the run is logged `Nothing to sell; completing.` and the strategy completes.
- A missing price never triggers anything: the check is logged `price unavailable` and skipped.

## Limit orders

```json
{
  "tool": "limit_order_create",
  "arguments": {
    "side": "buy",
    "mint": "<BONK mint>",
    "amount": 0.1,
    "triggerPriceUsd": 0.00001,
    "condition": "below",
    "expiresAt": "2026-12-31T00:00:00Z",
    "confirm": true
  }
}
```

- `amount` is the input: the quote (SOL by default) amount for a buy, the token amount for a sell.
- Nothing executes at creation. On each tick the engine reads the token's USD price; when `condition` holds (`below`: price ≤ trigger, `above`: price ≥ trigger) the leg runs once through the standard swap path and the order becomes `completed`. It never fills twice.
- `expiresAt` in the past completes the order unfilled and logs `Expired unfilled.`
- A missing price never fills. Potswap does not use Jupiter's trigger API (it needs a separate key); the scheduler is the trigger, so a process must be running for the order to fill.

## Who runs the clock

Strategies execute inside the MCP server process while your host app (Claude Desktop, Cursor, Claude Code) is open. For 24/7 operation run the daemon on any always-on machine:

```bash
POTSWAP_STATE_DIR=~/.potswap SOLANA_KEYPAIR_PATH=~/.config/solana/id.json npx -y @potswap_io/mcp --daemon
```

The daemon runs the scheduler without an MCP transport, logs every leg to stderr (redacted), and finishes the in-flight leg on `SIGINT` / `SIGTERM` before exiting.

**One scheduler per state directory.** A PID lock file (`scheduler.lock`) in the state directory makes sure only one process trades. A second process pointed at the same directory still serves the strategy tools (it can list, create, pause, resume, delete) but does not run the scheduler; `strategy_list` reports `schedulerActive: false`, the create tools add a note, and `--daemon` exits with code 2 naming the owner PID. A lock whose PID is no longer alive is reclaimed automatically.

## State file

State lives in `~/.potswap/strategies.json`; override the directory with `POTSWAP_STATE_DIR`. Writes are atomic (temp file + rename) and the content is passed through secret redaction before it touches disk. The last 2,000 runs are kept.

```json
{
  "version": 1,
  "strategies": [
    {
      "id": "dca_m2x4k9abcd",
      "kind": "dca",
      "status": "active",
      "createdAt": "2026-10-24T10:00:00.000Z",
      "nextRunAt": "2026-10-24T11:00:00.000Z",
      "consecutiveFailures": 0,
      "totals": { "runs": 1, "volumeUsd": 18.2, "feeUsd": 0.45, "pointsAdded": 0.45 },
      "inputMint": "So11111111111111111111111111111111111111112",
      "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "amountPerRun": 0.1,
      "intervalMinutes": 60,
      "totalRuns": 24,
      "runsDone": 1
    }
  ],
  "runs": []
}
```

Strategies survive restarts: an active strategy whose `nextRunAt` passed during downtime runs once on the next tick.

## Caps and failure handling

| Rule | Behaviour |
|---|---|
| `POTSWAP_MAX_TRADE_SOL` (default 1) | Applies per leg. A leg above it is skipped with `Refused by safety limit … No funds were debited.`; the strategy stays active. |
| `POTSWAP_MAX_DAILY_SOL` (default 5) | SOL-equivalent all strategies together may spend per UTC day, counted from successful legs. Over the cap: `Daily cap reached (5 SOL). Next legs resume at 00:00 UTC. No funds were debited.` |
| `POTSWAP_MAX_SLIPPAGE_BPS` (default 300) | Applies to each leg's `maxSlippageBps`. |
| `POTSWAP_MAX_STRATEGIES` (default 10) | Maximum active strategies; create fails with `Limit of 10 active strategies reached. Pause or delete one first.` |
| `POTSWAP_DRY_RUN=true` | Every leg becomes a logged quote (`dry-run` outcome); nothing is signed. |
| 3 consecutive failures | The strategy pauses itself with `pausedReason: "3 consecutive failures; resume after checking the wallet and route."` Skipped legs (caps) do not count as failures. |
| No wallet | Create tools fail with `Wallet not configured …`; `strategy_list` and `strategy_runs` still work. |

Each run records `feeUsd` and `pointsAdded`, and the strategy's `totals` accumulate `runs`, `volumeUsd`, `feeUsd` and `pointsAdded`.

## Out of scope in this version

Server-side scheduling (Potswap never holds keys) and per-strategy webhooks are not built. See the [Roadmap](/resources/roadmap/).
