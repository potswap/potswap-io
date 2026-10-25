---
title: Configuration
description: Every environment variable read by @potswap_io/mcp, with defaults and parsing rules.
---

The server is configured entirely through environment variables, set in the `env` block of your MCP host config or in the shell that runs `--daemon`.

## Wallet

| Variable | Default | Meaning |
|---|---|---|
| `SOLANA_PRIVATE_KEY` | — | Secret key as a base58 string (64 bytes, or a 32-byte seed) or a JSON array of 64 bytes, as exported by Phantom or `solana-keygen`. |
| `SOLANA_KEYPAIR_PATH` | — | Path to a `solana-keygen` JSON file. Used only when `SOLANA_PRIVATE_KEY` is unset. |
| *(file)* | `POTSWAP_STATE_DIR/wallet.json` | Created by `wallet_create` (mode 0600). Used only when both variables are unset. |

With none of the three the server runs read-only. See [Key handling](/security/key-handling/).

## Network

| Variable | Default | Meaning |
|---|---|---|
| `POTSWAP_API` | `https://www.potswap.io` | Base URL of the Potswap API (quotes, orders, token data, prices, points). A trailing slash is stripped. |
| `SOLANA_RPC_URL` | `<POTSWAP_API>/api/rpc` | RPC used for balances. Set your own if you trade a lot. |

## Safety limits

| Variable | Default | Meaning |
|---|---|---|
| `POTSWAP_MAX_TRADE_SOL` | `1` | Refuse any swap or strategy leg whose input is worth more than this many SOL (valued via price). |
| `POTSWAP_MAX_SLIPPAGE_BPS` | `300` | Refuse a requested slippage above this (300 = 3%). |
| `POTSWAP_MAX_DAILY_SOL` | `5` | SOL-equivalent all strategies together may spend per UTC day. |
| `POTSWAP_MAX_STRATEGIES` | `10` | Maximum number of active strategies. |
| `POTSWAP_DRY_RUN` | `false` | `1`, `true` or `yes` (case-insensitive): `swap`, `transfer`, the stake tools and strategy legs never sign; they return or log what would have happened. |
| `POTSWAP_ALLOWED_TOKENS` | — (everything) | Comma-separated mints. When set, every swap, stake and strategy leg must have both mints on the list; refused with `Token not in POTSWAP_ALLOWED_TOKENS. No funds were debited.` before any quote. |
| `POTSWAP_ALLOWED_RECIPIENTS` | — (everyone) | Comma-separated addresses. When set, `transfer` only sends to these. |

Numeric variables must be positive finite numbers; anything else falls back to the default. The 0.01 SOL reserve is fixed and not configurable. See [Limits and policies](/security/limits-and-policies/).

## Strategy state

| Variable | Default | Meaning |
|---|---|---|
| `POTSWAP_STATE_DIR` | `~/.potswap` | Directory holding `wallet.json` (if created), `strategies.json` and `scheduler.lock`. |

See [Strategies](/agents/strategies/#state-file).

## Example: conservative agent

```json
{
  "mcpServers": {
    "potswap": {
      "command": "npx",
      "args": ["-y", "@potswap_io/mcp"],
      "env": {
        "SOLANA_KEYPAIR_PATH": "/home/you/.config/solana/agent.json",
        "POTSWAP_MAX_TRADE_SOL": "0.25",
        "POTSWAP_MAX_SLIPPAGE_BPS": "100",
        "POTSWAP_MAX_DAILY_SOL": "1",
        "POTSWAP_ALLOWED_TOKENS": "So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "POTSWAP_DRY_RUN": "true"
      }
    }
  }
}
```

Remove `POTSWAP_DRY_RUN` once you have reviewed a few dry runs.

## Example: daemon on an always-on machine

```bash
export SOLANA_KEYPAIR_PATH=~/.config/solana/agent.json
export SOLANA_RPC_URL=https://your-rpc.example.com
export POTSWAP_STATE_DIR=~/.potswap
export POTSWAP_MAX_DAILY_SOL=2
npx -y @potswap_io/mcp --daemon
```

The daemon logs its configuration on start: state file, `maxTradeSol`, `maxDailySol`, `DRY RUN` when set, and the wallet public key (or `no wallet (strategies cannot execute)`).

## Where keys are used

- `POTSWAP_API` is the only host the server talks to for quotes, orders and token data. Potswap's proxy adds its own Jupiter key server-side, so you need none.
- `SOLANA_RPC_URL` is used for reading balances (`get_balances`, `get_positions`, limit checks, rebalance weights), for `get_transaction`, and for sending and confirming `transfer` transactions. Swaps are sent through Jupiter's execute endpoint via the Potswap proxy.
