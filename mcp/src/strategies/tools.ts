// PRD P11 — the seven strategy tools.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { TradeContext } from '@potswap_io/sdk'
import { NO_WALLET } from '@potswap_io/sdk'
import { redact, redactValue } from '@potswap_io/sdk'
import { newId, SOL_MINT, nextRunAfter } from '@potswap_io/sdk'
import { findStrategy, runsOf, type StrategyStore } from '@potswap_io/sdk'
import type { Scheduler } from '@potswap_io/sdk'
import type { DcaStrategy, LimitStrategy, RebalanceStrategy, Strategy, TpSlStrategy } from '@potswap_io/sdk'

const MINT = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
const MAX_STRATEGIES = Number(process.env.POTSWAP_MAX_STRATEGIES) || 10

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
const ok = (data: Record<string, unknown>, summary?: string): ToolResult => ({ content: [{ type: 'text', text: redact(summary ?? JSON.stringify(data, null, 2)) }], structuredContent: redactValue(data) })
const fail = (message: string, extra: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: 'text', text: redact(message) }], structuredContent: redactValue({ error: message, ...extra }), isError: true })

export interface StrategyDeps { trade: TradeContext; store?: StrategyStore; scheduler?: Scheduler }

export function registerStrategyTools(server: McpServer, deps: StrategyDeps) {
  const { trade } = deps
  if (!deps.store) return // strategies disabled (no state dir)
  const store: StrategyStore = deps.store
  const scheduler = deps.scheduler
  const now = () => Date.now()

  const base = (kind: Strategy['kind'], maxSlippageBps?: number) => ({
    id: newId(kind, now()), createdAt: new Date(now()).toISOString(), status: 'active' as const, nextRunAt: new Date(now()).toISOString(),
    consecutiveFailures: 0, totals: { runs: 0, volumeUsd: 0, feeUsd: 0, pointsAdded: 0 }, maxSlippageBps,
  })
  const guard = (confirm: boolean): ToolResult | null => {
    if (!trade.signer) return fail(NO_WALLET)
    if (!confirm) return fail('Set confirm=true to create a strategy. Nothing was created and no funds were debited.')
    if (store.load().strategies.filter((s) => s.status === 'active').length >= MAX_STRATEGIES) return fail(`Limit of ${MAX_STRATEGIES} active strategies reached. Pause or delete one first.`)
    return null
  }
  const created = async (s: Strategy, summary: string) => {
    store.update((st) => { st.strategies.push(s) })
    // First leg right away (P11.1) when a scheduler is attached.
    if (scheduler) await scheduler.tick()
    const fresh = findStrategy(store.load(), s.id) ?? s
    return ok({ strategy: fresh, schedulerActive: !!scheduler?.active, runs: runsOf(store.load(), s.id, 3) }, `${summary}\nid=${s.id}${scheduler?.active ? '' : '\nNote: no scheduler is running in this process; run `npx @potswap_io/mcp --daemon` to execute strategies 24/7.'}`)
  }

  server.registerTool('dca_create', {
    title: 'Create a DCA strategy',
    description: 'Buy a fixed amount of a token on a schedule (first run immediately). Every leg pays the Potswap fee and earns POT points. Runs while this host is open, or 24/7 with `npx @potswap_io/mcp --daemon`.',
    inputSchema: {
      inputMint: MINT, outputMint: MINT,
      amountPerRun: z.number().positive().describe('UI units of the input token per run (1 = 1 SOL)'),
      intervalMinutes: z.number().int().min(5).max(60 * 24 * 30),
      totalRuns: z.number().int().min(1).max(1000).optional(),
      maxSlippageBps: z.number().int().min(1).max(5000).optional(),
      confirm: z.boolean().default(false),
    },
  }, async (a) => {
    const g = guard(a.confirm); if (g) return g
    if (a.inputMint === a.outputMint) return fail('inputMint and outputMint must differ. Nothing was created.')
    const s: DcaStrategy = { ...base('dca', a.maxSlippageBps), kind: 'dca', inputMint: a.inputMint, outputMint: a.outputMint, amountPerRun: a.amountPerRun, intervalMinutes: a.intervalMinutes, totalRuns: a.totalRuns, runsDone: 0 }
    return created(s, `DCA created: ${a.amountPerRun} per run every ${a.intervalMinutes} min${a.totalRuns ? ` × ${a.totalRuns}` : ''}.`)
  })

  server.registerTool('rebalance_create', {
    title: 'Create a rebalance strategy',
    description: 'Keep the wallet at target percentages (2–6 assets incl. SOL). Checks on an interval; trades only when an asset drifts more than driftPct, routing through SOL.',
    inputSchema: {
      targets: z.record(MINT, z.number().min(0).max(100)).describe('mint → percent; must sum to 100 and include SOL'),
      driftPct: z.number().min(1).max(50).default(5),
      checkIntervalMinutes: z.number().int().min(15).max(60 * 24 * 7).default(60),
      minTradeUsd: z.number().min(1).default(5),
      maxSlippageBps: z.number().int().min(1).max(5000).optional(),
      confirm: z.boolean().default(false),
    },
  }, async (a) => {
    const g = guard(a.confirm); if (g) return g
    const mints = Object.keys(a.targets)
    const sum = Object.values(a.targets).reduce((x, y) => x + y, 0)
    if (mints.length < 2 || mints.length > 6) return fail('targets must list 2–6 assets. Nothing was created.')
    if (Math.abs(sum - 100) > 0.5) return fail(`targets must sum to 100 (got ${sum}). Nothing was created.`)
    if (!(SOL_MINT in a.targets)) return fail('targets must include SOL (So11111111111111111111111111111111111111112). Nothing was created.')
    const s: RebalanceStrategy = { ...base('rebalance', a.maxSlippageBps), kind: 'rebalance', targets: a.targets, driftPct: a.driftPct, checkIntervalMinutes: a.checkIntervalMinutes, minTradeUsd: a.minTradeUsd }
    return created(s, `Rebalance created: ${mints.map((m) => `${m === SOL_MINT ? 'SOL' : m.slice(0, 4)} ${a.targets[m]}%`).join(' / ')}, drift ${a.driftPct}%, every ${a.checkIntervalMinutes} min.`)
  })

  server.registerTool('tpsl_create', {
    title: 'Create a take-profit / stop-loss',
    description: 'Sell a percentage of a position when its price reaches a take-profit, stop-loss or trailing-stop level (entry = price now). Checks every 30 s while a scheduler runs.',
    inputSchema: {
      mint: MINT, sellPct: z.number().min(1).max(100).default(100),
      takeProfitPct: z.number().positive().optional(), stopLossPct: z.number().positive().max(99).optional(), trailingPct: z.number().positive().max(99).optional(),
      exitMint: MINT.default(SOL_MINT), maxSlippageBps: z.number().int().min(1).max(5000).optional(),
      confirm: z.boolean().default(false),
    },
  }, async (a) => {
    const g = guard(a.confirm); if (g) return g
    if (a.takeProfitPct === undefined && a.stopLossPct === undefined && a.trailingPct === undefined) return fail('Set at least one of takeProfitPct, stopLossPct, trailingPct. Nothing was created.')
    if (a.mint === a.exitMint) return fail('mint and exitMint must differ. Nothing was created.')
    let entry: number | undefined
    try { entry = (await trade.api.prices([a.mint]))[a.mint] } catch { entry = undefined }
    if (!entry) return fail('No price available for this token right now; try again in a moment. Nothing was created.')
    const s: TpSlStrategy = { ...base('tpsl', a.maxSlippageBps), kind: 'tpsl', mint: a.mint, sellPct: a.sellPct, exitMint: a.exitMint, entryPrice: entry, highWater: entry, takeProfitPct: a.takeProfitPct, stopLossPct: a.stopLossPct, trailingPct: a.trailingPct, nextRunAt: null }
    return created(s, `TP/SL created at entry ${entry}: ${[a.takeProfitPct && `TP +${a.takeProfitPct}%`, a.stopLossPct && `SL −${a.stopLossPct}%`, a.trailingPct && `trailing ${a.trailingPct}%`].filter(Boolean).join(', ')}, sells ${a.sellPct}%.`)
  })

  server.registerTool('limit_order_create', {
    title: 'Create a limit order (price-triggered swap)',
    description: 'Buy or sell a token when its USD price crosses a level. Runs through the strategy scheduler (needs this host open or the daemon). Fills once at the best route with the normal fee and points, then completes. priceSource=observations uses the median of fresh signed observations instead of the price API.',
    inputSchema: {
      side: z.enum(['buy', 'sell']), mint: MINT, quoteMint: MINT.default(SOL_MINT),
      amount: z.number().positive().describe('Input amount in UI units: quote (SOL) amount for buys, token amount for sells'),
      triggerPriceUsd: z.number().positive(), condition: z.enum(['above', 'below']),
      expiresAt: z.string().datetime().optional(), maxSlippageBps: z.number().int().min(1).max(5000).optional(),
      priceSource: z.enum(['potswap', 'observations']).default('potswap').describe('observations = median of fresh signed observations from at least minPublishers publishers (PRD P15)'),
      minPublishers: z.number().int().min(1).max(50).default(2),
      confirm: z.boolean().default(false),
    },
  }, async (a) => {
    const g = guard(a.confirm); if (g) return g
    if (a.mint === a.quoteMint) return fail('mint and quoteMint must differ. Nothing was created.')
    const s: LimitStrategy = { ...base('limit', a.maxSlippageBps), kind: 'limit', side: a.side, mint: a.mint, quoteMint: a.quoteMint, amount: a.amount, triggerPriceUsd: a.triggerPriceUsd, condition: a.condition, expiresAt: a.expiresAt, nextRunAt: null, ...(a.priceSource === 'observations' ? { priceSource: 'observations' as const, minPublishers: a.minPublishers } : {}) }
    return created(s, `Limit ${a.side} created: ${a.amount} ${a.side === 'buy' ? 'quote' : 'tokens'} when price ${a.condition} $${a.triggerPriceUsd}${a.expiresAt ? ` until ${a.expiresAt}` : ''}.`)
  })

  server.registerTool('strategy_list', { title: 'List strategies', description: 'All strategies with status, next run, totals and last result.', inputSchema: {} }, async () => {
    const st = store.load()
    const rows = st.strategies.map((s) => ({ ...s, lastRun: runsOf(st, s.id, 1)[0] ?? null }))
    return ok({ schedulerActive: !!scheduler?.active, stateFile: store.location, strategies: rows },
      rows.length ? rows.map((s) => `${s.id} ${s.kind} ${s.status}${s.pausedReason ? ` (${s.pausedReason})` : ''} next=${s.nextRunAt ?? '—'} runs=${s.totals.runs} fees=$${s.totals.feeUsd.toFixed(2)}`).join('\n') : 'No strategies yet.')
  })

  const byId = { id: z.string().min(3) }
  server.registerTool('strategy_pause', { title: 'Pause a strategy', description: 'Stops future legs; keeps history.', inputSchema: byId }, async ({ id }) =>
    mutate(id, (s) => { s.status = 'paused'; s.pausedReason = 'paused by user'; s.nextRunAt = null }))
  server.registerTool('strategy_resume', { title: 'Resume a strategy', description: 'Re-activates a paused strategy; the next run is scheduled from now.', inputSchema: byId }, async ({ id }) =>
    mutate(id, (s) => { if (s.status === 'completed') throw new Error('Completed strategies cannot be resumed; create a new one.'); s.status = 'active'; s.pausedReason = undefined; s.consecutiveFailures = 0; s.nextRunAt = s.kind === 'tpsl' || s.kind === 'limit' ? null : nextRunAfter(s, now()) }))
  server.registerTool('strategy_delete', { title: 'Delete a strategy', description: 'Removes the strategy; its run history is kept.', inputSchema: byId }, async ({ id }) => {
    const existed = store.update((st) => { const n = st.strategies.length; st.strategies = st.strategies.filter((s) => s.id !== id); return n !== st.strategies.length })
    return existed ? ok({ deleted: id }, `Deleted ${id}.`) : fail(`No strategy ${id}.`)
  })
  server.registerTool('strategy_runs', { title: 'Strategy run log', description: 'Recent legs with amounts, signatures, fees, points, or the skip/fail reason.', inputSchema: { id: z.string().min(3), limit: z.number().int().min(1).max(200).default(20) } }, async ({ id, limit }) => {
    const st = store.load()
    if (!findStrategy(st, id)) return fail(`No strategy ${id}.`)
    const runs = runsOf(st, id, limit)
    return ok({ id, runs }, runs.length ? runs.map((r) => `${r.at} ${r.outcome}: ${r.action}${r.signature ? ` sig=${r.signature}` : ''}${r.message ? ` — ${r.message}` : ''}`).join('\n') : 'No runs yet.')
  })

  function mutate(id: string, fn: (s: Strategy) => void): ToolResult {
    try {
      const s = store.update((st) => { const cur = findStrategy(st, id); if (!cur) return null; fn(cur); return cur })
      return s ? ok({ strategy: s }, `${s.id} is now ${s.status}.`) : fail(`No strategy ${id}.`)
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  }
}
