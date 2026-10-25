import { describe, expect, it } from 'vitest'
import { dcaIsComplete, isDue, nextRunAfter, rebalancePlan, SOL_MINT, solSpentToday, tpslDecision } from '@potswap_io/sdk'
import type { DcaStrategy, RebalanceStrategy, Run, TpSlStrategy } from '@potswap_io/sdk'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const T0 = Date.parse('2026-11-01T12:00:00Z')
const base = { createdAt: new Date(T0).toISOString(), status: 'active' as const, consecutiveFailures: 0, totals: { runs: 0, volumeUsd: 0, feeUsd: 0, pointsAdded: 0 } }
const dca = (over: Partial<DcaStrategy> = {}): DcaStrategy => ({ ...base, id: 'd1', kind: 'dca', inputMint: SOL_MINT, outputMint: USDC, amountPerRun: 0.1, intervalMinutes: 60, runsDone: 0, nextRunAt: new Date(T0).toISOString(), ...over })

// T-74 (PRD P11.2)
describe('due / next run', () => {
  it('is due at or after nextRunAt, only when active', () => {
    expect(isDue(dca(), T0 - 1)).toBe(false)
    expect(isDue(dca(), T0)).toBe(true)
    expect(isDue(dca({ status: 'paused' }), T0 + 1)).toBe(false)
    expect(isDue(dca({ nextRunAt: null }), T0 + 1)).toBe(false)
  })
  it('schedules the next run from now, so a missed window runs once', () => {
    const lateBy = 5 * 60 * 60_000 // 5 hours of downtime with a 60-min interval
    const next = nextRunAfter(dca(), T0 + lateBy)
    expect(Date.parse(next)).toBe(T0 + lateBy + 60 * 60_000)
  })
  it('completes after totalRuns', () => {
    expect(dcaIsComplete(dca({ totalRuns: 3, runsDone: 2 }))).toBe(false)
    expect(dcaIsComplete(dca({ totalRuns: 3, runsDone: 3 }))).toBe(true)
    expect(dcaIsComplete(dca({ runsDone: 999 }))).toBe(false)
  })
})

// T-75 (PRD P11.4)
describe('rebalancePlan', () => {
  const reb = (over: Partial<RebalanceStrategy> = {}): RebalanceStrategy => ({ ...base, id: 'r1', kind: 'rebalance', targets: { [SOL_MINT]: 50, [USDC]: 50 }, driftPct: 5, checkIntervalMinutes: 60, minTradeUsd: 5, nextRunAt: null, ...over })
  const prices = { [SOL_MINT]: 100, [USDC]: 1, [BONK]: 0.00001 }
  it('is a no-op within the drift band', () => {
    const p = rebalancePlan(reb(), { [SOL_MINT]: 1.04, [USDC]: 96 }, prices) // 52/48
    expect(p.legs).toEqual([])
    expect(p.weights[SOL_MINT]).toBeCloseTo(52, 0)
  })
  it('sells the overweight asset to SOL and buys the underweight from SOL', () => {
    const p = rebalancePlan(reb(), { [SOL_MINT]: 0.5, [USDC]: 150 }, prices) // $50 / $150 → 25/75
    expect(p.legs).toHaveLength(1)
    expect(p.legs[0]).toMatchObject({ inputMint: USDC, outputMint: SOL_MINT })
    expect(p.legs[0].amount).toBeCloseTo(50, 6) // sell $50 USDC
    const q = rebalancePlan(reb(), { [SOL_MINT]: 1.5, [USDC]: 50 }, prices) // $150 / $50
    expect(q.legs[0]).toMatchObject({ inputMint: SOL_MINT, outputMint: USDC })
    expect(q.legs[0].amount).toBeCloseTo(0.5, 6) // buy $50 of USDC with 0.5 SOL
  })
  it('orders sells before buys for three assets', () => {
    const s = reb({ targets: { [SOL_MINT]: 40, [USDC]: 40, [BONK]: 20 } })
    const p = rebalancePlan(s, { [SOL_MINT]: 1, [USDC]: 10, [BONK]: 9_000_000 }, prices) // $100 / $10 / $90
    expect(p.legs.map((l) => `${l.inputMint === SOL_MINT ? 'SOL' : l.inputMint === USDC ? 'USDC' : 'BONK'}>${l.outputMint === SOL_MINT ? 'SOL' : l.outputMint === USDC ? 'USDC' : 'BONK'}`)).toEqual(['BONK>SOL', 'SOL>USDC'])
  })
  it('skips dust and excludes unpriced assets with a warning', () => {
    const p = rebalancePlan(reb({ minTradeUsd: 60 }), { [SOL_MINT]: 0.5, [USDC]: 150 }, prices)
    expect(p.legs).toEqual([]) // $50 trade < $60 minimum
    const u = rebalancePlan(reb({ targets: { [SOL_MINT]: 50, [USDC]: 30, [BONK]: 20 } }), { [SOL_MINT]: 1, [USDC]: 100 }, { [SOL_MINT]: 100, [USDC]: 1 })
    expect(u.warnings[0]).toMatch(/No price for/)
  })
  it('renormalises targets over priced assets', () => {
    const u = rebalancePlan(reb({ targets: { [SOL_MINT]: 50, [USDC]: 30, [BONK]: 20 } }), { [SOL_MINT]: 1, [USDC]: 100 }, { [SOL_MINT]: 100, [USDC]: 1 })
    // priced targets 50:30 → 62.5% / 37.5%; actual 50/50 → USDC overweight by 12.5 → sell $25 USDC
    expect(u.legs).toHaveLength(1)
    expect(u.legs[0].amount).toBeCloseTo(25, 6)
  })
})

