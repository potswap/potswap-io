import { describe, expect, it } from 'vitest'
import { connect, mockFetch, SOL, USDC, BONK, type MockState } from './helpers.js'
import { NO_WALLET } from '@potswap_io/sdk'

const state = (): MockState => ({ calls: [], config: { referralAccount: null, referralFeeBps: 0, seasonStart: null, pointsEnabled: false } })

// T-58 (PRD P10.1)
describe('server without a wallet', () => {
  it('lists the nine core tools plus the eight strategy tools', async () => {
    const { client } = await connect({ signer: null, fetchFn: mockFetch(state()) })
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    for (const n of ['get_balances', 'get_leaderboard', 'get_points', 'get_positions', 'get_quote', 'get_token', 'get_trending', 'search_tokens', 'swap']) expect(names).toContain(n)
    expect(names).toHaveLength(40)
  })
  it('read-only tools work', async () => {
    const { call } = await connect({ signer: null, fetchFn: mockFetch(state()) })
    const s = await call('search_tokens', { query: 'bonk' })
    expect(s.isError).toBe(false)
    expect((s.data.tokens as { symbol: string }[])[0].symbol).toBe('Bonk')
    const t = await call('get_token', { mint: BONK })
    expect(t.data.riskLevel).toBe(1) // top holders 30.3% > 30 → one warn
    const tr = await call('get_trending', { kind: 'new' })
    expect((tr.data.tokens as unknown[]).length).toBe(1)
    const q = await call('get_quote', { inputMint: SOL, outputMint: USDC, amount: 1 })
    expect(q.data.outAmount).toBeCloseTo(104.3637)
    expect(q.data.router).toBe('metis')
  })
  it('wallet tools return the no-wallet error and never call the API', async () => {
    const st = state()
    const { call } = await connect({ signer: null, fetchFn: mockFetch(st) })
    for (const name of ['swap', 'get_balances', 'get_positions', 'get_points']) {
      const r = await call(name, name === 'swap' ? { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true } : {})
      expect(r.isError).toBe(true)
      expect(r.text).toBe(NO_WALLET)
    }
    expect(st.calls.filter((c) => c.url.pathname.includes('/execute'))).toHaveLength(0)
  })
  it('reports the points engine as disabled on 503 instead of erroring', async () => {
    const st = state(); st.status = { points: 503 }
    const { call } = await connect({ signer: null, fetchFn: mockFetch(st) })
    const r = await call('get_points', { wallet: BONK })
    expect(r.isError).toBe(false)
    expect(r.data.enabled).toBe(false)
  })
  it('retries once on 429 then reports busy', async () => {
    const st = state(); st.status = { order: 429 }
    const { call } = await connect({ signer: null, fetchFn: mockFetch(st) })
    const r = await call('get_quote', { inputMint: SOL, outputMint: USDC, amount: 1 })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/busy.*No funds were debited/)
    expect(st.calls.filter((c) => c.url.pathname.endsWith('/order'))).toHaveLength(2)
  }, 10_000)
})
