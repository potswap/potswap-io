import { describe, expect, it } from 'vitest'
import { connect, mockFetch, SOL, USDC, BONK, type MockState } from './helpers.js'

// T-60 (PRD P10.3)
describe('get_quote', () => {
  it('adds referral params from /api/config and converts UI amounts to raw units', async () => {
    const st: MockState = { calls: [], config: { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: '2026-11-01T00:00:00Z', pointsEnabled: true } }
    const { call } = await connect({ signer: null, fetchFn: mockFetch(st) })
    const r = await call('get_quote', { inputMint: SOL, outputMint: USDC, amount: 1.5, slippageBps: 50 })
    const order = st.calls.find((c) => c.url.pathname.endsWith('/order'))!.url.searchParams
    expect(order.get('amount')).toBe('1500000000')
    expect(order.get('referralAccount')).toBe('RefAcct111')
    expect(order.get('referralFee')).toBe('250') // $150 input → standard tier
    expect(order.get('slippageBps')).toBe('50')
    expect(order.has('taker')).toBe(false)
    expect(r.data).toMatchObject({ inputSymbol: 'SOL', outputSymbol: 'USDC', inAmountRaw: '1500000000', feeBps: 50, router: 'metis' })
    expect(r.data.outAmount).toBeCloseTo(156.54555, 3)
    expect(r.data.price).toBeCloseTo(104.3637, 3)
  })
  it('omits referral params when the fee is not configured', async () => {
    const st: MockState = { calls: [], config: { referralAccount: null, referralFeeBps: 0, seasonStart: null, pointsEnabled: false } }
    const { call } = await connect({ signer: null, fetchFn: mockFetch(st) })
    await call('get_quote', { inputMint: SOL, outputMint: BONK, amount: 0.2 })
    const order = st.calls.find((c) => c.url.pathname.endsWith('/order'))!.url.searchParams
    expect(order.has('referralAccount')).toBe(false)
  })
  it('uses the output token decimals (BONK has 5)', async () => {
    const st: MockState = { calls: [], config: {} }
    const { call } = await connect({ signer: null, fetchFn: mockFetch(st) })
    const r = await call('get_quote', { inputMint: SOL, outputMint: BONK, amount: 1 })
    expect(r.data.outAmount).toBe(10_000_000)
  })
  it('rejects invalid mints at the schema level', async () => {
    const { call } = await connect({ signer: null, fetchFn: mockFetch({ calls: [], config: {} }) })
    const r = await call('get_quote', { inputMint: 'nope', outputMint: USDC, amount: 1 })
    expect(r.isError).toBe(true)
  })
})

// T-70 (PRD P8.14): the MCP applies the same schedule as the web app
describe('fee schedule parity', () => {
  const cfg = { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false }
  it.each([
    [1, 250, 'standard', '2.5%'],      // 1 SOL = $100
    [9.99, 250, 'standard', '2.5%'],
    [10, 100, 'size', '1% (size tier)'], // $1,000
    [25, 100, 'size', '1% (size tier)'],
  ])('%s SOL → referralFee=%s (%s)', async (amount, bps, tier, label) => {
    const st: MockState = { calls: [], config: cfg }
    const { call } = await connect({ signer: null, fetchFn: mockFetch(st) })
    const r = await call('get_quote', { inputMint: SOL, outputMint: USDC, amount })
    const order = st.calls.find((c) => c.url.pathname.endsWith('/order'))!.url.searchParams
    expect(order.get('referralFee')).toBe(String(bps))
    expect(r.data.feeTier).toBe(tier)
    expect(r.data.feeLabel).toBe(label)
  })
  it('uses the standard tier when the input has no price', async () => {
    const st: MockState = { calls: [], config: cfg, prices: { [USDC]: 1 } } // no SOL price
    const { call } = await connect({ signer: null, fetchFn: mockFetch(st) })
    await call('get_quote', { inputMint: SOL, outputMint: USDC, amount: 50 })
    expect(st.calls.find((c) => c.url.pathname.endsWith('/order'))!.url.searchParams.get('referralFee')).toBe('250')
  })
})
