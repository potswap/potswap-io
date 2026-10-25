// PRD P11 — runs due strategies through the shared swap path. Injectable clock and timers for tests.
import type { TradeContext } from '../trade.js'
import { executeSwap, type SwapOutcome } from '../trade.js'
import { log } from '../redact.js'
import { observedPrice } from '../observations.js'
import { dcaIsComplete, dcaLegFor, isDue, limitDecision, limitLegFor, MAX_CONSECUTIVE_FAILURES, nextRunAfter, newId, rebalancePlan, solSpentToday, tpslDecision, type Leg } from './engine.js'
import type { StrategyStore } from './store.js'
import type { DcaStrategy, LimitStrategy, RebalanceStrategy, Run, RunOutcome, Strategy, TpSlStrategy } from './types.js'

export interface SchedulerOptions {
  store: StrategyStore
  trade: TradeContext
  maxDailySol: number
  now?: () => number
  tickMs?: number
  onRun?: (run: Run) => void
}

export class Scheduler {
  private store: StrategyStore
  private trade: TradeContext
  private maxDailySol: number
  private now: () => number
  private tickMs: number
  private onRun?: (run: Run) => void
  private timer: NodeJS.Timeout | null = null
  private running = false
  /** Set while a leg executes so a stop() can wait for it (P11.11). */
  inFlight: Promise<void> | null = null
  active = false

  constructor(o: SchedulerOptions) {
    this.store = o.store; this.trade = o.trade; this.maxDailySol = o.maxDailySol
    this.now = o.now ?? Date.now; this.tickMs = o.tickMs ?? 30_000; this.onRun = o.onRun
  }

  start() {
    if (this.timer) return
    this.active = true
    this.timer = setInterval(() => { void this.tick() }, this.tickMs)
    void this.tick()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null; this.active = false
    if (this.inFlight) await this.inFlight
  }

