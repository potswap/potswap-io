// Live check (no wallet, no funds): quote SOL → USDC through the aggregator and the Raydium CPMM direct route.
// Usage: node scripts/live-direct-quote.mjs [amountSol]   (needs `npm run build` first; uses the public Potswap API + RPC proxy)
import { Connection } from '@solana/web3.js'
import { PotswapApi, buildQuote, rpcFromConnection, loadConfig, SOL_MINT, USDC_MINT } from '../dist/index.js'

const config = loadConfig(process.env)
const api = new PotswapApi(config.apiBase)
const rpc = rpcFromConnection(new Connection(config.rpcUrl, 'confirmed'))
const amount = Number(process.argv[2] ?? '0.01')
const q = await buildQuote(api, { inputMint: SOL_MINT, outputMint: USDC_MINT, amount }, { direct: rpc })
console.log(JSON.stringify({ aggregator: { router: q.router, outAmount: q.outAmount, feeBps: q.feeBps, scheduledFeeBps: q.scheduledFeeBps }, direct: q.direct }, null, 2))
