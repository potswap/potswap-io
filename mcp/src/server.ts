// PRD P10 — the Potswap MCP server. Tools are thin, safe wrappers over the Potswap API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Connection, PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { PotswapApi, ApiError, type FetchFn } from '@potswap_io/sdk'
import { loadConfig, NO_WALLET, SOL_MINT, USDC_MINT, type Config } from '@potswap_io/sdk'
import { buildQuote, executeSwap, type BalancesFn } from '@potswap_io/sdk'
import { redact, redactValue } from '@potswap_io/sdk'
import { loadSigner, type Signer } from '@potswap_io/sdk'
import { riskBadges, riskLevel } from '@potswap_io/sdk'
import { registerStrategyTools } from './strategies/tools.js'
import { registerAgentTools, type TxRpc } from './agentTools.js'
import { registerObservationTools } from './observationTools.js'
import { registerDefiTools } from './defiTools.js'
import type { Rpc } from '@potswap_io/sdk'
import { FileOpsStore, rpcFromConnection, type OpsStore } from '@potswap_io/sdk'
import type { StrategyStore } from '@potswap_io/sdk'
import type { Scheduler } from '@potswap_io/sdk'
import type { Token } from '@potswap_io/sdk'

export const VERSION = '0.8.0'

export interface ServerDeps {
  config?: Config
  signer?: Signer | null
  fetchFn?: FetchFn
  /** Balance reader; defaults to an RPC connection. Injectable for tests. */
  balances?: BalancesFn
  /** Strategy persistence and scheduler (P11); defaults are created from config when omitted. */
  strategyStore?: StrategyStore
  scheduler?: Scheduler
  /** Transfer / transaction RPC surfaces; injectable for tests (P13). */
  rpc?: Rpc
  txRpc?: TxRpc
  /** Current slot for observation anchoring; injectable for tests (P15). */
  getSlot?: () => Promise<number>
  /** Idempotent operation records (P14.3); defaults to a file store in the state dir. */
  ops?: OpsStore
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
const ok = (data: Record<string, unknown>, summary?: string): ToolResult => ({
  content: [{ type: 'text', text: redact(summary ?? JSON.stringify(data, null, 2)) }], structuredContent: redactValue(data),
})
const fail = (message: string, extra: Record<string, unknown> = {}): ToolResult => ({
  content: [{ type: 'text', text: redact(message) }], structuredContent: redactValue({ error: message, ...extra }), isError: true,
})

export function createServer(deps: ServerDeps = {}) {
  const config = deps.config ?? loadConfig()
  const signer = deps.signer !== undefined ? deps.signer : loadSigner({ privateKey: config.privateKey, keypairPath: config.keypairPath, stateDir: config.stateDir })
  const api = new PotswapApi(config.apiBase, deps.fetchFn)
  const readBalances: BalancesFn = deps.balances ?? rpcBalances(config.rpcUrl)
  const trade = { api, config, signer, balances: readBalances, rpc: deps.rpc ?? rpcFromConnection(new Connection(config.rpcUrl, 'confirmed')), ops: deps.ops ?? new FileOpsStore(config.stateDir) }
  const server = new McpServer({ name: 'potswap', version: VERSION })

  const walletOr = (w?: string) => w ?? signer?.publicKey ?? null

  server.registerTool('search_tokens', {
    title: 'Search Solana tokens',
    description: 'Find tokens by name, symbol or mint address. Returns up to 20 with price, market cap and liquidity.',
    inputSchema: { query: z.string().min(1).max(64) },
  }, async ({ query }) => {
    try {
      const list = (await api.searchTokens(query)).slice(0, 20)
      const tokens = list.map(slimToken)
      return ok({ tokens }, tokens.map((t) => `${t.symbol} (${t.name}) ${t.mint} price=${t.usdPrice ?? '?'} mcap=${t.mcap ?? '?'}${t.isVerified ? ' ✓' : ''}`).join('\n') || 'No tokens found')
    } catch (e) { return fail(msg(e)) }
  })

  server.registerTool('get_token', {
    title: 'Token details and risk flags',
    description: 'Full token record: price, mcap, liquidity, holders, 5m/1h/6h/24h stats, audit data and risk badges (riskLevel 0 safe … 3 danger).',
    inputSchema: { mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) },
  }, async ({ mint }) => {
    try {
      const t = await api.terminalToken(mint)
      const badges = riskBadges(t)
      return ok({ token: t, riskBadges: badges, riskLevel: riskLevel(badges) },
        `${t.symbol} (${t.name})\nprice=${t.usdPrice} mcap=${t.mcap} liquidity=${t.liquidity} holders=${t.holderCount}\nrisk ${riskLevel(badges)}/3: ${badges.map((b) => b.label).join(', ')}`)
    } catch (e) { return fail(msg(e)) }
  })

