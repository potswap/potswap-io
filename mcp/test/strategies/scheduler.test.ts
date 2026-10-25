import { describe, expect, it } from 'vitest'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { PotswapApi } from '@potswap_io/sdk'
import { loadConfig } from '@potswap_io/sdk'
import { loadSigner } from '@potswap_io/sdk'
import { Scheduler } from '@potswap_io/sdk'
import { MemoryStore } from '@potswap_io/sdk'
import type { DcaStrategy, RebalanceStrategy, TpSlStrategy } from '@potswap_io/sdk'
import { mockFetch, unsignedTx, SOL, USDC, BONK, type MockState } from '../helpers.js'

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const T0 = Date.parse('2026-11-01T12:00:00Z')
const cfgJson = { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false }
const totals = () => ({ runs: 0, volumeUsd: 0, feeUsd: 0, pointsAdded: 0 })

function setup(opts: { state?: MockState; dryRun?: boolean; balances?: Record<string, number>; maxDailySol?: number; signer?: typeof signer | null } = {}) {
  const st: MockState = opts.state ?? { calls: [], config: cfgJson, orderTx: unsignedTx(kp) }
  const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local', POTSWAP_DRY_RUN: opts.dryRun ? 'true' : '', POTSWAP_MAX_DAILY_SOL: String(opts.maxDailySol ?? 5) })
  const api = new PotswapApi(config.apiBase, mockFetch(st))
  let bal = opts.balances ?? { [SOL]: 10, [USDC]: 1000, [BONK]: 1_000_000 }
  const store = new MemoryStore()
  let now = T0
  const scheduler = new Scheduler({ store, trade: { api, config, signer: opts.signer === undefined ? signer : opts.signer, balances: async () => bal }, maxDailySol: config.maxDailySol, now: () => now, tickMs: 1e9 })
  return { st, store, scheduler, setNow: (t: number) => { now = t }, setBalances: (b: Record<string, number>) => { bal = b } }
}
const executes = (st: MockState) => st.calls.filter((c) => c.url.pathname.endsWith('/execute')).length
const dcaStrategy = (over: Partial<DcaStrategy> = {}): DcaStrategy => ({ id: 'dca_1', kind: 'dca', createdAt: new Date(T0).toISOString(), status: 'active', nextRunAt: new Date(T0).toISOString(), consecutiveFailures: 0, totals: totals(), inputMint: SOL, outputMint: USDC, amountPerRun: 0.1, intervalMinutes: 60, runsDone: 0, ...over })

// T-73 (P11.1/P11.3), T-82 (P11.13)
describe('DCA', () => {
  it('runs the due leg through the real swap path, logs fee and points, schedules the next run, completes after totalRuns', async () => {
    const { st, store, scheduler, setNow } = setup()
    store.update((s) => { s.strategies.push(dcaStrategy({ totalRuns: 2 })) })
    await scheduler.tick()
    expect(executes(st)).toBe(1)
    const order = st.calls.find((c) => c.url.pathname.endsWith('/order') && c.url.searchParams.has('taker'))!.url.searchParams
    expect(order.get('taker')).toBe(kp.publicKey.toBase58())
    expect(order.get('referralFee')).toBe('250')
    let s = store.load().strategies[0] as DcaStrategy
    expect(s.runsDone).toBe(1)
    expect(Date.parse(s.nextRunAt!)).toBe(T0 + 60 * 60_000)
    const run = store.load().runs.at(-1)!
    expect(run).toMatchObject({ outcome: 'ok', inputSymbol: 'SOL', outputSymbol: 'USDC', solEquivalent: 0.1 })
    expect(run.feeUsd).toBeCloseTo(0.1 * 100 * 0.005) // mocked order echoes 250 bps → $0.05
    expect(run.pointsAdded).toBeCloseTo(0.05)
    // not due yet
    setNow(T0 + 30 * 60_000); await scheduler.tick(); expect(executes(st)).toBe(1)
    // due → second and last run
    setNow(T0 + 61 * 60_000); await scheduler.tick(); expect(executes(st)).toBe(2)
    s = store.load().strategies[0] as DcaStrategy
    expect(s.status).toBe('completed'); expect(s.nextRunAt).toBeNull()
    setNow(T0 + 200 * 60_000); await scheduler.tick(); expect(executes(st)).toBe(2)
    expect(s.totals.runs).toBe(2)
  })
  it('a missed window runs once, then resumes the normal cadence (T-74)', async () => {
    const { st, store, scheduler, setNow } = setup()
    store.update((s) => { s.strategies.push(dcaStrategy()) })
    setNow(T0 + 5 * 60 * 60_000) // woke up 5 h late
    await scheduler.tick(); await scheduler.tick()
    expect(executes(st)).toBe(1)
    expect(Date.parse((store.load().strategies[0] as DcaStrategy).nextRunAt!)).toBe(T0 + 6 * 60 * 60_000)
  })
})

