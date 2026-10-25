# @potswap_io/sdk

The engine behind the Potswap MCP server and the `potswap` CLI, as a typed Node library: best-route Solana swaps with hard spending limits, transfers, a local wallet, history and PnL, standing strategies (DCA, rebalance, take-profit / stop-loss, limit orders) and POT rewards. Non-custodial: everything runs on your machine with your signer. Node 20+.

```bash
npm i @potswap_io/sdk
```

```ts
import { PotswapApi, loadConfig, loadSigner, buildQuote, executeSwap, rpcBalances, SOL_MINT, USDC_MINT } from '@potswap_io/sdk'

const config = loadConfig(process.env)            // SOLANA_*, POTSWAP_* (same variables as the MCP server)
const api = new PotswapApi(config.apiBase)        // https://www.potswap.io by default; no API keys needed
const signer = loadSigner({ privateKey: config.privateKey, keypairPath: config.keypairPath, stateDir: config.stateDir })
const balances = rpcBalances(config.rpcUrl)

const quote = await buildQuote(api, { inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 0.1 })
const result = await executeSwap({ api, config, signer, balances }, { inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 0.1, confirm: true })
if (result.kind === 'ok') console.log(result.result.signature, result.result.feeUsd, result.result.pointsAdded)
else console.error(result.kind, 'message' in result ? result.message : result.quote)
```

Every outcome is a tagged union (`no-wallet`, `refused`, `quote-only`, `dry-run`, `failed`, `ok`) and every message states whether funds were debited. `POTSWAP_MAX_TRADE_SOL`, `POTSWAP_MAX_SLIPPAGE_BPS`, `POTSWAP_ALLOWED_TOKENS`, `POTSWAP_DRY_RUN` and the 0.01 SOL reserve apply to every signing path exactly as in the MCP server.

## Modules

| Export | Purpose |
|---|---|
| `PotswapApi`, `ApiError` | quotes, orders, execute, tokens, prices, points, launch pool, stats, history, OHLCV; retries once on 429 / 503 |
| `buildQuote`, `executeSwap` | the swap path: quote → limits → fresh order as taker → local signature → execute |
| `executeTransfer`, `rpcFromConnection` | SOL / SPL / Token-2022 transfers with ATA creation, recipient allowlist, caps, reserve; no fee |
| `checkLimits` | per-trade and slippage caps, reserve, SOL-equivalent valuation |
| `loadSigner`, `createWallet` | keypair from env, file or `<stateDir>/wallet.json`; `createWallet` writes it (0600) |
| `normalizeHistory`, `mapSignatureStatus`, `computePositions` | parsed history and average-cost PnL |
| `Scheduler`, `FileStore`, `MemoryStore`, `acquireLock`, strategy types and engine functions | DCA / rebalance / TP-SL / limit strategies with a one-process lock |
| `createRuntime` | wires config → signer, API, balances, store, lock, scheduler (what the MCP server and `potswap daemon` use) |
| `feeBpsFor`, `parseFeeSchedule`, `DEFAULT_FEE_SCHEDULE` | the fee schedule shared with the web app (2.5%, 1% at or above $1,000, staker tier) |
| `riskBadges`, `riskLevel`, `friendlyError`, `describeOrderError` | the same risk flags and error copy the web app shows |
| `redact`, `redactValue`, `registerSecret`, `log` | secret redaction for anything you print or persist |

Full documentation, including the MCP server and the CLI that are built on this package: https://docs.potswap.io

## Fees and rewards

Swaps, stakes and strategy legs carry Potswap's 2.5% integrator fee inside the trade (1% at or above $1,000); Jupiter keeps 20%. Before the token launches, 60% of the net fee fills the launch pool, 20% is set aside as the trader's reward balance (buys POT after launch), 20% runs the project. Transfers and all reads are free. Only protocol fees enter the launch pool; nothing can be deposited.

MIT.