  /** One pass over all strategies. Safe to call concurrently; overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    const p = this.runTick().catch((e) => log('scheduler tick error', e instanceof Error ? e.message : String(e)))
    this.inFlight = p
    try { await p } finally { this.running = false; this.inFlight = null }
  }

  private async runTick() {
    const now = this.now()
    const state = this.store.load()
    for (const s of state.strategies) {
      if (s.status !== 'active') continue
      if (s.kind === 'tpsl') await this.checkTpSl(s)
      else if (s.kind === 'limit') await this.checkLimit(s)
      else if (isDue(s, now)) await (s.kind === 'dca' ? this.runDca(s) : this.runRebalance(s))
    }
  }

  // ---- DCA (P11.1–P11.3)
  private async runDca(s: DcaStrategy) {
    const leg = dcaLegFor(s)
    const out = await this.execute(s, leg)
    this.store.update((st) => {
      const cur = st.strategies.find((x) => x.id === s.id) as DcaStrategy | undefined
      if (!cur || cur.status !== 'active') return
      const now = this.now()
      if (out.kind === 'ok' || out.kind === 'dry-run') cur.runsDone++
      cur.nextRunAt = nextRunAfter(cur, now)
      if (dcaIsComplete(cur)) { cur.status = 'completed'; cur.nextRunAt = null }
    })
  }

  // ---- Rebalance (P11.4)
  private async runRebalance(s: RebalanceStrategy) {
    const wallet = this.trade.signer?.publicKey
    let balances: Record<string, number> = {}, prices: Record<string, number> = {}
    try {
      balances = wallet ? await this.trade.balances(wallet) : {}
      prices = await this.trade.api.prices(Object.keys(s.targets))
    } catch (e) {
      this.record(s, 'check', 'failed', `Could not read balances or prices: ${e instanceof Error ? e.message : String(e)}. No funds were debited.`)
      this.bumpFailure(s.id)
      this.advance(s.id)
      return
    }
    const plan = rebalancePlan(s, balances, prices)
    for (const w of plan.warnings) this.record(s, 'check', 'skipped', w)
    if (plan.legs.length === 0) {
      this.record(s, 'check', 'no-op', `Within ${s.driftPct}% of target: ${Object.entries(plan.weights).map(([m, w]) => `${short(m)} ${w.toFixed(1)}%`).join(', ')}`)
    } else {
      for (const leg of plan.legs) await this.execute(s, leg)
    }
    this.advance(s.id)
  }

  // ---- TP/SL (P11.5)
  private async checkTpSl(s: TpSlStrategy) {
    let price: number | undefined
    try { price = (await this.trade.api.prices([s.mint]))[s.mint] } catch { price = undefined }
    if (price === undefined) { this.record(s, 'check', 'skipped', 'price unavailable'); return }
    const { trigger, highWater } = tpslDecision(s, price)
    this.store.update((st) => { const cur = st.strategies.find((x) => x.id === s.id) as TpSlStrategy | undefined; if (cur) cur.highWater = highWater })
    if (!trigger) return
    const wallet = this.trade.signer?.publicKey
    const held = wallet ? (await this.trade.balances(wallet).catch(() => ({} as Record<string, number>)))[s.mint] ?? 0 : 0
    const amount = Math.floor(held * (s.sellPct / 100) * 1e9) / 1e9
    if (amount <= 0) {
      this.record(s, `sell ${s.sellPct}% (${trigger.trigger})`, 'completed', 'Nothing to sell; completing.')
      this.complete(s.id)
      return
    }
    const out = await this.execute(s, { inputMint: s.mint, outputMint: s.exitMint, amount, reason: `${trigger.trigger} at ${price} (threshold ${trigger.threshold.toPrecision(6)})` })
    if (out.kind === 'ok' || out.kind === 'dry-run') this.complete(s.id)
  }

  // ---- Limit orders (P13.10)
  private async checkLimit(s: LimitStrategy) {
    let price: number | undefined
    try {
      price = s.priceSource === 'observations'
        ? (await observedPrice(this.trade.api, s.mint, s.minPublishers ?? 2, this.now())).price
        : (await this.trade.api.prices([s.mint]))[s.mint]
    } catch { price = undefined }
    const d = limitDecision(s, price, this.now())
    if (d === 'expired') { this.record(s, 'check', 'completed', 'Expired unfilled.'); this.complete(s.id); return }
    if (d !== 'fill') return
    const out = await this.execute(s, limitLegFor(s))
    if (out.kind === 'ok' || out.kind === 'dry-run') this.complete(s.id)
  }

  // ---- shared leg execution with caps, run log, failure counting (P11.6–P11.8, P11.13)
  private async execute(s: Strategy, leg: Leg): Promise<SwapOutcome> {
    const now = this.now()
    const spent = solSpentToday(this.store.load().runs, now)
    const remainingSol = Math.max(0, this.maxDailySol - spent)
    const out = await executeSwap(this.trade, {
      inputMint: leg.inputMint, outputMint: leg.outputMint, amount: leg.amount, slippageBps: s.maxSlippageBps, confirm: true,
      extraSolCap: { remainingSol, label: `Daily cap reached (${this.maxDailySol} SOL). Next legs resume at 00:00 UTC.` },
    })
    const action = `${leg.amount} ${short(leg.inputMint)} → ${short(leg.outputMint)} (${leg.reason})`
    switch (out.kind) {
      case 'ok': {
        const r = out.result
        this.record(s, action, 'ok', undefined, { signature: r.signature, inAmount: r.inAmount, inputSymbol: r.inputSymbol, outAmount: r.outAmount, outputSymbol: r.outputSymbol, feeUsd: r.feeUsd, pointsAdded: r.pointsAdded, solEquivalent: r.solEquivalent })
        this.store.update((st) => {
          const cur = st.strategies.find((x) => x.id === s.id)
          if (!cur) return
          cur.consecutiveFailures = 0
          cur.totals.runs++; cur.totals.feeUsd += r.feeUsd ?? 0; cur.totals.pointsAdded += r.pointsAdded ?? 0; cur.totals.volumeUsd += out.quote.inputUsd ?? 0
        })
        break
      }
      case 'dry-run': this.record(s, action, 'dry-run', `Would swap for ${out.quote.outAmount} ${out.quote.outputSymbol} via ${out.quote.router}`); break
      case 'refused': this.record(s, action, 'skipped', out.message); break
      case 'quote-only': this.record(s, action, 'skipped', 'internal: confirm missing'); break
      case 'no-wallet': this.record(s, action, 'failed', out.message); this.bumpFailure(s.id); break
      case 'failed': this.record(s, action, 'failed', out.message, { signature: out.signature }); this.bumpFailure(s.id); break
    }
    return out
  }

  private record(s: Strategy, action: string, outcome: RunOutcome, message?: string, extra: Partial<Run> = {}) {
    const run: Run = { id: newId('run', this.now()), strategyId: s.id, at: new Date(this.now()).toISOString(), action, outcome, message, ...extra }
    this.store.update((st) => { st.runs.push(run) })
    this.onRun?.(run)
    log(`[${s.kind} ${s.id}] ${outcome}: ${action}${message ? ` — ${message}` : ''}`)
  }

  private bumpFailure(id: string) {
    this.store.update((st) => {
      const cur = st.strategies.find((x) => x.id === id)
      if (!cur) return
      cur.consecutiveFailures++
      if (cur.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        cur.status = 'paused'; cur.pausedReason = `${MAX_CONSECUTIVE_FAILURES} consecutive failures; resume after checking the wallet and route.`; cur.nextRunAt = null
      }
    })
  }

  private advance(id: string) {
    this.store.update((st) => {
      const cur = st.strategies.find((x) => x.id === id)
      if (cur && cur.status === 'active' && cur.kind !== 'tpsl' && cur.kind !== 'limit') cur.nextRunAt = nextRunAfter(cur, this.now())
    })
  }

  private complete(id: string) {
    this.store.update((st) => { const cur = st.strategies.find((x) => x.id === id); if (cur) { cur.status = 'completed'; cur.nextRunAt = null } })
  }
}

const short = (m: string) => (m === 'So11111111111111111111111111111111111111112' ? 'SOL' : m.slice(0, 4) + '…' + m.slice(-4))
