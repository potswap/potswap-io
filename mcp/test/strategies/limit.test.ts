// PRD P13.11 — limit orders as price-triggered strategies (T-103; P13.10).
import { describe, expect, it } from 'vitest'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { PotswapApi } from '@potswap_io/sdk'
import { loadConfig } from '@potswap_io/sdk'
import { loadSigner } from '@potswap_io/sdk'
import { Scheduler } from '@potswap_io/sdk'
import { MemoryStore } from '@potswap_io/sdk'
import { limitDecision, limitLegFor } from '@potswap_io/sdk'
import type { LimitStrategy } from '@potswap_io/sdk'
import { connect, mockFetch, unsignedTx, SOL, USDC, BONK, type MockState } from '../helpers.js'

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const T0 = Date.parse('2026-11-01T12:00:00Z')
const cfgJson = { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false }
const limit = (over: Partial<LimitStrategy> = {}): LimitStrategy => ({ id: 'lim_1', kind: 'limit', createdAt: new Date(T0).toISOString(), status: 'active', nextRunAt: null, consecutiveFailures: 0, totals: { runs: 0, volumeUsd: 0, feeUsd: 0, pointsAdded: 0 }, side: 'buy', mint: BONK, quoteMint: SOL, amount: 0.1, triggerPriceUsd: 0.00002, condition: 'below', ...over })

function setup(prices?: Record<string, number>) {
  const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp), prices }
  const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local' })
  const api = new PotswapApi(config.apiBase, mockFetch(st))
  const store = new MemoryStore()
  let now = T0
  const scheduler = new Scheduler({ store, trade: { api, config, signer, balances: async () => ({ [SOL]: 10, [USDC]: 1000, [BONK]: 1_000_000 }) }, maxDailySol: 5, now: () => now, tickMs: 1e9 })
  return { st, store, scheduler, setNow: (t: number) => { now = t } }
}
const executes = (st: MockState) => st.calls.filter((c) => c.url.pathname.endsWith('/execute')).length

describe('limit engine', () => {
  it('decides fill / expired / wait', () => {
    expect(limitDecision(limit(), 0.00001, T0)).toBe('fill')
    expect(limitDecision(limit(), 0.00003, T0)).toBeNull()
    expect(limitDecision(limit({ condition: 'above', triggerPriceUsd: 0.00003 }), 0.00003, T0)).toBe('fill')
    expect(limitDecision(limit(), undefined, T0)).toBeNull()
    expect(limitDecision(limit({ expiresAt: new Date(T0 - 1).toISOString() }), 0.00001, T0)).toBe('expired')
    expect(limitLegFor(limit())).toMatchObject({ inputMint: SOL, outputMint: BONK, amount: 0.1 })
    expect(limitLegFor(limit({ side: 'sell', amount: 500 }))).toMatchObject({ inputMint: BONK, outputMint: SOL, amount: 500 })
  })
})

describe('limit scheduler', () => {
  it('waits while the price is on the wrong side, fills once when it crosses, then completes', async () => {
    const { st, store, scheduler } = setup({ [SOL]: 100, [USDC]: 1, [BONK]: 0.00003 })
    store.update((s) => { s.strategies.push(limit()) })
    await scheduler.tick()
    expect(executes(st)).toBe(0)
    expect(store.load().strategies[0].status).toBe('active')
    st.prices = { [SOL]: 100, [USDC]: 1, [BONK]: 0.00001 }
    await scheduler.tick()
    expect(executes(st)).toBe(1)
    const order = st.calls.find((c) => c.url.pathname.endsWith('/order') && c.url.searchParams.has('taker'))!.url.searchParams
    expect(order.get('inputMint')).toBe(SOL); expect(order.get('outputMint')).toBe(BONK); expect(order.get('referralFee')).toBe('250')
    expect(store.load().strategies[0].status).toBe('completed')
    expect(store.load().runs.at(-1)).toMatchObject({ outcome: 'ok', action: expect.stringContaining('limit buy') })
    await scheduler.tick()
    expect(executes(st)).toBe(1) // never fills twice
  })
  it('sell side fills when price rises above the trigger', async () => {
    const { st, store, scheduler } = setup({ [SOL]: 100, [USDC]: 1, [BONK]: 0.00005 })
    store.update((s) => { s.strategies.push(limit({ side: 'sell', amount: 100_000, condition: 'above', triggerPriceUsd: 0.00004 })) })
    await scheduler.tick()
    expect(executes(st)).toBe(1)
    const order = st.calls.find((c) => c.url.pathname.endsWith('/order') && c.url.searchParams.has('taker'))!.url.searchParams
    expect(order.get('inputMint')).toBe(BONK); expect(order.get('outputMint')).toBe(SOL)
  })
  it('expires unfilled and records it', async () => {
    const { st, store, scheduler, setNow } = setup({ [SOL]: 100, [USDC]: 1, [BONK]: 0.00003 })
    store.update((s) => { s.strategies.push(limit({ expiresAt: new Date(T0 + 60_000).toISOString() })) })
    setNow(T0 + 120_000)
    await scheduler.tick()
    expect(executes(st)).toBe(0)
    expect(store.load().strategies[0].status).toBe('completed')
    expect(store.load().runs.at(-1)).toMatchObject({ outcome: 'completed', message: 'Expired unfilled.' })
  })
})

describe('limit_order_create tool', () => {
  it('requires confirm, rejects mint == quoteMint, stores the strategy with nextRunAt null', async () => {
    const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp) }
    const store = new MemoryStore()
    const { call } = await connect({ signer, fetchFn: mockFetch(st), balances: async () => ({ [SOL]: 10 }), strategyStore: store })
    expect((await call('limit_order_create', { side: 'buy', mint: BONK, amount: 0.1, triggerPriceUsd: 0.00002, condition: 'below' })).text).toMatch(/confirm=true/)
    expect((await call('limit_order_create', { side: 'buy', mint: SOL, quoteMint: SOL, amount: 0.1, triggerPriceUsd: 1, condition: 'below', confirm: true })).isError).toBe(true)
    const r = await call('limit_order_create', { side: 'buy', mint: BONK, amount: 0.1, triggerPriceUsd: 0.00002, condition: 'below', expiresAt: '2026-12-01T00:00:00Z', confirm: true })
    expect(r.isError).toBe(false)
    const s = store.load().strategies[0] as LimitStrategy
    expect(s).toMatchObject({ kind: 'limit', side: 'buy', mint: BONK, quoteMint: SOL, amount: 0.1, triggerPriceUsd: 0.00002, condition: 'below', status: 'active', nextRunAt: null })
    expect(executes(st)).toBe(0) // nothing fills at creation
  })
})
