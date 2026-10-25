// PRD P19 — T-129, T-130, T-133, T-134, T-135 through the MCP protocol.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { connect, mockFetch, SOL, USDC, type MockState } from './helpers.js'
import { loadSigner, loadConfig, PROGRAMS, NO_WALLET, type Rpc } from '@potswap_io/sdk'

interface Fixture { poolId: string; accounts: Record<'pool' | 'ammConfig' | 'token0Vault' | 'token1Vault', { data: string }>; decoded: Record<string, string | number> }
const fx = JSON.parse(readFileSync(new URL('../../packages/sdk/test/fixtures/cpmm-pool.json', import.meta.url), 'utf8')) as Fixture
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const accounts: Record<string, Uint8Array> = { [fx.poolId]: bytes(fx.accounts.pool.data), [fx.decoded.ammConfig as string]: bytes(fx.accounts.ammConfig.data), [fx.decoded.token0Vault as string]: bytes(fx.accounts.token0Vault.data), [fx.decoded.token1Vault as string]: bytes(fx.accounts.token1Vault.data) }
const LP_MINT = fx.decoded.lpMint as string

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const FEE_WALLET = Keypair.generate().publicKey.toBase58()
const SIG = '8'.padEnd(88, 'c')
const cfg = (feeWallet: string | null) => ({ referralAccount: 'RefAcct111', feeWallet, referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false })
const TOK = { address: '9BEcn9aPbE4r1sJqxPJD2qbRUF3ihv3Y2gB7nqkMhrCS', symbol: 'jlUSDC', assetAddress: USDC, decimals: 6, supplyRate: '460', rewardsRate: '0', totalAssets: '492219208561', asset: { symbol: 'USDC', decimals: 6, price: '1' } }
const SOLTOK = { address: '2uQsyo1fTFGZYzj5bjuxSbBM5XbxGuGy9sGrEzQpQ7wu', symbol: 'jlWSOL', assetAddress: SOL, decimals: 9, supplyRate: '384', rewardsRate: '0', totalAssets: '213874329869', asset: { symbol: 'SOL', decimals: 9, price: '100' } }

/** A Jupiter-Lend-like legacy tx: fee payer = wallet, one instruction on the Lend program (static). */
function lendTx(payer: PublicKey, program = new PublicKey(PROGRAMS.jupiterLend)) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: [new TransactionInstruction({ programId: program, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) })] }).compileToLegacyMessage()
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64')
}

function fakeRpc(over: { sent?: Uint8Array[]; failNth?: number; confirmErr?: unknown } = {}): Rpc {
  let n = 0
  return {
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 5)), lastValidBlockHeight: 10 }),
    getAccountOwner: async () => null,
    sendRawTransaction: async (raw) => { n++; if (over.failNth === n) throw new Error('blockhash not found'); over.sent?.push(raw); return SIG },
    confirmTransaction: async () => ({ err: over.confirmErr ?? null }),
    getAccountsData: async (addrs) => addrs.map((a) => accounts[a] ?? null),
  }
}

async function app(opts: { feeWallet?: string | null; rpc?: Rpc; state?: Partial<MockState>; env?: Record<string, string>; signer?: typeof signer | null; balances?: Record<string, number> } = {}) {
  const st: MockState = { calls: [], config: cfg(opts.feeWallet === undefined ? FEE_WALLET : opts.feeWallet), lendTokens: [TOK, SOLTOK], lendTx: lendTx(kp.publicKey), lendPositions: [], raydiumPools: [{ id: fx.poolId, programId: PROGRAMS.raydiumCpmm, mintA: SOL, mintB: USDC, tvl: 580, feeRate: 0.003 }], ...opts.state }
  const c = await connect({ signer: opts.signer === undefined ? signer : opts.signer, fetchFn: mockFetch(st), balances: async () => opts.balances ?? { [SOL]: 10, [USDC]: 1000, [LP_MINT]: 0.001 }, config: loadConfig({ POTSWAP_API: 'https://test.potswap.local', ...opts.env }), rpc: opts.rpc ?? fakeRpc() })
  return { ...c, st }
}