// T-76 (PRD P11.5)
describe('tpslDecision', () => {
  const tp = (over: Partial<TpSlStrategy> = {}): TpSlStrategy => ({ ...base, id: 't1', kind: 'tpsl', mint: BONK, sellPct: 100, exitMint: SOL_MINT, entryPrice: 1, highWater: 1, nextRunAt: null, ...over })
  it('take-profit and stop-loss on entry multiples', () => {
    expect(tpslDecision(tp({ takeProfitPct: 50 }), 1.49).trigger).toBeNull()
    expect(tpslDecision(tp({ takeProfitPct: 50 }), 1.5).trigger).toMatchObject({ trigger: 'take-profit' })
    expect(tpslDecision(tp({ stopLossPct: 20 }), 0.81).trigger).toBeNull()
    expect(tpslDecision(tp({ stopLossPct: 20 }), 0.8).trigger).toMatchObject({ trigger: 'stop-loss' })
  })
  it('trailing stop ratchets with the high-water mark and only arms above entry', () => {
    const s = tp({ trailingPct: 15 })
    let d = tpslDecision(s, 2) // new high
    expect(d.highWater).toBe(2); expect(d.trigger).toBeNull()
    d = tpslDecision({ ...s, highWater: 2 }, 1.71)
    expect(d.trigger).toBeNull()
    d = tpslDecision({ ...s, highWater: 2 }, 1.7)
    expect(d.trigger).toMatchObject({ trigger: 'trailing-stop', threshold: 1.7 })
    // below entry with no gain: trailing does not fire (stop-loss would)
    expect(tpslDecision(tp({ trailingPct: 15 }), 0.5).trigger).toBeNull()
  })
  it('never triggers on a missing price', () => {
    expect(tpslDecision(tp({ takeProfitPct: 1, stopLossPct: 1 }), undefined).trigger).toBeNull()
    expect(tpslDecision(tp({ stopLossPct: 1 }), 0).trigger).toBeNull()
  })
})

// T-77 (PRD P11.6) accounting
describe('solSpentToday', () => {
  const run = (at: string, sol?: number, outcome: Run['outcome'] = 'ok'): Run => ({ id: 'x', strategyId: 's', at, action: 'a', outcome, solEquivalent: sol })
  it('sums successful legs in the current UTC day only', () => {
    const now = Date.parse('2026-11-01T23:30:00Z')
    const runs = [run('2026-11-01T00:00:01Z', 1), run('2026-11-01T12:00:00Z', 0.5), run('2026-10-31T23:59:59Z', 9), run('2026-11-01T13:00:00Z', 7, 'failed'), run('2026-11-01T14:00:00Z', 7, 'dry-run')]
    expect(solSpentToday(runs, now)).toBeCloseTo(1.5)
    expect(solSpentToday(runs, Date.parse('2026-11-02T00:00:00Z'))).toBe(0)
  })
})
