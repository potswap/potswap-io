// PRD P14 — T-122 opId idempotency, T-125 get_quote.direct, T-126 direct swap through the MCP.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { connect, mockFetch, unsignedTx, SOL, USDC, type MockState } from './helpers.js'
import { loadSigner, loadConfig, MemoryOpsStore, PROGRAMS, type Rpc } from '@potswap_io/sdk'

interface Fixture { poolId: string; accounts: Record<'pool' | 'ammConfig' | 'token0Vault' | 'token1Vault', { data: string }>; decoded: Record<string, string | number> }
const fx = JSON.parse(readFileSync(new URL('../../packages/sdk/test/fixtures/cpmm-pool.json', import.meta.url), 'utf8')) as Fixture
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const accounts: Record<string, Uint8Array> = { [fx.poolId]: bytes(fx.accounts.pool.data), [fx.decoded.ammConfig as string]: bytes(fx.accounts.ammConfig.data), [fx.decoded.token0Vault as string]: bytes(fx.accounts.token0Vault.data), [fx.decoded.token1Vault as string]: bytes(fx.accounts.token1Vault.data) }

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const FEE_WALLET = Keypair.generate().publicKey.toBase58()
const SIG = '7'.padEnd(88, 'b')
const cfg = (feeWallet: string | null) => ({ referralAccount: 'RefAcct111', feeWallet, referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false })
const POOLS = [{ id: fx.poolId, programId: PROGRAMS.raydiumCpmm, mintA: SOL, mintB: USDC, tvl: 580, feeRate: 0.003 }]

function fakeRpc(over: { confirmErr?: unknown; confirmThrows?: boolean; sent?: Uint8Array[] } = {}): Rpc {
  return {
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 3)), lastValidBlockHeight: 10 }),
    getAccountOwner: async () => null,
    sendRawTransaction: async (raw) => { over.sent?.push(raw); return SIG },
    confirmTransaction: async () => { if (over.confirmThrows) throw new Error('rpc timeout'); return { err: over.confirmErr ?? null } },
    getAccountsData: async (addrs) => addrs.map((a) => accounts[a] ?? null),
  }
}

async function app(opts: { feeWallet?: string | null; rpc?: Rpc; state?: Partial<MockState>; ops?: MemoryOpsStore; executeThrows?: boolean } = {}) {
  const st: MockState = { calls: [], config: cfg(opts.feeWallet === undefined ? FEE_WALLET : opts.feeWallet), orderTx: unsignedTx(kp), raydiumPools: POOLS, ...opts.state }
  const base = mockFetch(st)
  const fetchFn = opts.executeThrows ? ((async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input).endsWith('/execute')) throw new Error('socket hang up'); return base(input, init) }) as typeof fetch) : base
  const ops = opts.ops ?? new MemoryOpsStore()
  const c = await connect({ signer, fetchFn, balances: async () => ({ [SOL]: 10, [USDC]: 1000 }), config: loadConfig({ POTSWAP_API: 'https://test.potswap.local' }), rpc: opts.rpc ?? fakeRpc(), ops })
  return { ...c, st, ops }
}
const executes = (st: MockState) => st.calls.filter((c) => c.url.pathname.endsWith('/execute')).length

// T-125 (P14.7)
describe('get_quote.direct', () => {
  it('includes the CPMM pool net of the Potswap fee; null without a pool; Raydium failure tolerated', async () => {
    const { call } = await app()
    const q = await call('get_quote', { inputMint: SOL, outputMint: USDC, amount: 0.01 })
    expect(q.isError).toBe(false)
    const d = q.data.direct as { poolId: string; router: string; outAmount: number; poolTradeFeeBps: number; savedVsAggregatorPct: number }
    expect(d).toMatchObject({ poolId: fx.poolId, router: 'raydium-cpmm', poolTradeFeeBps: 30 })
    expect(d.outAmount).toBeGreaterThan(0); expect(typeof d.savedVsAggregatorPct).toBe('number')
    expect(q.text).toMatch(/Direct Raydium CPMM/)
    const none = await app({ state: { raydiumPools: [] } })
    expect((await none.call('get_quote', { inputMint: SOL, outputMint: USDC, amount: 0.01 })).data.direct).toBeNull()
    const broken = await app({ rpc: { ...fakeRpc(), getAccountsData: async () => { throw new Error('rpc down') } } })
    const r = await broken.call('get_quote', { inputMint: SOL, outputMint: USDC, amount: 0.01 })
    expect(r.isError).toBe(false); expect(r.data.direct).toBeNull(); expect(r.data.outAmount).toBe(1.043637)
  })
})