// T-129 (P19.1 / P19.4)
describe('lend_markets / lend_positions', () => {
  it('lists markets with APY and positions with underlying', async () => {
    const { call } = await app({ signer: null, state: { lendPositions: [{ token: TOK, shares: '935222', underlyingAssets: '1000000', ownerAddress: 'x' }] } })
    const m = await call('lend_markets')
    expect(m.isError).toBe(false); expect((m.data.markets as { assetSymbol: string; supplyApyPct: number }[])[0]).toMatchObject({ assetSymbol: 'USDC', supplyApyPct: 4.6 }); expect(m.text).toMatch(/USDC +4.60% APY/)
    const p = await call('lend_positions', { wallet: FEE_WALLET })
    expect((p.data.positions as { underlying: number }[])[0].underlying).toBe(1); expect(p.text).toMatch(/USDC: 1 \(\$1.00\)/)
    expect((await call('lend_positions')).text).toBe(NO_WALLET)
  })
})

// T-130 (P19.2 / P19.3)
describe('lend_deposit / lend_withdraw', () => {
  it('plan without confirm; with confirm validates, signs, sends the Jupiter tx and then the fee transfer', async () => {
    const sent: Uint8Array[] = []
    const { call, st } = await app({ rpc: fakeRpc({ sent }) })
    const plan = await call('lend_deposit', { mint: USDC, amount: 10 })
    expect(plan.isError).toBe(false); expect(plan.data.confirmRequired).toBe(true); expect((plan.data.plan as { fee: number }).fee).toBe(0.25); expect(sent).toHaveLength(0)
    const r = await call('lend_deposit', { mint: USDC, amount: 10, confirm: true })
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ action: 'deposit', assetSymbol: 'USDC', amount: 10, signature: SIG, feeSignature: SIG, feeCollected: true, feeBps: 250, pointsAdded: 0.25 })
    expect(sent).toHaveLength(2)
    const posted = st.calls.find((c) => c.url.pathname === '/api/jup/lend/v1/earn/deposit')!
    expect(posted.body).toMatchObject({ asset: USDC, signer: kp.publicKey.toBase58(), amount: '10000000' })
    const depositTx = VersionedTransaction.deserialize(sent[0]); expect(depositTx.signatures[0].some((b) => b !== 0)).toBe(true)
    const feeTx = VersionedTransaction.deserialize(sent[1])
    expect(feeTx.message.compiledInstructions).toHaveLength(2) // ATA + transferChecked to the fee wallet
    // fee transfer fails → deposit stands, feeCollected false, explained
    const flaky = await app({ rpc: fakeRpc({ failNth: 2 }) })
    const r2 = await flaky.call('lend_deposit', { mint: USDC, amount: 10, confirm: true })
    expect(r2.isError).toBe(false); expect(r2.data).toMatchObject({ feeCollected: false, pointsAdded: 0 }); expect(String(r2.data.feeNote)).toMatch(/fee transfer could not be sent/)
    // no fee wallet → no fee, plan says so
    const noFee = await app({ feeWallet: null })
    const r3 = await noFee.call('lend_deposit', { mint: USDC, amount: 10, confirm: true })
    expect(r3.data).toMatchObject({ feeBps: 0, feeCollected: false }); expect(String(r3.data.feeNote)).toMatch(/No fee wallet/)
  })
  it('refusals: no wallet, unknown market, allowlist, cap, foreign program in the Jupiter tx; withdraw all needs a position and is free', async () => {
    const nw = await app({ signer: null }); expect((await nw.call('lend_deposit', { mint: USDC, amount: 1, confirm: true })).text).toBe(NO_WALLET)
    const { call } = await app()
    expect((await call('lend_deposit', { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', amount: 1, confirm: true })).text).toMatch(/No Jupiter Lend Earn market.*No funds were debited/)
    const al = await app({ env: { POTSWAP_ALLOWED_TOKENS: SOL } }); expect((await al.call('lend_deposit', { mint: USDC, amount: 1, confirm: true })).text).toMatch(/POTSWAP_ALLOWED_TOKENS/)
    expect((await call('lend_deposit', { mint: SOL, amount: 5, confirm: true })).text).toMatch(/POTSWAP_MAX_TRADE_SOL.*No funds were debited/)
    const foreign = await app({ state: { lendTx: lendTx(kp.publicKey, Keypair.generate().publicKey) } })
    expect((await foreign.call('lend_deposit', { mint: USDC, amount: 1, confirm: true })).text).toMatch(/transaction validator.*not allow-listed.*No funds were debited/)
    expect((await call('lend_withdraw', { mint: USDC, confirm: true })).text).toMatch(/Give amount or all/)
    expect((await call('lend_withdraw', { mint: USDC, all: true, confirm: true })).text).toMatch(/No USDC Earn position.*No funds were debited/)
    const withPos = await app({ state: { lendPositions: [{ token: TOK, shares: '935222', underlyingAssets: '2500000', ownerAddress: kp.publicKey.toBase58() }] } })
    const w = await withPos.call('lend_withdraw', { mint: USDC, all: true, confirm: true })
    expect(w.isError).toBe(false); expect(w.data).toMatchObject({ action: 'withdraw', amount: 2.5, feeBps: 0, feeCollected: false }); expect(withPos.st.calls.find((c) => c.url.pathname === '/api/jup/lend/v1/earn/withdraw')!.body).toMatchObject({ amount: '2500000' })
    const dry = await app({ env: { POTSWAP_DRY_RUN: 'true' } }); expect((await dry.call('lend_deposit', { mint: USDC, amount: 1, confirm: true })).data.dryRun).toBe(true)
  })
})

// T-133, T-134 (P19.5–P19.8)
describe('lp_pools / lp_position / lp_deposit / lp_withdraw', () => {
  it('pools with live reserves; position from LP balance', async () => {
    const { call } = await app()
    const pools = await call('lp_pools', { mintA: SOL, mintB: USDC })
    expect(pools.isError).toBe(false)
    const p = (pools.data.pools as Record<string, unknown>[])[0]
    expect(p).toMatchObject({ poolId: fx.poolId, token0Mint: SOL, token1Mint: USDC, tradeFeeBps: 30, swapEnabled: true }); expect(p.reserve0 as number).toBeCloseTo(2.839626413, 6)
    const pos = await call('lp_position', { poolId: fx.poolId })
    expect(pos.isError).toBe(false); expect(pos.data.lpBalance).toBe(0.001); expect(pos.data.sharePct as number).toBeCloseTo(10.1858, 3)
    expect((await call('lp_position', { poolId: 'Missing1111111111111111111111111111111111111' })).isError).toBe(true)
  })
  it('deposit: plan, then fee + wrap + deposit in one validated transaction; withdraw by pct, free', async () => {
    const sent: Uint8Array[] = []
    const { call } = await app({ rpc: fakeRpc({ sent }) })
    const plan = await call('lp_deposit', { poolId: fx.poolId, mint: SOL, amount: 0.01 })
    expect(plan.data.confirmRequired).toBe(true); expect((plan.data.plan as { fee: number; amount0: number }).fee).toBe(0.00025); expect((plan.data.plan as { amount0: number }).amount0).toBe(0.00975)
    const r = await call('lp_deposit', { poolId: fx.poolId, mint: SOL, amount: 0.01, confirm: true })
    expect(r.isError).toBe(false); expect(r.data).toMatchObject({ signature: SIG, feeBps: 250, pointsAdded: 0.025 })
    expect(sent).toHaveLength(1)
    const tx = VersionedTransaction.deserialize(sent[0])
    const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58())
    expect(programs).toContain(PROGRAMS.raydiumCpmm); expect(programs.filter((x) => x === PROGRAMS.system)).toHaveLength(1)
    const w = await call('lp_withdraw', { poolId: fx.poolId, pct: 50, confirm: true })
    expect(w.isError).toBe(false); expect(w.data).toMatchObject({ fee: 0, lpTokens: 0.0005, signature: SIG }); expect(sent).toHaveLength(2)
    expect((await call('lp_withdraw', { poolId: fx.poolId, lpAmount: 5, confirm: true })).text).toMatch(/Insufficient LP tokens.*No funds were debited/)
    expect((await call('lp_withdraw', { poolId: fx.poolId, confirm: true })).text).toMatch(/Give lpAmount or pct/)
    expect((await call('lp_deposit', { poolId: fx.poolId, mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', amount: 1, confirm: true })).text).toMatch(/one of the pool tokens.*No funds were debited/)
    const poor = await app({ balances: { [SOL]: 10, [USDC]: 0.001 } })
    expect((await poor.call('lp_deposit', { poolId: fx.poolId, mint: SOL, amount: 0.01, confirm: true })).text).toMatch(/Insufficient EPjF.*No funds were debited/)
    const nw = await app({ signer: null }); expect((await nw.call('lp_deposit', { poolId: fx.poolId, mint: SOL, amount: 0.01, confirm: true })).text).toBe(NO_WALLET)
    const failed = await app({ rpc: fakeRpc({ confirmErr: { Custom: 1 } }) })
    expect((await failed.call('lp_deposit', { poolId: fx.poolId, mint: SOL, amount: 0.01, confirm: true })).text).toMatch(/failed on-chain.*No funds were debited/)
  })
})
