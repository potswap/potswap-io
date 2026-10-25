// PRD P15 — T-118 observation tools through the MCP protocol, and observation-fed limit orders (T-119).
import { describe, expect, it } from 'vitest'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { connect, mockFetch, unsignedTx, SOL, BONK, type MockState } from './helpers.js'
import { loadSigner, loadConfig, NO_WALLET, signObservation, MemoryStore, Scheduler, PotswapApi, type LimitStrategy } from '@potswap_io/sdk'

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const cfgJson = { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false }
const NOW = Date.now()

async function app(opts: { signer?: typeof signer | null; state?: Partial<MockState> } = {}) {
  const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp), observations: [], ...opts.state }
  const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local' })
  const c = await connect({ signer: opts.signer === undefined ? signer : opts.signer, fetchFn: mockFetch(st), balances: async () => ({ [SOL]: 10, [BONK]: 1_000_000 }), config, getSlot: async () => 300_000_000 })
  return { ...c, st }
}

describe('observation tools', () => {
  it('publish signs with the agent wallet and posts; query aggregates; verify and consume work', async () => {
    const { call, st } = await app()
    const r = await call('observe_publish', { kind: 'price', mint: BONK, value: 0.00001, source: 'test-bot' })
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ kind: 'price', mint: BONK, unit: 'usd', slot: 300_000_000, publisher: kp.publicKey.toBase58(), ttlSec: 300, duplicate: false })
    const posted = st.calls.find((c) => c.url.pathname === '/api/observations' && c.init?.method === 'POST')!
    expect((posted.body as { sig: string }).sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/)
    expect(r.text).toMatch(/Published price/)
    // query (the mock echoes what was published, plus two more publishers)
    const others = [Keypair.generate(), Keypair.generate()].map((k, i) => signObservation(loadSigner({ privateKey: bs58.encode(k.secretKey) })!, { kind: 'price', mint: BONK, value: 0.000012 + i * 0.000001, source: 'other', slot: 1, now: NOW }))
    st.observations!.push(...others)
    const q = await call('observe_query', { mint: BONK, kind: 'price' })
    expect(q.isError).toBe(false)
    expect((q.data.aggregate as { publishers: number; median: number }).publishers).toBe(3)
    expect(q.text).toMatch(/3 fresh price observation\(s\) from 3 publisher\(s\)/)
    // verify: valid, and tampered
    const obs = (st.observations as Record<string, unknown>[])[0]
    expect((await call('observe_verify', { observation: obs })).data).toMatchObject({ ok: true, fresh: true })
    expect((await call('observe_verify', { observation: { ...obs, value: 1, id: undefined } })).data).toMatchObject({ ok: false })
    // consume signs a receipt
    const c = await call('observe_consume', { id: others[0].id })
    expect(c.isError).toBe(false)
    const receipt = st.calls.find((x) => x.url.pathname === '/api/observations/consume')!.body as { wallet: string; message: string; signature: string }
    expect(receipt.wallet).toBe(kp.publicKey.toBase58()); expect(JSON.parse(receipt.message)).toMatchObject({ action: 'consume', observationId: others[0].id })
    // no wallet: publish and consume refuse, query works
    const ro = await app({ signer: null })
    expect((await ro.call('observe_publish', { kind: 'price', mint: BONK, value: 1, source: 'x' })).text).toBe(NO_WALLET)
    expect((await ro.call('observe_consume', { id: others[0].id })).text).toBe(NO_WALLET)
    expect((await ro.call('observe_query', {})).isError).toBe(false)
  })
})

describe('observation-fed limit orders (P15.5)', () => {
  it('fills from the observation median only when enough publishers agree; otherwise waits', async () => {
    const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp), observations: [], prices: { [SOL]: 100, [BONK]: 0.00001 } }
    const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local' })
    const api = new PotswapApi(config.apiBase, mockFetch(st))
    const store = new MemoryStore()
    const scheduler = new Scheduler({ store, trade: { api, config, signer, balances: async () => ({ [SOL]: 10, [BONK]: 1_000_000 }) }, maxDailySol: 5, tickMs: 1e9 })
    const s: LimitStrategy = { id: 'lim_obs', kind: 'limit', createdAt: new Date().toISOString(), status: 'active', nextRunAt: null, consecutiveFailures: 0, totals: { runs: 0, volumeUsd: 0, feeUsd: 0, pointsAdded: 0 }, side: 'buy', mint: BONK, quoteMint: SOL, amount: 0.1, triggerPriceUsd: 0.000009, condition: 'below', priceSource: 'observations', minPublishers: 2 }
    store.update((x) => { x.strategies.push(s) })
    const exec = () => st.calls.filter((c) => c.url.pathname.endsWith('/execute')).length
    await scheduler.tick(); expect(exec()).toBe(0) // no observations at all
    const mk = (v: number) => signObservation(loadSigner({ privateKey: bs58.encode(Keypair.generate().secretKey) })!, { kind: 'price', mint: BONK, value: v, source: 'bot', slot: 1, now: Date.now() })
    st.observations!.push(mk(0.000008))
    await scheduler.tick(); expect(exec()).toBe(0) // one publisher < minPublishers, even though Potswap price (0.00001) is above the trigger anyway
    st.observations!.push(mk(0.0000085))
    await scheduler.tick(); expect(exec()).toBe(1) // median 0.00000825 ≤ trigger → fill once
    expect(store.load().strategies[0].status).toBe('completed')
  })
})