// T-126 (P14.8)
describe('swap route=direct', () => {
  it('builds fee + swap locally, validates, signs with the wallet and sends via RPC; auto picks the better route', async () => {
    const sent: Uint8Array[] = []
    const { call, st } = await app({ rpc: fakeRpc({ sent }) })
    const r = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.01, route: 'direct', confirm: true })
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ router: 'raydium-cpmm', signature: SIG, feeBps: 250, inputSymbol: 'SOL', outputSymbol: 'USDC' })
    expect(executes(st)).toBe(0) // never went through Jupiter
    expect(sent).toHaveLength(1)
    const tx = VersionedTransaction.deserialize(sent[0])
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(kp.publicKey.toBase58())
    expect(tx.signatures[0].some((b) => b !== 0)).toBe(true)
    const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58())
    expect(programs).toContain(PROGRAMS.raydiumCpmm); expect(programs.filter((p) => p === PROGRAMS.token).length).toBeGreaterThanOrEqual(3) // sync, fee transfer, close
    // auto: the aggregator mock pays 104.36 USDC per SOL, the tiny pool far less → auto takes Jupiter
    const auto = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.01, route: 'auto', confirm: true })
    expect(auto.data.router).toBe('metis'); expect(executes(st)).toBe(1)
  })
  it('refuses without a fee wallet or pool, reports on-chain failure and unknown confirmation; every message says whether funds were debited', async () => {
    const noFee = await app({ feeWallet: null })
    const r1 = await noFee.call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.01, route: 'direct', confirm: true })
    expect(r1.isError).toBe(true); expect(r1.text).toMatch(/not enabled yet.*No funds were debited/)
    const noPool = await app({ state: { raydiumPools: [] } })
    expect((await noPool.call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.01, route: 'direct', confirm: true })).text).toMatch(/No direct Raydium CPMM pool.*No funds were debited/)
    const failed = await app({ rpc: fakeRpc({ confirmErr: { InstructionError: [5, 'Custom'] } }) })
    const r3 = await failed.call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.01, route: 'direct', confirm: true })
    expect(r3.isError).toBe(true); expect(r3.text).toMatch(/failed on-chain.*No funds were debited/); expect(r3.data.signature).toBe(SIG)
    const unknown = await app({ rpc: fakeRpc({ confirmThrows: true }) })
    const r4 = await unknown.call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.01, route: 'direct', confirm: true, opId: 'op-unknown' })
    expect(r4.isError).toBe(true); expect(r4.text).toMatch(/funds may have been debited/)
    expect((await unknown.call('get_operation', { id: 'op-unknown' })).data).toMatchObject({ state: 'unknown', signature: SIG })
    // quote-only still shows the direct quote
    const q = await app()
    expect((await q.call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.01, route: 'direct' })).data.confirmRequired).toBe(true)
  })
})

// T-122 (P14.3 / P14.4)
describe('opId idempotency', () => {
  it('replays a completed operation without re-sending; blocks retries of sent/unknown; allows retry after failed', async () => {
    const ops = new MemoryOpsStore()
    const { call, st } = await app({ ops })
    const first = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true, opId: 'op-1' })
    expect(first.isError).toBe(false); expect(first.data.opId).toBe('op-1'); expect(executes(st)).toBe(1)
    const again = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true, opId: 'op-1' })
    expect(again.isError).toBe(false); expect(again.data.replayed).toBe(true); expect(executes(st)).toBe(1)
    expect(again.text).toMatch(/Already done \(replayed\)/)
    expect((await call('get_operation', { id: 'op-1' })).data).toMatchObject({ state: 'ok', signature: expect.any(String) })
    const list = await call('get_operation', {})
    expect((list.data.operations as unknown[]).length).toBe(1)
    // execute throws → unknown → blocked
    const flaky = await app({ ops, executeThrows: true })
    const r = await flaky.call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true, opId: 'op-2' })
    expect(r.isError).toBe(true); expect(r.text).toMatch(/may have been sent.*Funds may have been debited/)
    expect(ops.get('op-2')!.state).toBe('unknown')
    const blocked = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true, opId: 'op-2' })
    expect(blocked.isError).toBe(true); expect(blocked.text).toMatch(/already sent.*new opId.*Funds may have been debited/)
    // failed → retry allowed
    const failing = await app({ ops, state: { executeResult: { status: 'Failed', signature: SIG, code: 1, error: 'slippage' } } })
    expect((await failing.call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true, opId: 'op-3' })).isError).toBe(true)
    expect(ops.get('op-3')!.state).toBe('failed')
    const retry = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true, opId: 'op-3' })
    expect(retry.isError).toBe(false); expect(ops.get('op-3')!.state).toBe('ok')
    expect((await call('get_operation', { id: 'nope-1' })).isError).toBe(true)
  })
})