  server.registerTool('get_trending', {
    title: 'Trending / new / top / graduating tokens',
    description: 'Discovery lists from Potswap (edge-cached, refreshed every 15 s).',
    inputSchema: { kind: z.enum(['new', 'trending', 'top', 'graduating']).default('trending'), limit: z.number().int().min(1).max(50).default(20) },
  }, async ({ kind, limit }) => {
    try {
      const list = (await api.list(kind)).slice(0, limit)
      const rows = list.map((t) => ({ mint: t.id, symbol: t.symbol, name: t.name, usdPrice: t.usdPrice, mcap: t.mcap, liquidity: t.liquidity, holders: t.holderCount, change5m: t.stats5m?.priceChange, change1h: t.stats1h?.priceChange, bondingProgress: t.bondingProgress, riskLevel: riskLevel(riskBadges(t)) }))
      return ok({ kind, tokens: rows }, rows.map((r) => `${r.symbol} ${r.mint} mcap=${r.mcap} 5m=${r.change5m} risk=${r.riskLevel}`).join('\n'))
    } catch (e) { return fail(msg(e)) }
  })

  server.registerTool('get_quote', {
    title: 'Get a swap quote',
    description: 'Best route across Metis, JupiterZ, DFlow and OKX, plus `direct` when a Raydium CPMM pool exists (same Potswap fee, compared net). Amount is in UI units of the input token (1 = 1 SOL). Includes the Potswap fee (returned to the wallet as POT points).',
    inputSchema: quoteShape,
  }, async (a) => {
    try {
      const q = await buildQuote(api, a, { direct: trade.rpc })
      return ok({ ...q }, `${a.amount} ${q.inputSymbol} → ${q.outAmount} ${q.outputSymbol} via ${q.router} (fee ${q.feeLabel ?? `${q.feeBps} bps`}, impact ${q.priceImpactPct}%)${q.direct ? `\nDirect Raydium CPMM: ${q.direct.outAmount} ${q.outputSymbol} (${q.direct.savedVsAggregatorPct >= 0 ? '+' : ''}${q.direct.savedVsAggregatorPct.toFixed(2)}% vs aggregator, pool fee ${q.direct.poolTradeFeeBps} bps)` : ''}`)
    } catch (e) { return fail(msg(e)) }
  })

  server.registerTool('swap', {
    title: 'Swap tokens (signs with the agent wallet)',
    description: 'Executes a swap at the best route. Requires confirm=true; otherwise returns the quote only. Protected by POTSWAP_MAX_TRADE_SOL, POTSWAP_MAX_SLIPPAGE_BPS and the transaction validator. route=direct uses a Raydium CPMM pool built locally (same fee); route=auto picks the better net output. opId makes the call safe to retry (a repeat returns the stored result). Every error states whether funds were debited.',
    inputSchema: { ...quoteShape, confirm: z.boolean().default(false), maxSlippageBps: z.number().int().min(1).max(5000).optional(), route: z.enum(['jupiter', 'direct', 'auto']).default('jupiter'), opId: z.string().min(4).max(64).optional() },
  }, async (a) => {
    const out = await executeSwap(trade, { inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps ?? a.maxSlippageBps, confirm: a.confirm, route: a.route, opId: a.opId })
    switch (out.kind) {
      case 'no-wallet': return fail(out.message)
      case 'refused': return fail(out.message, { quote: out.quote })
      case 'quote-only': return ok({ confirmRequired: true, quote: out.quote }, `Quote only (confirm=true to execute): ${a.amount} ${out.quote.inputSymbol} → ${out.quote.outAmount} ${out.quote.outputSymbol} via ${out.quote.router}`)
      case 'dry-run': return ok({ dryRun: true, quote: out.quote }, `DRY RUN, nothing signed: ${a.amount} ${out.quote.inputSymbol} → ${out.quote.outAmount} ${out.quote.outputSymbol}`)
      case 'failed': return fail(out.message, { signature: out.signature, explorerUrl: out.explorerUrl, quote: out.quote })
      case 'ok': return ok({ ...out.result }, `${out.result.replayed ? 'Already done (replayed): ' : 'Swapped '}${a.amount} ${out.result.inputSymbol} → ${out.result.outAmount} ${out.result.outputSymbol} via ${out.result.router}. ${out.result.explorerUrl}`)
    }
  })