// T-77 (P11.6)
describe('caps', () => {
  it('skips a leg over the daily cap with the copy and keeps the strategy active', async () => {
    const { st, store, scheduler, setNow } = setup({ maxDailySol: 0.25 })
    store.update((s) => { s.strategies.push(dcaStrategy({ intervalMinutes: 5 })) })
    await scheduler.tick(); setNow(T0 + 5 * 60_000); await scheduler.tick(); setNow(T0 + 10 * 60_000); await scheduler.tick()
    expect(executes(st)).toBe(2) // 0.1 + 0.1 = 0.2; third would exceed 0.25
    const runs = store.load().runs
    expect(runs.at(-1)).toMatchObject({ outcome: 'skipped' })
    expect(runs.at(-1)!.message).toMatch(/Daily cap reached \(0\.25 SOL\).*No funds were debited/)
    expect(store.load().strategies[0].status).toBe('active')
    // next UTC day resets the cap
    setNow(Date.parse('2026-11-02T00:01:00Z')); await scheduler.tick()
    expect(executes(st)).toBe(3)
  })
  it('skips a leg over the per-trade cap', async () => {
    const { st, store, scheduler } = setup()
    store.update((s) => { s.strategies.push(dcaStrategy({ amountPerRun: 2 })) })
    await scheduler.tick()
    expect(executes(st)).toBe(0)
    expect(store.load().runs.at(-1)!.message).toMatch(/POTSWAP_MAX_TRADE_SOL/)
  })
})

// T-78, T-79 (P11.7–P11.9)
describe('failures and dry run', () => {
  it('pauses after three consecutive failures and resets on success', async () => {
    const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp), executeResult: { status: 'Failed', code: -1000, error: 'failed to land' } }
    const { store, scheduler, setNow } = setup({ state: st })
    store.update((s) => { s.strategies.push(dcaStrategy({ intervalMinutes: 5 })) })
    for (let i = 0; i < 3; i++) { setNow(T0 + i * 5 * 60_000); await scheduler.tick() }
    const s = store.load().strategies[0]
    expect(s.status).toBe('paused')
    expect(s.pausedReason).toMatch(/3 consecutive failures/)
    expect(store.load().runs.filter((r) => r.outcome === 'failed')).toHaveLength(3)
    expect(store.load().runs.at(-1)!.message).toMatch(/No funds were debited/)
  })
  it('dry-run logs the quote and never signs', async () => {
    const { st, store, scheduler } = setup({ dryRun: true })
    store.update((s) => { s.strategies.push(dcaStrategy()) })
    await scheduler.tick()
    expect(executes(st)).toBe(0)
    expect(store.load().runs.at(-1)).toMatchObject({ outcome: 'dry-run' })
    expect((store.load().strategies[0] as DcaStrategy).runsDone).toBe(1)
  })
  it('without a wallet a leg fails with the no-wallet copy', async () => {
    const { st, store, scheduler } = setup({ signer: null })
    store.update((s) => { s.strategies.push(dcaStrategy()) })
    await scheduler.tick()
    expect(executes(st)).toBe(0)
    expect(store.load().runs.at(-1)!.message).toMatch(/Wallet not configured/)
  })
})

