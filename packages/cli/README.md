# potswap (CLI)

Command-line Solana swaps, transfers, wallet, strategies and POT rewards on the Potswap engine (`@potswap_io/sdk`). Same environment variables, limits, fee and copy as the MCP server, so a script, a cron job or a bot earns exactly like an agent or a human. Node 20+.

```bash
npx -y @potswap_io/cli quote SOL USDC 0.1
# 0.1 SOL → 10.43 USDC via metis · fee 2.5% (250 bps) · impact 0.01% · slippage 30 bps
```

Install globally for the `potswap` command:

```bash
npm i -g @potswap_io/cli
potswap --help
```

## Commands

```
quote <in> <out> <amount> [--slippage <bps>]            best route; no wallet needed
swap <in> <out> <amount> [--slippage <bps>] --confirm   execute (2.5% fee, earns POT); without --confirm it only quotes
stake <amount> [--provider jito|marinade] --confirm     SOL → jitoSOL / mSOL at the best route
unstake <amount> [--provider jito|marinade] --confirm
balances [wallet]      positions [wallet]
wallet create | show                                    state-dir wallet (0600); the secret is never printed
transfer <to> <amount> [--mint <mint>] --confirm        SOL or token transfer, no fee
points [wallet]        launch
strategies list | runs <id> | pause <id> | resume <id> | delete <id>
daemon                                                  run the strategy scheduler 24/7 (one per state dir)
```

Tokens are a mint address or `SOL`, `USDC`, `USDT`, `JITOSOL`, `MSOL`. Amounts are UI units (`1` = 1 SOL). `--json` prints machine-readable output. Exit codes: `0` ok (including "add --confirm"), `1` refused or failed (the message says whether funds were debited), `2` usage.

## Wallet and limits

| Variable | Default | Meaning |
|---|---|---|
| `SOLANA_PRIVATE_KEY` / `SOLANA_KEYPAIR_PATH` | — | your signer; or run `potswap wallet create` once and the CLI loads `~/.potswap/wallet.json` |
| `POTSWAP_MAX_TRADE_SOL` | `1` | per swap / transfer cap in SOL-equivalent |
| `POTSWAP_MAX_SLIPPAGE_BPS` | `300` | refuse higher slippage |
| `POTSWAP_MAX_DAILY_SOL` | `5` | daily cap across strategies |
| `POTSWAP_ALLOWED_TOKENS`, `POTSWAP_ALLOWED_RECIPIENTS` | — | comma-separated allowlists |
| `POTSWAP_DRY_RUN` | `false` | every signing command reports instead of signing |
| `POTSWAP_STATE_DIR` | `~/.potswap` | wallet, strategies and lock |

Create strategies with the MCP server (`dca_create`, `rebalance_create`, `tpsl_create`, `limit_order_create`); the CLI lists, pauses, resumes, deletes them and runs them with `potswap daemon`.

Documentation: https://potswap-docs.pages.dev · MIT.
