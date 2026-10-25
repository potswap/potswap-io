import { describe, expect, it } from 'vitest'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { connect, mockFetch, unsignedTx, SOL, USDC, BONK, type MockState } from '../helpers.js'
import { loadSigner } from '@potswap_io/sdk'
import { loadConfig } from '@potswap_io/sdk'
import { MemoryStore } from '@potswap_io/sdk'
import { Scheduler } from '@potswap_io/sdk'
import { PotswapApi } from '@potswap_io/sdk'
import { NO_WALLET } from '@potswap_io/sdk'

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const cfgJson = { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false }

async function app(opts: { signer?: typeof signer | null; withScheduler?: boolean } = {}) {
  const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp) }
  const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local' })
  const fetchFn = mockFetch(st)
  const balances = async () => ({ [SOL]: 10, [USDC]: 1000, [BONK]: 1_000_000 })
  const store = new MemoryStore()
  const s = opts.signer === undefined ? signer : opts.signer
  const scheduler = opts.withScheduler === false ? undefined : new Scheduler({ store, trade: { api: new PotswapApi(config.apiBase, fetchFn), config, signer: s, balances }, maxDailySol: 5, tickMs: 1e9 })
  const c = await connect({ signer: s, fetchFn, balances, config, strategyStore: store, scheduler })
  return { ...c, st, store }
}
const executes = (st: MockState) => st.calls.filter((c) => c.url.pathname.endsWith('/execute')).length

// T-73, T-79, T-80 through the MCP protocol
describe('strategy tools', () => {
  it('lists all seven tools', async () => {
    const { client } = await app()
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const n of ['dca_create', 'rebalance_create', 'tpsl_create', 'limit_order_create', 'strategy_list', 'strategy_pause', 'strategy_resume', 'strategy_delete', 'strategy_runs']) expect(names).toContain(n)
  })
  it('dca_create requires confirm and a wallet; with both it runs the first leg immediately', async () => {
    const noWallet = await app({ signer: null })
    const r0 = await noWallet.call('dca_create', { inputMint: SOL, outputMint: USDC, amountPerRun: 0.1, intervalMinutes: 60, confirm: true })
    expect(r0.isError).toBe(true); expect(r0.text).toBe(NO_WALLET)
    const { call, st, store } = await app()
    const r1 = await call('dca_create', { inputMint: SOL, outputMint: USDC, amountPerRun: 0.1, intervalMinutes: 60 })
    expect(r1.isError).toBe(true); expect(r1.text).toMatch(/confirm=true/)
    expect(store.load().strategies).toHaveLength(0)
    const r2 = await call('dca_create', { inputMint: SOL, outputMint: USDC, amountPerRun: 0.1, intervalMinutes: 60, totalRuns: 10, confirm: true })
    expect(r2.isError).toBe(false)
    expect(executes(st)).toBe(1)
    const strategy = r2.data.strategy as { id: string; status: string; runsDone: number }
    expect(strategy).toMatchObject({ status: 'active', runsDone: 1 })
    expect(r2.data.schedulerActive).toBe(false) // scheduler exists but was not started in this test
    const runs = await call('strategy_runs', { id: strategy.id })
    expect((runs.data.runs as unknown[]).length).toBe(1)
  })
  it('pause / resume / delete', async () => {
    const { call, store } = await app()
    const r = await call('dca_create', { inputMint: SOL, outputMint: USDC, amountPerRun: 0.1, intervalMinutes: 60, confirm: true })
    const id = (r.data.strategy as { id: string }).id
    expect((await call('strategy_pause', { id })).data).toMatchObject({ strategy: { status: 'paused', nextRunAt: null } })
    const resumed = await call('strategy_resume', { id })
    expect((resumed.data.strategy as { status: string; nextRunAt: string }).status).toBe('active')
    expect((resumed.data.strategy as { nextRunAt: string }).nextRunAt).not.toBeNull()
    expect((await call('strategy_delete', { id })).data.deleted).toBe(id)
    expect(store.load().strategies).toHaveLength(0)
    expect(store.load().runs.length).toBeGreaterThan(0) // history kept
    expect((await call('strategy_delete', { id })).isError).toBe(true)
  })
  it('validates rebalance targets and tp/sl triggers', async () => {
    const { call } = await app()
    expect((await call('rebalance_create', { targets: { [SOL]: 60, [USDC]: 30 }, confirm: true })).text).toMatch(/sum to 100/)
    expect((await call('rebalance_create', { targets: { [USDC]: 50, [BONK]: 50 }, confirm: true })).text).toMatch(/include SOL/)
    const ok = await call('rebalance_create', { targets: { [SOL]: 50, [USDC]: 50 }, confirm: true })
    expect(ok.isError).toBe(false)
    expect((await call('tpsl_create', { mint: BONK, confirm: true })).text).toMatch(/at least one of/)
    const tp = await call('tpsl_create', { mint: BONK, takeProfitPct: 50, confirm: true })
    expect((tp.data.strategy as { entryPrice: number }).entryPrice).toBe(0.00001)
    const list = await call('strategy_list')
    expect((list.data.strategies as unknown[]).length).toBe(2)
  })
})