// T-75 end-to-end (P11.4)
describe('rebalance', () => {
  const reb: RebalanceStrategy = { id: 'reb_1', kind: 'rebalance', createdAt: new Date(T0).toISOString(), status: 'active', nextRunAt: new Date(T0).toISOString(), consecutiveFailures: 0, totals: totals(), targets: { [SOL]: 50, [USDC]: 50 }, driftPct: 5, checkIntervalMinutes: 60, minTradeUsd: 5 }
  it('no-ops within drift and trades the minimal legs when drifted', async () => {
    const { st, store, scheduler, setNow, setBalances } = setup({ balances: { [SOL]: 1, [USDC]: 100 } }) // $100/$100
    store.update((s) => { s.strategies.push(reb) })
    await scheduler.tick()
    expect(executes(st)).toBe(0)
    expect(store.load().runs.at(-1)).toMatchObject({ outcome: 'no-op' })
    setBalances({ [SOL]: 0.5, [USDC]: 150 }) // 25/75 → sell $50 USDC → SOL
    setNow(T0 + 60 * 60_000); await scheduler.tick()
    expect(executes(st)).toBe(1)
    const order = st.calls.filter((c) => c.url.pathname.endsWith('/order') && c.url.searchParams.has('taker')).at(-1)!.url.searchParams
    expect(order.get('inputMint')).toBe(USDC)
    expect(order.get('amount')).toBe('50000000') // 50 USDC raw
  })
})

// T-76 end-to-end (P11.5)
describe('tp/sl', () => {
  const tp = (over: Partial<TpSlStrategy> = {}): TpSlStrategy => ({ id: 'tp_1', kind: 'tpsl', createdAt: new Date(T0).toISOString(), status: 'active', nextRunAt: null, consecutiveFailures: 0, totals: totals(), mint: BONK, sellPct: 50, exitMint: SOL, entryPrice: 0.00001, highWater: 0.00001, ...over })
  it('sells sellPct once at take-profit and completes', async () => {
    const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp), prices: { [SOL]: 100, [USDC]: 1, [BONK]: 0.00001 } }
    const { store, scheduler } = setup({ state: st, balances: { [SOL]: 1, [BONK]: 1_000_000 } })
    store.update((s) => { s.strategies.push(tp({ takeProfitPct: 50 })) })
    await scheduler.tick(); expect(executes(st)).toBe(0)
    st.prices = { [SOL]: 100, [USDC]: 1, [BONK]: 0.000016 } // +60%
    await scheduler.tick()
    expect(executes(st)).toBe(1)
    const order = st.calls.filter((c) => c.url.pathname.endsWith('/order') && c.url.searchParams.has('taker')).at(-1)!.url.searchParams
    expect(order.get('inputMint')).toBe(BONK)
    expect(order.get('amount')).toBe('50000000000') // 500,000 BONK × 1e5
    expect(store.load().strategies[0].status).toBe('completed')
    await scheduler.tick(); expect(executes(st)).toBe(1)
  })
  it('skips the check when the price is unavailable and completes with nothing to sell', async () => {
    const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp), prices: { [SOL]: 100 } }
    const { store, scheduler } = setup({ state: st, balances: { [SOL]: 1 } })
    store.update((s) => { s.strategies.push(tp({ stopLossPct: 10 })) })
    await scheduler.tick()
    expect(store.load().runs.at(-1)).toMatchObject({ outcome: 'skipped', message: 'price unavailable' })
    st.prices = { [SOL]: 100, [BONK]: 0.000005 } // −50%, but wallet holds no BONK
    await scheduler.tick()
    expect(executes(st)).toBe(0)
    expect(store.load().strategies[0].status).toBe('completed')
  })
})
