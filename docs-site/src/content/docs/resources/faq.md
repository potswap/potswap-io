---
title: FAQ
description: Short answers to the questions developers ask before wiring an agent to Potswap.
---

### Do I need an API key?

No. The MCP server talks only to `potswap.io`, which adds its own Jupiter and RPC keys server-side. If you trade a lot, set `SOLANA_RPC_URL` to your own RPC for balance reads.

### Does Potswap hold my funds or keys?

No. The server runs on your machine and signs with your keypair in-process. Potswap's API receives your public address and already-signed transactions, never the secret. See [Non-custodial by design](/security/non-custodial/).

### Can I try it without a wallet?

Yes. Start without `SOLANA_PRIVATE_KEY` / `SOLANA_KEYPAIR_PATH` and the server runs read-only: search, token details, trending lists, price history, quotes, leaderboard, launch status, and balances / positions / points / history for any wallet you pass explicitly.

### Can the agent make its own wallet?

Yes. `wallet_create { confirm: true }` generates a keypair into `~/.potswap/wallet.json` (mode 0600) on your machine and prints the public key; fund it and the agent can trade. The secret is never returned to the agent or sent anywhere. Back the file up.

### What does a swap cost?

Potswap's fee is 2.5% of the input (1% when the input is worth $1,000 or more), charged inside the swap through Jupiter's referral program; Jupiter keeps 20% of it. The fee is only applied once Potswap's referral account is configured; until then `feeBps` is `0`. See [Fees](/routing/fees/).

### Do agents earn the same rewards as humans?

Yes. Points equal the fee paid, whoever paid it. An agent wallet earns exactly like a human wallet.

### Are the points live?

The engine (points, Season 0 airdrop replay, seasons, reward balances, claims, launch meter) is built and deployed, but the points database is not switched on yet: `get_points` and `get_leaderboard` return `{ enabled: false }` with a note, and `get_launch_status` shows 0 / 500 SOL until the pool address is published. See [Points and POT](/economy/points-and-pot/).

### Can I send tokens, not just swap?

Yes. `transfer` sends SOL or any SPL / Token-2022 token from the agent wallet with no Potswap fee, creating the recipient's token account if needed. It honours `POTSWAP_ALLOWED_RECIPIENTS`, the per-trade cap and the 0.01 SOL reserve.

### Are there limit orders?

Yes, as a strategy: `limit_order_create` fills once when the token's USD price crosses your trigger, through the normal swap path. A process (your MCP host or the daemon) must be running for it to fill.

### Is `amount` in lamports?

No. Every amount is in UI units of the input token: `1` = 1 SOL, `0.1` = 0.1 SOL. Passing raw units trips the per-trade cap with a hint.

### Why did `swap` return a quote instead of swapping?

It was called without `confirm: true`. That is by design; add `confirm: true` to execute.

### What happens if a swap fails after signing?

The result states whether funds were debited and includes `signature` and `explorerUrl` when a transaction was sent, so you can verify on Solscan. Common cases (slippage, expiry, congestion) report `No funds were debited`. See [Troubleshooting](/getting-started/troubleshooting/).

### Are the limits enforceable?

They are **software-enforced** by the MCP server process in this version, not by the chain or a smart wallet. They stop an agent from making a mistake; they do not stop someone who already has your key. An enforced mode is on the roadmap. See [Limits and policies](/security/limits-and-policies/).

### Do strategies run when my laptop is closed?

Only if a process is running them. Inside your MCP host they run while the host is open; for 24/7 run `npx -y @potswap_io/mcp --daemon` on an always-on machine. Potswap has no server-side scheduler. See [Strategies](/agents/strategies/).

### Can two machines run the same strategies?

They can share a state directory, but only one process holds the scheduler lock and trades. The other can list, create, pause and resume.

### Is there an SDK or a CLI?

Not yet. `@potswap/sdk` and the `potswap` CLI are roadmap items; today the only package is `@potswap_io/mcp`. See [Roadmap](/resources/roadmap/).

### Is there a remote (hosted) MCP endpoint?

Not yet. Only the local stdio server exists. A remote MCP that returns unsigned transactions is specified as a later phase.

### Can agents stake SOL?

Yes. `stake_sol` swaps SOL into jitoSOL (default) or mSOL at the best route; `unstake_sol` is the reverse. Normal fee and points apply.

### Which DEXs does Potswap route through?

Everything Jupiter Swap V2 aggregates: Metis, JupiterZ, DFlow and OKX compete per order. Direct Raydium / Orca / Meteora adapters are planned, not built. See [How routing works](/routing/how-routing-works/).

### Where is the code?

The MCP package is MIT licensed and published on npm as [`@potswap_io/mcp`](https://www.npmjs.com/package/@potswap_io/mcp). See [License](/resources/license/).
