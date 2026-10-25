---
title: SDK (@potswap_io/sdk)
description: The engine behind the MCP server and the CLI as a typed Node library — quotes, swaps, transfers, wallet, history, PnL, strategies and the fee schedule — with the same limits and copy.
---

`@potswap_io/sdk` is the core the MCP server is built on, published on its own so bots, scripts, plugins for other agent frameworks and CI jobs can use the same engine. Node 20+, ESM, TypeScript types included. No MCP or zod dependency.

```bash
npm i @potswap_io/sdk
```

```ts
import { PotswapApi, loadConfig, loadSigner, buildQuote, executeSwap, rpcBalances, SOL_MINT, USDC_MINT } from '@potswap_io/sdk'

const config = loadConfig(process.env)
const api = new PotswapApi(config.apiBase)
const signer = loadSigner({ privateKey: config.privateKey, keypairPath: config.keypairPath, stateDir: config.stateDir })
const balances = rpcBalances(config.rpcUrl)

const quote = await buildQuote(api, { inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 0.1 })
const r = await executeSwap({ api, config, signer, balances }, { inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 0.1, confirm: true })
```

`executeSwap` returns a tagged union: `no-wallet`, `refused` (a limit or allowlist, with the `quote`), `quote-only` (no `confirm`), `dry-run`, `failed` (with `signature` when one exists) or `ok` (`signature`, `explorerUrl`, amounts, `router`, `feeBps`, `feeUsd`, `pointsAdded`, `solEquivalent`). Every message states whether funds were debited.

## Configuration

`loadConfig(env)` reads the same variables as the MCP server: `SOLANA_PRIVATE_KEY`, `SOLANA_KEYPAIR_PATH`, `SOLANA_RPC_URL`, `POTSWAP_API`, `POTSWAP_MAX_TRADE_SOL`, `POTSWAP_MAX_SLIPPAGE_BPS`, `POTSWAP_MAX_DAILY_SOL`, `POTSWAP_DRY_RUN`, `POTSWAP_ALLOWED_TOKENS`, `POTSWAP_ALLOWED_RECIPIENTS`, `POTSWAP_STATE_DIR`. See [Configuration](/agents/configuration/). You can also build a `Config` object yourself.

## Modules

| Export | Purpose |
|---|---|
| `PotswapApi`, `ApiError` | `/api/config`, token search, prices, order, execute, points, leaderboard, launch pool, stats, history, OHLCV; one retry on 429 / 503 |
| `buildQuote`, `executeSwap` | the swap path used by `swap`, `stake_sol`, every strategy leg and the CLI |
| `executeTransfer`, `rpcFromConnection`, `Rpc` | SOL / SPL / Token-2022 transfers; recipient allowlist, caps, reserve; no fee |
| `checkLimits` | pure limit checks (per-trade SOL-equivalent, slippage, reserve, balance) |
| `loadSigner`, `createWallet`, `Signer` | signer from env / file / `<stateDir>/wallet.json`; wallet creation (0600) |
| `normalizeHistory`, `mapSignatureStatus`, `computePositions` | history normalisation and average-cost PnL (pure) |
| `Scheduler`, `FileStore`, `MemoryStore`, `acquireLock`, `isDue`, `nextRunAfter`, `rebalancePlan`, `tpslDecision`, `limitDecision`, … | the strategies engine; `Strategy`, `Run`, `StrategyState` types |
| `createRuntime` | config → signer, API, balances, file store, PID lock, scheduler |
| `feeBpsFor`, `parseFeeSchedule`, `DEFAULT_FEE_SCHEDULE` | the fee schedule shared with the web app |
| `riskBadges`, `riskLevel` | the same risk flags the web app shows |
| `friendlyError`, `describeOrderError` | user-facing error copy (always says whether funds were debited) |
| `redact`, `redactValue`, `registerSecret`, `log` | secret redaction; `loadSigner` registers every encoding of the secret |
| `SOL_MINT`, `USDC_MINT`, `JITOSOL_MINT`, `MSOL_MINT`, `NO_WALLET`, `TOKEN_NOT_ALLOWED`, `RECIPIENT_NOT_ALLOWED` | constants and canonical messages |

## Testing against it

The SDK talks to Potswap through `fetch`; pass your own `fetchFn` to `new PotswapApi(base, fetchFn)` to mock quotes and orders, inject a `balances` function and an `Rpc` object for transfers, and use `MemoryStore` for strategies. This is how the MCP and CLI test suites work.

## Fees

Swaps, stakes and strategy legs carry the Potswap fee inside the trade (see [Fees](/routing/fees/)); the SDK sets the referral account and the scheduled fee from `/api/config` unless you override `feeBps`. Transfers and all reads are free.
