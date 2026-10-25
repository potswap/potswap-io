# @potswap_io/mcp

The Solana swap tool for AI agents. One MCP server gives your agent best-route swaps across every Solana DEX (Metis, JupiterZ, DFlow and OKX compete on each order, MEV-protected), token research with risk flags, balances, and POT rewards for every trade.

- **Non-custodial.** Transactions are signed on your machine with your own keypair. The key never leaves the process and is redacted from every output.
- **Safe by default.** `swap` needs `confirm: true`; per-trade cap 1 SOL; slippage cap 3%; dry-run mode; a 0.01 SOL reserve is always kept. Every error says whether funds were debited.
- **Pays you back.** Potswap charges a 2.5% fee inside the swap (1% on swaps of $1,000 or more). Half of its net fees buy and burn POT every epoch, and the fee you paid is credited to your wallet as POT points (Season 1). Agents earn exactly like humans.
- **$0 to run.** Talks only to `potswap.io`; no API keys needed.

## Install

Node 20+. No install step; run it with `npx`.

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "potswap": {
      "command": "npx",
      "args": ["-y", "@potswap_io/mcp"],
      "env": {
        "SOLANA_PRIVATE_KEY": "<base58 secret or JSON byte array>",
        "POTSWAP_MAX_TRADE_SOL": "0.5"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add potswap -e SOLANA_KEYPAIR_PATH=~/.config/solana/id.json -- npx -y @potswap_io/mcp
```

### Cursor

`.cursor/mcp.json` in your project:

```json
{ "mcpServers": { "potswap": { "command": "npx", "args": ["-y", "@potswap_io/mcp"], "env": { "SOLANA_KEYPAIR_PATH": "/home/you/.config/solana/id.json" } } } }
```

Without a key the server still runs in read-only mode (search, quotes, trending, points of any wallet).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SOLANA_PRIVATE_KEY` | — | base58 secret key (64 bytes) or JSON byte array, as exported by Phantom / `solana-keygen` |
| `SOLANA_KEYPAIR_PATH` | — | path to a `solana-keygen` JSON file; used when `SOLANA_PRIVATE_KEY` is unset |
| *(none)* | `~/.potswap/wallet.json` | created by `wallet_create`; loaded when neither variable is set |
| `SOLANA_RPC_URL` | Potswap's RPC proxy | your own RPC if you trade a lot |
| `POTSWAP_MAX_TRADE_SOL` | `1` | refuse any swap whose input is worth more than this many SOL |
| `POTSWAP_MAX_SLIPPAGE_BPS` | `300` | refuse requested slippage above this |
| `POTSWAP_MAX_DAILY_SOL` | `5` | daily SOL-equivalent cap across all strategies |
| `POTSWAP_STATE_DIR` | `~/.potswap` | where the agent wallet, strategies and run logs are stored |
| `POTSWAP_ALLOWED_TOKENS` | — | comma-separated mints; when set, every swap, strategy leg and stake must stay inside the list |
| `POTSWAP_ALLOWED_RECIPIENTS` | — | comma-separated addresses; when set, `transfer` only sends to these |
| `POTSWAP_DRY_RUN` | `false` | `true` = `swap`, `transfer`, stakes and strategy legs never sign; they return what they would have done |
| `POTSWAP_API` | `https://www.potswap.io` | base URL |

Use a dedicated agent wallet with only the funds you want the agent to control. Keep the caps low until you trust the agent's behaviour.

## Tools

| Tool | Does |
|---|---|
| `search_tokens {query}` | Find tokens by name/symbol/mint |
| `get_token {mint}` | Price, mcap, liquidity, holders, audit data, **risk badges** (`riskLevel` 0 safe → 3 danger) |
| `get_trending {kind}` | `new`, `trending`, `top`, `graduating` lists |
| `get_quote {inputMint, outputMint, amount}` | Best route, fee, impact, router. `amount` is in UI units (1 = 1 SOL) |
| `swap {…, confirm: true, route?, opId?}` | Executes at the best route and returns the signature, amounts, fee and POT points. `route: direct` swaps on a Raydium CPMM pool built and validated locally (same fee); `opId` makes retries safe |
| `get_operation {id?}` | State of an idempotent swap (pending / sent / ok / failed / unknown) |
| `get_balances {wallet?}` | SOL + SPL balances with USD |
| `get_positions {wallet?}` | Holdings with USD value, average cost, unrealised and realised PnL (from swap history) |
| `get_points {wallet?}` | Season 1 points, POT allocated / claimable, next unlock |
| `get_leaderboard` | Top wallets by fee paid |
| `observe_publish`, `observe_query`, `observe_verify`, `observe_consume` | Signed, slot-anchored market observations on the open index: publish with your wallet, read everyone's with a per-publisher median, verify locally, record that you used one (earns the publisher Season 2 rewards). `limit_order_create` can trigger on the observation median (`priceSource: observations`) |
| `lend_markets`, `lend_positions`, `lend_deposit`, `lend_withdraw` | Jupiter Lend Earn: markets with APY, your positions, deposit (fee, points) and free withdrawal |
| `lp_pools`, `lp_position`, `lp_deposit`, `lp_withdraw` | Raydium CPMM liquidity: pools with live reserves, your share, add (fee, points) and remove (free) |
| `get_launch_status` | Launch-pool meter (SOL / 500 target, from chain), season and day, fee split, unclaimed reward balances and the public claim ladder |
| `get_price_history {mint, timeframe, limit}` | OHLCV candles from the token's top pool (`1m`…`1d`) |

### Wallet and operations (0.3.0)

| Tool | Does |
|---|---|
| `wallet_create {confirm: true}` | Generates a keypair into `POTSWAP_STATE_DIR/wallet.json` (mode 0600) when no wallet is configured. Returns the public key only. **Back the file up**; it is the only copy. |
| `get_wallet` | Public key, funding instructions, active limits and allowlists, scheduler status |
| `transfer {to, mint?, amount, confirm: true}` | Sends SOL or any SPL / Token-2022 token, creating the recipient's token account if needed. No Potswap fee. Honours `POTSWAP_ALLOWED_RECIPIENTS`, `POTSWAP_MAX_TRADE_SOL` and the 0.01 SOL reserve |
| `get_transaction {signature}` | processed / confirmed / finalized / failed / not found, fee, and the wallet's SOL and token balance changes |
| `get_history {wallet?, limit}` | Recent parsed transactions: swaps (in/out amounts), transfers (direction, counterparty), other |
| `stake_sol {amount, provider, confirm: true}` | Liquid-stakes SOL into jitoSOL (default) or mSOL at the best route; normal fee and points. `unstake_sol` is the reverse |

Agents that start from nothing: `wallet_create` → fund the address → `get_quote` → `swap`. Set `POTSWAP_ALLOWED_TOKENS` and `POTSWAP_ALLOWED_RECIPIENTS` before giving an agent an unattended wallet.

Example prompt: *"Check BONK's risk flags, and if riskLevel is 0 or 1 buy 0.1 SOL worth."* The agent calls `get_token`, then `swap` with `confirm: true`; you can require that it shows you the quote first by leaving `POTSWAP_DRY_RUN=true` until you are comfortable.

## Strategies: DCA, rebalance, take-profit / stop-loss, limit orders

Standing orders that keep running without you. Every leg is an ordinary Potswap swap (fee + POT points).

| Tool | Example |
|---|---|
| `dca_create` | `{ inputMint: SOL, outputMint: USDC, amountPerRun: 0.1, intervalMinutes: 60, totalRuns: 24, confirm: true }` |
| `rebalance_create` | `{ targets: { SOL: 60, USDC: 40 }, driftPct: 5, checkIntervalMinutes: 60, confirm: true }` (mints, not symbols) |
| `tpsl_create` | `{ mint: BONK, sellPct: 50, takeProfitPct: 50, stopLossPct: 20, trailingPct: 15, confirm: true }` |
| `limit_order_create` | `{ side: 'buy', mint: BONK, amount: 0.1, triggerPriceUsd: 0.00001, condition: 'below', expiresAt?, confirm: true }` — fills once when the price crosses, then completes |
| `strategy_list`, `strategy_runs {id}`, `strategy_pause/resume/delete {id}` | manage and audit |

**Who runs the clock.** Strategies execute inside the MCP server while your host app is open. For 24/7 operation run the daemon on any always-on machine:

```bash
POTSWAP_STATE_DIR=~/.potswap SOLANA_KEYPAIR_PATH=~/.config/solana/id.json npx -y @potswap_io/mcp --daemon
```

State lives in `~/.potswap/strategies.json` (override with `POTSWAP_STATE_DIR`); a PID lock makes sure only one process trades. The first leg runs at creation; a window missed during downtime runs once, never as a burst.

**Extra limits.** `POTSWAP_MAX_DAILY_SOL` (default `5`) caps the SOL-equivalent all strategies may spend per UTC day; `POTSWAP_MAX_STRATEGIES` (default `10`). After three consecutive failed legs a strategy pauses itself and tells you why. `POTSWAP_DRY_RUN=true` turns every leg into a logged quote.

## Fees and rewards

Each swap carries Potswap's 2.5% integrator fee via Jupiter's referral program (1% above $1,000; stakers get −1%); Jupiter keeps 20%.

**Season 0 (now, before the token):** 60% of the net fee fills the **launch pool**; when it reaches 500 SOL the POT token launches on its own liquidity pool. 20% of your net fee is set aside as your **reward balance** (in SOL): after launch it buys POT for you, when you say so (`claim now` at market, or a limit claim at your price). 20% runs the project. Every day you trade in Season 0 earns a slice of the **250M POT airdrop** (25% of supply), replayed day by day after launch: fee basis `fee^1.1`, capped at 10% of the day per wallet, round trips within 10 minutes count 25%.

**Seasons 1+ (30 days each):** `20M × 0.85^(n−1)` POT per season shared daily by fee basis; 30% of the net fee buys and burns POT, 20% keeps feeding reward balances, 50% team and operations. Levels (Larva → Bee → Queen, up to ×1.25) persist across seasons. `get_points` shows your balance, level and season; `get_launch_status` shows the meter. Only protocol fees enter the pool: nothing can be deposited. Full documentation: https://potswap-docs.pages.dev (every tool, configuration, limits, economy; also as /llms.txt for agents).

## Owner jobs

`potswap admin sweep | claims | burn` (CLI) run the treasury split, the claims worker and the buy-and-burn with the owner's key; dry-run by default.

## Also available

- **`@potswap_io/sdk`** — the same engine as a typed library for bots, scripts and other agent frameworks. The MCP server is built on it.
- **`@potswap_io/cli`** — the `potswap` command: `npx -y @potswap_io/cli quote SOL USDC 0.1`; swaps, transfers, wallet, points, launch meter, strategy management and `potswap daemon`.

## Development

```bash
cd mcp && npm i && npm test      # unit tests over the real MCP protocol (in-memory transport)
npm run dev                       # run from source
npm run sync-shared && npm run build
```

MIT © Potswap
