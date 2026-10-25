---
title: Troubleshooting
description: The errors you will meet, what they mean, and what to do. Every Potswap error states whether funds were debited.
---

Every error message from the Potswap MCP server states whether funds were debited. If a message says `No funds were debited`, nothing was signed or sent.

## "Potswap is busy; retry in a few seconds" (HTTP 429 / 503)

Potswap's hosted proxy shares one Jupiter API key at the free tier (1 request per second). When the upstream returns `429` or `503`, the server waits 1.1 s and retries once; if it is still busy you get:

```text
Potswap is busy; retry in a few seconds. No funds were debited.
```

What to do:

- Retry after a few seconds. Agents that poll should back off.
- If you trade a lot, set `SOLANA_RPC_URL` to your own RPC. Balance and confirmation reads then stop going through the shared proxy. Quotes and orders still route through `potswap.io`.
- `get_trending` is edge-cached and refreshed every 15 s; calling it more often returns the same data.

## "Wallet not configured"

```text
Wallet not configured. Set SOLANA_PRIVATE_KEY or SOLANA_KEYPAIR_PATH, or run wallet_create. No funds were debited.
```

The server started in read-only mode. Either call `wallet_create { confirm: true }` (the agent gets a wallet at `POTSWAP_STATE_DIR/wallet.json`, loaded on later starts), or set one of the two variables in the `env` block of your host config and restart the host. Check:

- `SOLANA_PRIVATE_KEY` must be a base58 secret (64 bytes, or a 32-byte seed) or a JSON array of 64 bytes. Other formats fail with `Private key is not valid base58 or a JSON byte array` or `Keypair JSON must be an array of 64 bytes`.
- `SOLANA_KEYPAIR_PATH` must point to a readable `solana-keygen` JSON file. An unreadable path fails with `Cannot read keypair file at SOLANA_KEYPAIR_PATH`.
- `SOLANA_PRIVATE_KEY` wins when both are set; `wallet.json` in the state directory is used only when neither is set.

Read-only tools (`search_tokens`, `get_token`, `get_trending`, `get_price_history`, `get_quote`, `get_leaderboard`, `get_launch_status`, `get_wallet`, `strategy_list`, `strategy_runs`) work without a wallet. `get_balances`, `get_positions`, `get_points`, `get_history` and `get_transaction` work without a wallet when you pass `wallet` explicitly.

## "Token not in POTSWAP_ALLOWED_TOKENS" / "Recipient not in POTSWAP_ALLOWED_RECIPIENTS"

```text
Token not in POTSWAP_ALLOWED_TOKENS. No funds were debited.
Recipient not in POTSWAP_ALLOWED_RECIPIENTS. No funds were debited.
```

An allowlist is set and the mint (both sides of a swap, stake or strategy leg) or the transfer recipient is not on it. The check runs before any quote. Add the address to the comma-separated list in your host config, or unset the variable to allow everything. `get_wallet` shows the lists in force.

## "No route for this pair right now"

Jupiter found no route for the pair and amount. Common causes:

- Very low liquidity or a brand-new token. Try a smaller amount or check `get_token` for `liquidity`.
- `Amount too small for this route. Try a larger amount.` is returned when the order is below the route minimum.
- The output mint is wrong. Use `search_tokens` to confirm the mint address; `get_quote` and `swap` validate that mints are 32–44 base58 characters but cannot know whether a mint exists.

No funds are debited when a route is missing: the failure happens before anything is signed.

## "Keep at least 0.01 SOL for fees"

The server always keeps a 0.01 SOL reserve for network fees. If your SOL balance minus the reserve is below the requested amount:

```text
Insufficient SOL: balance 0.0150, keep at least 0.01 SOL for fees. No funds were debited.
```

Top up the agent wallet or reduce `amount`. The reserve is not configurable.

## "Refused by safety limit"

Two messages, both before signing:

```text
Refused by safety limit: 5 SOL ≈ 5.000 SOL is above POTSWAP_MAX_TRADE_SOL (1). No funds were debited.
Refused by safety limit: slippage 5% is above POTSWAP_MAX_SLIPPAGE_BPS (3%). No funds were debited.
```

Raise the cap in your host config if the trade is intended. If `amount` is 1,000,000 or more the message adds `Hint: amount is in UI units (1 = 1 SOL), not lamports.` — the most common cause is passing raw units.

Strategy legs can also hit the daily cap: `Daily cap reached (5 SOL). Next legs resume at 00:00 UTC. No funds were debited.` The leg is skipped and logged; the strategy stays active.

## "Quote only (confirm=true to execute)"

Not an error. `swap` without `confirm: true` returns the quote and `confirmRequired: true`. Add `confirm: true` to execute.

## "DRY RUN, nothing signed"

`POTSWAP_DRY_RUN` is set. Remove it (or set it to `false`) to execute real swaps. Accepted truthy values are `1`, `true` and `yes` (case-insensitive).

## Swap failed after signing

These messages come from the on-chain execution step:

| Message | Meaning |
|---|---|
| `Price moved beyond your slippage tolerance. No funds were debited. Try again or raise slippage in settings.` | The route's price moved before landing. |
| `The quote expired before the transaction landed. No funds were debited. Please try again.` | The order's block height passed. |
| `The network was congested and the transaction did not land. No funds were debited. Please try again.` | Jupiter's execute reported the transaction did not land. |
| `Insufficient balance for this swap, including network fees. No funds were debited.` | Balance changed between quote and execution. |

When a signature exists the result includes `signature` and `explorerUrl` so you can verify on Solscan. For messages that end with `If the transaction did not land, no funds were debited.`, check the explorer link.

## Strategy paused itself

After three consecutive failed legs a strategy is paused with `pausedReason: "3 consecutive failures; resume after checking the wallet and route."`. Inspect `strategy_runs {id}` for the reasons, fix the cause (balance, route, reserve), then `strategy_resume {id}`.

## "no scheduler is running in this process"

A strategy was created but another process holds the scheduler lock on the same `POTSWAP_STATE_DIR`. Only one process per state directory runs strategies; the others can still read and write them. Run the daemon (`npx -y @potswap_io/mcp --daemon`) on an always-on machine, or close the other process. See [Strategies](/agents/strategies/#who-runs-the-clock).

## Points show `enabled: false`

`get_points` and `get_leaderboard` return `{ enabled: false }` with a note when the points engine is not switched on. Swaps made now still pay the Potswap fee when the fee is configured; points start with Season 1. See [Points and POT](/economy/points-and-pot/).
