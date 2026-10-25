---
title: Quickstart
description: Add the Potswap MCP server to Claude Desktop, Claude Code or Cursor and get a first quote in minutes.
---

The Potswap MCP server runs with `npx`; there is no install step. You need Node 20 or newer.

```bash
npx -y @potswap_io/mcp
```

## 1. Add it to your MCP host

### Claude Desktop

Open Settings → Developer → Edit Config and add the server to `claude_desktop_config.json`:

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

Create `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "potswap": {
      "command": "npx",
      "args": ["-y", "@potswap_io/mcp"],
      "env": { "SOLANA_KEYPAIR_PATH": "/home/you/.config/solana/id.json" }
    }
  }
}
```

Restart the host. The server logs a ready line to stderr, for example `potswap-mcp v0.4.0 ready · api=https://www.potswap.io · maxTradeSol=1 · maxSlippageBps=300`.

## 2. Start read-only (no key)

You can leave the key out entirely. Without `SOLANA_PRIVATE_KEY` or `SOLANA_KEYPAIR_PATH` the server starts in read-only mode: `search_tokens`, `get_token`, `get_trending`, `get_price_history`, `get_quote`, `get_leaderboard`, `get_launch_status`, and `get_balances` / `get_positions` / `get_points` / `get_history` / `get_transaction` for any wallet you pass explicitly all work. `swap`, `transfer`, the stake tools and the strategy creation tools return:

```text
Wallet not configured. Set SOLANA_PRIVATE_KEY or SOLANA_KEYPAIR_PATH, or run wallet_create. No funds were debited.
```

This is the recommended way to try the server before giving it a wallet.

## 3. Get a first quote

Ask your agent for a quote, or call the tool directly:

```json
{
  "tool": "get_quote",
  "arguments": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": 0.1
  }
}
```

`amount` is in UI units of the input token (`1` = 1 SOL), never lamports. The response includes `outAmount`, `price`, `priceImpactPct`, `feeBps`, `feeLabel`, `router` and `expiresAt`.

Example prompt once the server is connected:

> Check BONK's risk flags, and if `riskLevel` is 0 or 1, quote 0.1 SOL worth.

The agent calls `get_token`, then `get_quote`.

## 4. Turn on trading

1. Create a **dedicated agent wallet** holding only the funds you want the agent to control. Either export one from Phantom / `solana-keygen`, or let the agent call `wallet_create { confirm: true }`: it writes `~/.potswap/wallet.json` (mode 0600), prints the public key, and the server loads it on every later start. Back that file up; it is the only copy.
2. If you brought your own key, set `SOLANA_PRIVATE_KEY` (base58 secret or JSON byte array) or `SOLANA_KEYPAIR_PATH` (path to a `solana-keygen` JSON file). Fund the address with SOL; keep at least 0.01 SOL for fees.
3. Keep `POTSWAP_DRY_RUN=true` at first: `swap` with `confirm: true` then returns what it *would* have done and signs nothing.
4. Lower the caps while you build trust: `POTSWAP_MAX_TRADE_SOL=0.5`, `POTSWAP_MAX_SLIPPAGE_BPS=100`. For an unattended agent also set `POTSWAP_ALLOWED_TOKENS` (the mints it may trade) and `POTSWAP_ALLOWED_RECIPIENTS` (where `transfer` may send).
5. Remove `POTSWAP_DRY_RUN` when you are comfortable. `swap` still refuses to execute unless the call carries `confirm: true`.

A first real swap:

```json
{
  "tool": "swap",
  "arguments": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": 0.05,
    "confirm": true
  }
}
```

Returns `signature`, `explorerUrl`, `inAmount`, `outAmount`, `router`, `feeBps`, `feeUsd` and `pointsAdded`.

## Next

- [MCP tools reference](/agents/mcp-tools/) for every input and output.
- [Configuration](/agents/configuration/) for every environment variable.
- [Strategies](/agents/strategies/) to create a DCA, a rebalance, a take-profit / stop-loss or a limit order.
- [Troubleshooting](/getting-started/troubleshooting/) when something does not work.
