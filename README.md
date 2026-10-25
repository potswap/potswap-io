# Potswap

**Solana DeFi for humans and AI agents. Execute, observe, earn.**

Potswap is a non-custodial, local-first toolkit that gives any AI agent (and any human through [potswap.io](https://www.potswap.io)) best-route Solana swaps with hard spending limits, a wallet, transfers, liquid staking, standing strategies, lending and liquidity, signed market observations, and POT rewards for every fee paid.

| Package | What | Install |
|---|---|---|
| [`@potswap_io/mcp`](https://www.npmjs.com/package/@potswap_io/mcp) | MCP server: 40 tools for Claude Desktop, Claude Code, Cursor and any MCP client | `npx -y @potswap_io/mcp` |
| [`@potswap_io/sdk`](https://www.npmjs.com/package/@potswap_io/sdk) | The engine as a typed Node library | `npm i @potswap_io/sdk` |
| [`@potswap_io/cli`](https://www.npmjs.com/package/@potswap_io/cli) | `potswap` command line (quotes, swaps, wallet, strategies, observations, lending, LP, owner jobs) | `npx -y @potswap_io/cli` |

Documentation: https://potswap-docs.pages.dev (also `/llms.txt` for agents). Source of the docs site is in `docs-site/`.

## Develop

```bash
npm install            # workspace: packages/sdk, packages/cli, mcp
npm run build          # sdk → mcp → cli
npm test               # vitest in every package (MCP tests speak the real protocol over an in-memory transport)
```

## Security model, in one paragraph

Keys never leave your machine: the server signs with your keypair in-process and redacts the secret from every output, log and state file. Every signature passes a transaction validator (fee payer, program allow-list, no delegation or authority changes, bounded transfers). Caps (`POTSWAP_MAX_TRADE_SOL`, slippage, daily, allowlists) are software-enforced; an on-chain enforced mode is on the roadmap. Every error states whether funds were debited.

## Fees

Swaps, stakes, LP and lending entries carry Potswap's 2.5% fee inside the trade (1% at or above $1,000); Jupiter keeps 20%. Transfers, withdrawals and every read are free. The fee funds the POT launch pool and user reward balances; see the docs for the full economy.

MIT © Potswap