  server.registerTool('get_operation', {
    title: 'Operation record',
    description: 'State of an idempotent swap by opId: pending, sent, ok, failed or unknown, with the signature and result when known. Lists recent operations without an id.',
    inputSchema: { id: z.string().min(4).max(64).optional(), limit: z.number().int().min(1).max(100).default(20) },
  }, async ({ id, limit }) => {
    if (!trade.ops) return fail('No operation store configured.')
    if (id) { const r = trade.ops.get(id); return r ? ok({ ...r }, `${r.id}: ${r.state}${r.signature ? ` · ${r.signature}` : ''}${r.error ? ` · ${r.error}` : ''}`) : fail(`No operation ${id}.`) }
    const rows = trade.ops.list(limit)
    return ok({ operations: rows }, rows.map((r) => `${r.updatedAt} ${r.id} ${r.state}${r.signature ? ` ${r.signature.slice(0, 8)}…` : ''}`).join('\n') || 'No operations yet.')
  })

  server.registerTool('get_balances', {
    title: 'Wallet balances',
    description: 'SOL and SPL token balances with USD values. Defaults to the agent wallet.',
    inputSchema: { wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional() },
  }, async ({ wallet }) => {
    const w = walletOr(wallet)
    if (!w) return fail(NO_WALLET)
    try {
      const bal = await readBalances(w)
      const mints = Object.keys(bal)
      const prices = await api.prices(mints.slice(0, 50)).catch(() => ({} as Record<string, number>))
      const rows = mints.map((m) => ({ mint: m, amount: bal[m], usd: prices[m] ? bal[m] * prices[m] : undefined })).sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0))
      const total = rows.reduce((s, r) => s + (r.usd ?? 0), 0)
      return ok({ wallet: w, totalUsd: total, balances: rows }, `${w}\ntotal ≈ $${total.toFixed(2)}\n` + rows.map((r) => `${r.mint === SOL_MINT ? 'SOL' : r.mint}: ${r.amount}${r.usd !== undefined ? ` ($${r.usd.toFixed(2)})` : ''}`).join('\n'))
    } catch (e) { return fail(msg(e)) }
  })

  server.registerTool('get_points', {
    title: 'POT points',
    description: "Points and rewards for a wallet: this epoch, all-time, POT allocated and claimable, next unlock, reward balance (SOL, buys POT after launch), level and season. Defaults to the agent wallet.",
    inputSchema: { wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional() },
  }, async ({ wallet }) => {
    const w = walletOr(wallet)
    if (!w) return fail(NO_WALLET)
    try { return ok({ enabled: true, ...(await api.points(w)) }) }
    catch (e) {
      if (e instanceof ApiError && e.status === 503) return ok({ enabled: false, wallet: w, note: 'The points engine is not enabled yet. Swaps made now still pay the Potswap fee; points start with Season 1.' })
      return fail(msg(e))
    }
  })

  server.registerTool('get_leaderboard', {
    title: 'Leaderboard',
    description: 'Top wallets by Potswap fee paid, with POT allocated.',
    inputSchema: {},
  }, async () => {
    try { return ok({ enabled: true, ...(await api.leaderboard()) }) }
    catch (e) {
      if (e instanceof ApiError && e.status === 503) return ok({ enabled: false, note: 'The points engine is not enabled yet.' })
      return fail(msg(e))
    }
  })

  registerAgentTools(server, { trade, config, rpc: deps.rpc, txRpc: deps.txRpc, schedulerActive: () => !!deps.scheduler?.active })
  registerStrategyTools(server, { trade, store: deps.strategyStore, scheduler: deps.scheduler })
  registerObservationTools(server, { trade, config, getSlot: deps.getSlot })
  registerDefiTools(server, { trade, config })
  return server
}

const quoteShape = {
  inputMint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).describe('Mint of the token to sell (SOL = So11111111111111111111111111111111111111112)'),
  outputMint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).describe('Mint of the token to buy'),
  amount: z.number().positive().describe('Amount in UI units of the input token (1 = 1 SOL)'),
  slippageBps: z.number().int().min(1).max(5000).optional().describe('Fixed slippage in bps; omit for auto'),
}

function slimToken(t: Token & { mcap?: number; liquidity?: number }) {
  return { mint: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals, usdPrice: t.usdPrice, mcap: t.mcap, liquidity: t.liquidity, isVerified: t.isVerified ?? false }
}

function msg(e: unknown) { return e instanceof Error ? e.message : String(e) }

function rpcBalances(rpcUrl: string) {
  return async (wallet: string): Promise<Record<string, number>> => {
    const conn = new Connection(rpcUrl, 'confirmed')
    const owner = new PublicKey(wallet)
    const out: Record<string, number> = {}
    const [lamports, spl, t22] = await Promise.all([
      conn.getBalance(owner),
      conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
      conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }).catch(() => ({ value: [] })),
    ])
    out[SOL_MINT] = lamports / 1e9
    for (const { account } of [...spl.value, ...t22.value]) {
      const info = account.data.parsed?.info
      const ui = Number(info?.tokenAmount?.uiAmount ?? 0)
      if (info && ui > 0) out[info.mint] = (out[info.mint] ?? 0) + ui
    }
    return out
  }
}

export { SOL_MINT, USDC_MINT }
