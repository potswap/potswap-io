// PRD P11 — pure strategy logic. No I/O, no clocks: everything takes `now` and data in.
import type { DcaStrategy, LimitStrategy, RebalanceStrategy, Run, Strategy, TpSlStrategy } from './types.js'

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
const MIN = 60_000

/** True when a time-based strategy should run at `now`. */
export function isDue(s: Strategy, now: number): boolean {
  if (s.status !== 'active' || !s.nextRunAt) return false
  return Date.parse(s.nextRunAt) <= now
}

/**
 * Next run after a run at `now`. A missed window runs once; the next slot is
 * always in the future (P11.2), never a catch-up burst.
 */
export function nextRunAfter(s: DcaStrategy | RebalanceStrategy, now: number): string {
  const interval = (s.kind === 'dca' ? s.intervalMinutes : s.checkIntervalMinutes) * MIN
  return new Date(now + interval).toISOString()
}

export function dcaIsComplete(s: DcaStrategy): boolean {
  return s.totalRuns !== undefined && s.runsDone >= s.totalRuns
}

export interface Leg { inputMint: string; outputMint: string; amount: number; reason: string }

/**
 * Rebalance plan (P11.4): weights from balances × prices; assets drifting more than
 * `driftPct` points are brought back via SOL. Returns [] when nothing drifts.
 * Unpriced targets are excluded and reported in `warnings`.
 */
export function rebalancePlan(s: RebalanceStrategy, balances: Record<string, number>, prices: Record<string, number>): { legs: Leg[]; warnings: string[]; weights: Record<string, number> } {
  const warnings: string[] = []
  const mints = Object.keys(s.targets)
  const priced = mints.filter((m) => prices[m] > 0)
  for (const m of mints) if (!(prices[m] > 0)) warnings.push(`No price for ${m}; it is excluded until one is available.`)
  const values = Object.fromEntries(priced.map((m) => [m, (balances[m] ?? 0) * prices[m]]))
  const total = Object.values(values).reduce((a, b) => a + b, 0)
  const weights: Record<string, number> = {}
  if (total <= 0) return { legs: [], warnings, weights }
  for (const m of priced) weights[m] = (values[m] / total) * 100

  // Re-normalise targets over priced assets only.
  const targetSum = priced.reduce((a, m) => a + s.targets[m], 0)
  const targets = Object.fromEntries(priced.map((m) => [m, (s.targets[m] / targetSum) * 100]))
  const drifted = priced.some((m) => Math.abs(weights[m] - targets[m]) > s.driftPct)
  if (!drifted) return { legs: [], warnings, weights }

  const legs: Leg[] = []
  const deltaUsd = Object.fromEntries(priced.map((m) => [m, (targets[m] / 100) * total - values[m]])) // + = buy, − = sell
  // Sells first (overweight non-SOL → SOL), then buys (SOL → underweight).
  for (const m of priced) {
    if (m === SOL_MINT) continue
    const d = deltaUsd[m]
    if (d < 0 && -d >= s.minTradeUsd) legs.push({ inputMint: m, outputMint: SOL_MINT, amount: round(-d / prices[m]), reason: `sell overweight ${pct(weights[m])}% → ${pct(targets[m])}%` })
  }
  for (const m of priced) {
    if (m === SOL_MINT) continue
    const d = deltaUsd[m]
    if (d > 0 && d >= s.minTradeUsd) legs.push({ inputMint: SOL_MINT, outputMint: m, amount: round(d / prices[SOL_MINT]), reason: `buy underweight ${pct(weights[m])}% → ${pct(targets[m])}%` })
  }
  return { legs, warnings, weights }
}

export type TpSlTrigger = { trigger: 'take-profit' | 'stop-loss' | 'trailing-stop'; threshold: number } | null

/** TP/SL decision (P11.5). `price` undefined = no decision. Returns the updated high-water mark too. */
export function tpslDecision(s: TpSlStrategy, price: number | undefined): { trigger: TpSlTrigger; highWater: number } {
  if (price === undefined || !(price > 0)) return { trigger: null, highWater: s.highWater }
  const highWater = Math.max(s.highWater, price)
  if (s.takeProfitPct !== undefined) {
    const t = s.entryPrice * (1 + s.takeProfitPct / 100)
    if (price >= t) return { trigger: { trigger: 'take-profit', threshold: t }, highWater }
  }
  if (s.trailingPct !== undefined) {
    const t = highWater * (1 - s.trailingPct / 100)
    if (price <= t && highWater > s.entryPrice) return { trigger: { trigger: 'trailing-stop', threshold: t }, highWater }
  }
  if (s.stopLossPct !== undefined) {
    const t = s.entryPrice * (1 - s.stopLossPct / 100)
    if (price <= t) return { trigger: { trigger: 'stop-loss', threshold: t }, highWater }
  }
  return { trigger: null, highWater }
}

/** SOL-equivalent spent by all strategies in the UTC day containing `now` (P11.6). */
export function solSpentToday(runs: Run[], now: number): number {
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0)
  return runs.filter((r) => r.outcome === 'ok' && Date.parse(r.at) >= dayStart.getTime()).reduce((a, r) => a + (r.solEquivalent ?? 0), 0)
}

export function dcaLegFor(s: DcaStrategy): Leg {
  return { inputMint: s.inputMint, outputMint: s.outputMint, amount: s.amountPerRun, reason: `DCA run ${s.runsDone + 1}${s.totalRuns ? `/${s.totalRuns}` : ''}` }
}

/** Limit order decision (P13.10): 'fill' when the condition holds, 'expired' past expiresAt, else null. */
export function limitDecision(s: LimitStrategy, price: number | undefined, now: number): 'fill' | 'expired' | null {
  if (s.expiresAt && Date.parse(s.expiresAt) <= now) return 'expired'
  if (price === undefined || !(price > 0)) return null
  if (s.condition === 'below' && price <= s.triggerPriceUsd) return 'fill'
  if (s.condition === 'above' && price >= s.triggerPriceUsd) return 'fill'
  return null
}

export function limitLegFor(s: LimitStrategy): Leg {
  return s.side === 'buy'
    ? { inputMint: s.quoteMint, outputMint: s.mint, amount: s.amount, reason: `limit buy (${s.condition} ${s.triggerPriceUsd})` }
    : { inputMint: s.mint, outputMint: s.quoteMint, amount: s.amount, reason: `limit sell (${s.condition} ${s.triggerPriceUsd})` }
}

export const MAX_CONSECUTIVE_FAILURES = 3

const round = (n: number) => Math.floor(n * 1e9) / 1e9
const pct = (n: number) => n.toFixed(1)

export function newId(prefix: string, now = Date.now()) {
  return `${prefix}_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
