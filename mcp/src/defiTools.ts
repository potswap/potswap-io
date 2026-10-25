// PRD P19 — DeFi operations: Jupiter Lend Earn (lend_*) and Raydium CPMM liquidity (lp_*).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { NO_WALLET, executeLend, executeLpDeposit, executeLpWithdraw, lpPools, lpPosition, normalizeMarkets, normalizePositions, redact, redactValue, type Config, type TradeContext, type LendOutcome, type LpOutcome } from '@potswap_io/sdk'

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
const ok = (data: Record<string, unknown>, summary?: string): ToolResult => ({ content: [{ type: 'text', text: redact(summary ?? JSON.stringify(data, null, 2)) }], structuredContent: redactValue(data) })
const fail = (message: string, extra: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: 'text', text: redact(message) }], structuredContent: redactValue({ error: message, ...extra }), isError: true })
const MINT = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

export function registerDefiTools(server: McpServer, deps: { trade: TradeContext; config: Config }) {
  const { trade } = deps
  const api = trade.api
  const walletOr = (w?: string) => w ?? trade.signer?.publicKey ?? null
  const outcome = (r: LendOutcome | LpOutcome, verb: string): ToolResult => {
    switch (r.kind) {
      case 'no-wallet': case 'refused': case 'failed': return fail(r.message, 'signature' in r && r.signature ? { signature: r.signature, explorerUrl: r.explorerUrl } : {})
      case 'plan': return ok({ confirmRequired: true, plan: r.plan }, `Plan (confirm=true to execute): ${JSON.stringify(r.plan)}`)
      case 'dry-run': return ok({ dryRun: true, plan: r.plan }, `DRY RUN, nothing signed: ${JSON.stringify(r.plan)}`)
      case 'ok': return ok(r.result, `${verb}. ${String(r.result.explorerUrl)}${'feeNote' in r.result && r.result.feeNote ? `\n${String(r.result.feeNote)}` : ''}`)
    }
  }

  server.registerTool('lend_markets', {
    title: 'Lending markets (Jupiter Lend Earn)',
    description: 'Earn markets with supply APY and total deposits. No wallet needed.',
    inputSchema: {},
  }, async () => {
    try {
      const markets = normalizeMarkets(await api.lendTokens())
      return ok({ markets }, markets.map((m) => `${m.assetSymbol.padEnd(6)} ${m.supplyApyPct.toFixed(2)}% APY${m.rewardsApyPct ? ` (+${m.rewardsApyPct.toFixed(2)}% rewards)` : ''} · ${m.totalAssets.toLocaleString(undefined, { maximumFractionDigits: 0 })} deposited · mint ${m.assetMint}`).join('\n'))
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('lend_positions', {
    title: 'Lending positions',
    description: 'The wallet\'s Jupiter Lend Earn positions: shares, underlying amount, USD.',
    inputSchema: { wallet: MINT.optional() },
  }, async ({ wallet }) => {
    const w = walletOr(wallet)
    if (!w) return fail(NO_WALLET)
    try {
      const positions = normalizePositions(await api.lendPositions([w]))
      return ok({ wallet: w, positions }, positions.length ? positions.map((p) => `${p.assetSymbol}: ${p.underlying}${p.underlyingUsd !== undefined ? ` ($${p.underlyingUsd.toFixed(2)})` : ''} · ${p.shares} ${p.symbol}`).join('\n') : 'No lending positions.')
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('lend_deposit', {
    title: 'Deposit into Jupiter Lend Earn',
    description: 'Deposits a token into its Earn market. Requires confirm=true; without it returns the plan. Pays the Potswap fee (sent after the deposit confirms) and earns points. Subject to POTSWAP_MAX_TRADE_SOL and POTSWAP_ALLOWED_TOKENS.',
    inputSchema: { mint: MINT, amount: z.number().positive(), confirm: z.boolean().default(false) },
  }, async (a) => outcome(await executeLend(trade, { action: 'deposit', mint: a.mint, amount: a.amount, confirm: a.confirm }), 'Deposited'))

  server.registerTool('lend_withdraw', {
    title: 'Withdraw from Jupiter Lend Earn',
    description: 'Withdraws an amount (or everything with all=true) from an Earn market. Free. Requires confirm=true.',
    inputSchema: { mint: MINT, amount: z.number().positive().optional(), all: z.boolean().default(false), confirm: z.boolean().default(false) },
  }, async (a) => {
    if (!a.all && a.amount === undefined) return fail('Give amount or all=true. No funds were debited.')
    return outcome(await executeLend(trade, { action: 'withdraw', mint: a.mint, amount: a.all ? 'all' : a.amount!, confirm: a.confirm }), 'Withdrew')
  })

  server.registerTool('lp_pools', {
    title: 'Raydium CPMM pools for a pair',
    description: 'CPMM pools with live reserves (net of protocol fees), LP supply, trade fee and TVL. No wallet needed.',
    inputSchema: { mintA: MINT, mintB: MINT },
  }, async ({ mintA, mintB }) => {
    if (!trade.rpc?.getAccountsData) return fail('Liquidity operations need an RPC connection.')
    try {
      const pools = await lpPools(api, trade.rpc.getAccountsData.bind(trade.rpc), mintA, mintB)
      return ok({ pools }, pools.length ? pools.map((p) => `${p.poolId}: ${p.reserve0} ${p.token0Mint.slice(0, 4)}… / ${p.reserve1} ${p.token1Mint.slice(0, 4)}… · fee ${p.tradeFeeBps} bps${p.tvlUsd ? ` · TVL $${p.tvlUsd.toFixed(0)}` : ''}${p.swapEnabled ? '' : ' · swaps disabled'}`).join('\n') : 'No CPMM pool for this pair.')
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('lp_position', {
    title: 'LP position in a CPMM pool',
    description: 'LP token balance for a pool and the token amounts it represents at current reserves.',
    inputSchema: { poolId: MINT, wallet: MINT.optional() },
  }, async ({ poolId, wallet }) => {
    const w = walletOr(wallet)
    if (!w) return fail(NO_WALLET)
    if (!trade.rpc?.getAccountsData) return fail('Liquidity operations need an RPC connection.')
    try {
      const pos = await lpPosition(trade.rpc.getAccountsData.bind(trade.rpc), await trade.balances(w), poolId)
      if (!pos) return fail('Pool not found or not a Raydium CPMM pool.')
      return ok({ wallet: w, ...pos, lpBalanceRaw: pos.lpBalanceRaw.toString() }, `${pos.lpBalance} LP (${pos.sharePct.toFixed(4)}% of the pool) ≈ ${pos.amount0} ${pos.token0Mint.slice(0, 4)}… + ${pos.amount1} ${pos.token1Mint.slice(0, 4)}…`)
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('lp_deposit', {
    title: 'Add liquidity to a CPMM pool',
    description: 'Deposits `amount` of `mint` (one of the pool tokens) plus the matching amount of the other token for LP tokens. The Potswap fee comes off the given side in the same transaction. Requires confirm=true; without it returns the plan.',
    inputSchema: { poolId: MINT, mint: MINT, amount: z.number().positive(), maxSlippageBps: z.number().int().min(1).max(5000).optional(), confirm: z.boolean().default(false) },
  }, async (a) => outcome(await executeLpDeposit(trade, { poolId: a.poolId, mint: a.mint, amount: a.amount, slippageBps: a.maxSlippageBps, confirm: a.confirm }), 'Liquidity added'))

  server.registerTool('lp_withdraw', {
    title: 'Remove liquidity from a CPMM pool',
    description: 'Burns LP tokens (an amount or a percentage of the balance) for both pool tokens. Free. Requires confirm=true.',
    inputSchema: { poolId: MINT, lpAmount: z.number().positive().optional(), pct: z.number().min(0.01).max(100).optional(), maxSlippageBps: z.number().int().min(1).max(5000).optional(), confirm: z.boolean().default(false) },
  }, async (a) => outcome(await executeLpWithdraw(trade, { poolId: a.poolId, lpAmount: a.lpAmount, pct: a.pct, slippageBps: a.maxSlippageBps, confirm: a.confirm }), 'Liquidity removed'))
}
