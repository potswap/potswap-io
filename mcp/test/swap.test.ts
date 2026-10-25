import { describe, expect, it } from 'vitest'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { connect, mockFetch, unsignedTx, SOL, USDC, type MockState } from './helpers.js'
import { loadSigner } from '@potswap_io/sdk'
import { loadConfig } from '@potswap_io/sdk'

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const balances = async () => ({ [SOL]: 5, [USDC]: 250 })
const base = (): MockState => ({ calls: [], config: { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false }, orderTx: unsignedTx(kp) })
const executed = (st: MockState) => st.calls.filter((c) => c.url.pathname.endsWith('/execute'))
const takerOrders = (st: MockState) => st.calls.filter((c) => c.url.pathname.endsWith('/order') && c.url.searchParams.has('taker'))

describe('swap', () => {
  // T-61 (PRD P10.4/P10.8)
  it('without confirm returns the quote and signs nothing', async () => {
    const st = base()
    const { call } = await connect({ signer, fetchFn: mockFetch(st), balances })
    const r = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.5 })
    expect(r.isError).toBe(false)
    expect(r.data.confirmRequired).toBe(true)
    expect(takerOrders(st)).toHaveLength(0)
    expect(executed(st)).toHaveLength(0)
  })
  it('in dry-run mode never signs even with confirm', async () => {
    const st = base()
    const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local', POTSWAP_DRY_RUN: 'true' })
    const { call } = await connect({ signer, fetchFn: mockFetch(st), balances, config })
    const r = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.5, confirm: true })
    expect(r.data.dryRun).toBe(true)
    expect(takerOrders(st)).toHaveLength(0)
    expect(executed(st)).toHaveLength(0)
  })

  // T-62 (PRD P10.5)
  it('with confirm: fresh order as taker → local signature → execute', async () => {
    const st = base()
    const { call } = await connect({ signer, fetchFn: mockFetch(st), balances })
    const r = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.5, confirm: true })
    expect(r.isError).toBe(false)
    const order = takerOrders(st)[0].url.searchParams
    expect(order.get('taker')).toBe(kp.publicKey.toBase58())
    expect(order.get('referralAccount')).toBe('RefAcct111')
    const exec = executed(st)[0].body as { signedTransaction: string; requestId: string }
    expect(exec.requestId).toBe('req-1')
    const tx = VersionedTransaction.deserialize(Buffer.from(exec.signedTransaction, 'base64'))
    expect(tx.signatures[0].some((b) => b !== 0)).toBe(true) // actually signed
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(kp.publicKey.toBase58())
    expect(r.data).toMatchObject({ inputSymbol: 'SOL', outputSymbol: 'USDC', outAmount: 104.3637, router: 'metis', feeBps: 50 })
    expect(r.data.feeUsd).toBeCloseTo(0.25) // feeBps comes from the mocked order (50)
    expect(r.data.pointsAdded).toBeCloseTo(0.25)
    expect(takerOrders(st)[0].url.searchParams.get('referralFee')).toBe('250') // $50 input → standard tier
    expect(String(r.data.explorerUrl)).toMatch(/^https:\/\/solscan\.io\/tx\//)
  })

  // T-64 (PRD P10.7)
  it('maps execute failures to friendly copy and passes the signature through', async () => {
    const st = base(); st.executeResult = { status: 'Failed', code: -1005, error: 'Transaction expired before landing', signature: 'expiredsig' }
    const { call } = await connect({ signer, fetchFn: mockFetch(st), balances })
    const r = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.5, confirm: true })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/expired.*No funds were debited/)
    expect(r.data.signature).toBe('expiredsig')
  })
  it('surfaces /order error codes without signing', async () => {
    const st = base(); st.orderError = { errorCode: 2, errorMessage: 'insufficient sol' }
    const { call } = await connect({ signer, fetchFn: mockFetch(st), balances })
    const r = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.5, confirm: true })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/0\.01 SOL.*No funds were debited/)
    expect(executed(st)).toHaveLength(0)
  })

  // T-63 (PRD P10.6) through the tool
  it('refuses above the SOL cap, the slippage cap and the balance', async () => {
    const st = base()
    const { call } = await connect({ signer, fetchFn: mockFetch(st), balances })
    const big = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 2, confirm: true })
    expect(big.text).toMatch(/safety limit.*POTSWAP_MAX_TRADE_SOL \(1\).*No funds were debited/)
    const usdcBig = await call('swap', { inputMint: USDC, outputMint: SOL, amount: 150, confirm: true }) // $150 ≈ 1.5 SOL
    expect(usdcBig.text).toMatch(/≈ 1\.500 SOL is above/)
    const slip = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, slippageBps: 500, confirm: true })
    expect(slip.text).toMatch(/slippage 5%.*No funds were debited/)
    const raw = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 1_000_000_000, confirm: true })
    expect(raw.text).toMatch(/not lamports/)
    const { call: poor } = await connect({ signer, fetchFn: mockFetch(base()), balances: async () => ({ [SOL]: 0.3 }) })
    const r = await poor('swap', { inputMint: SOL, outputMint: USDC, amount: 0.295, confirm: true })
    expect(r.text).toMatch(/keep at least 0\.01 SOL.*No funds were debited/)
    expect(takerOrders(st)).toHaveLength(0)
    expect(executed(st)).toHaveLength(0)
  })
})
