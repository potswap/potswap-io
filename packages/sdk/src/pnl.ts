// PRD P13.7 — positions with average cost and PnL from swap history (pure, average-cost method).
import type { HistoryItem } from './history.js'
import { SOL } from './history.js'

export interface Position {
  mint: string
  amount: number
  avgCostUsd?: number // per unit, from buys
  costBasisUsd?: number // amount × avgCost
  valueUsd?: number
  unrealisedUsd?: number
  realisedUsd: number
}

/**
 * Walks swaps oldest→newest. A swap "buys" its outMint at (inAmount × price(inMint at the time)) and
 * "sells" its inMint. Price history is approximated with current prices unless the item carries `inUsd`.
 * Good enough for an agent dashboard; exact fills come from the on-chain record.
 */
export function computePositions(history: HistoryItem[], balances: Record<string, number>, prices: Record<string, number>, quoteMints = new Set([SOL])): Position[] {
  const lots: Record<string, { amount: number; cost: number; realised: number }> = {}
  const items = [...history].filter((h) => h.kind === 'swap' && !h.failed).sort((a, b) => a.time.localeCompare(b.time))
  for (const h of items) {
    const inUsd = (h as HistoryItem & { inUsd?: number }).inUsd ?? (h.inMint && prices[h.inMint] ? (h.inAmount ?? 0) * prices[h.inMint] : undefined)
    // sell side
    if (h.inMint && !quoteMints.has(h.inMint) && h.inAmount) {
      const l = (lots[h.inMint] ??= { amount: 0, cost: 0, realised: 0 })
      const avg = l.amount > 0 ? l.cost / l.amount : 0
      const sold = Math.min(h.inAmount, l.amount)
      const proceeds = h.outMint && prices[h.outMint] ? (h.outAmount ?? 0) * prices[h.outMint] : inUsd ?? 0
      l.realised += proceeds - sold * avg
      l.amount -= sold; l.cost -= sold * avg
      if (l.amount < 1e-12) { l.amount = 0; l.cost = 0 }
    }
    // buy side
    if (h.outMint && !quoteMints.has(h.outMint) && h.outAmount && inUsd !== undefined) {
      const l = (lots[h.outMint] ??= { amount: 0, cost: 0, realised: 0 })
      l.amount += h.outAmount; l.cost += inUsd
    }
  }
  const mints = new Set([...Object.keys(balances), ...Object.keys(lots)].filter((m) => !quoteMints.has(m)))
  return [...mints].map((mint) => {
    const amount = balances[mint] ?? 0
    const l = lots[mint]
    const avg = l && l.amount > 0 ? l.cost / l.amount : undefined
    const price = prices[mint]
    const value = price !== undefined ? amount * price : undefined
    return {
      mint, amount, avgCostUsd: avg, costBasisUsd: avg !== undefined ? amount * avg : undefined, valueUsd: value,
      unrealisedUsd: value !== undefined && avg !== undefined ? value - amount * avg : undefined, realisedUsd: l?.realised ?? 0,
    }
  }).filter((p) => p.amount > 0 || p.realisedUsd !== 0).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
}
