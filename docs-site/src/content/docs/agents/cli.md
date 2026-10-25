---
title: CLI (potswap)
description: The potswap command line — quotes, swaps, staking, transfers, wallet, points, launch meter and strategy management with the same limits as the MCP server.
---

`@potswap_io/cli` installs the `potswap` command. It runs on `@potswap_io/sdk`, so it reads the same environment variables, applies the same limits and pays the same fee as the MCP server. Node 20+.

```bash
npx -y @potswap_io/cli quote SOL USDC 0.1
npm i -g @potswap_io/cli && potswap --help
```

## Commands

| Command | Does |
|---|---|
| `quote <in> <out> <amount> [--slippage <bps>]` | Best route, output, fee tier, price impact. No wallet needed. |
| `swap <in> <out> <amount> [--slippage <bps>] --confirm` | Executes at the best route (2.5% fee, earns POT). Without `--confirm` it prints the quote and `Add --confirm to execute`, exit 0. |
| `stake <amount> [--provider jito\|marinade] --confirm` / `unstake …` | SOL ↔ jitoSOL / mSOL through the swap path. |
| `balances [wallet]`, `positions [wallet]` | Holdings with USD. |
| `wallet create` / `wallet show` | Creates `POTSWAP_STATE_DIR/wallet.json` (0600) when no wallet is configured, printing only the public key; `show` prints the key, limits and allowlists. |
| `transfer <to> <amount> [--mint <mint>] --confirm` | SOL or token transfer, no fee; honours `POTSWAP_ALLOWED_RECIPIENTS`, the per-trade cap and the 0.01 SOL reserve. |
| `points [wallet]` | Points this epoch and all-time, reward balance, level, season. Says when the points engine is not enabled yet. |
| `launch` | Launch-pool meter, season and day, fee split. |
| `strategies list \| runs <id> \| pause <id> \| resume <id> \| delete <id>` | Manage the strategies in the shared state file (created with the MCP tools). |
| `daemon` | Runs the strategy scheduler until Ctrl-C; one per state directory (PID lock). |

Tokens: a mint address or `SOL`, `USDC`, `USDT`, `JITOSOL`, `MSOL`; other symbols are resolved through token search (verified match first). Amounts are UI units (`1` = 1 SOL). `--json` prints machine-readable output for every command.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success, including a quote-only `swap` / `transfer` without `--confirm` and a dry run |
| `1` | refused by a limit or allowlist, no wallet, unknown token, or an execution failure; the message says whether funds were debited |
| `2` | usage error (unknown command, missing argument, bad flag); usage is printed |

## Examples

```bash
# read-only
potswap quote SOL Bonk 0.25 --json
potswap launch
potswap points 5FX791oPE8Ey89JnCJ9Qxew5zyVukeyg6igVqNg4zhqx

# a dedicated wallet for a bot
export POTSWAP_STATE_DIR=~/.potswap-bot
potswap wallet create            # fund the printed address
POTSWAP_DRY_RUN=true potswap swap SOL USDC 0.1 --confirm   # rehearse
potswap swap SOL USDC 0.1 --confirm

# keep strategies running on a server
POTSWAP_MAX_DAILY_SOL=2 potswap daemon
```

See [Configuration](/agents/configuration/) for every variable and [Limits and policies](/security/limits-and-policies/) for how the caps are enforced.
