// PRD P13 — Tier 1 agent tools through the real MCP protocol (T-96 … T-103).
import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { connect, mockFetch, unsignedTx, SOL, USDC, BONK, type MockState } from './helpers.js'
import { loadSigner } from '@potswap_io/sdk'
import { JITOSOL_MINT, loadConfig, NO_WALLET, RECIPIENT_NOT_ALLOWED, TOKEN_NOT_ALLOWED } from '@potswap_io/sdk'
import type { Rpc } from '@potswap_io/sdk'
import type { TxRpc } from '../src/agentTools.js'
import type { HeliusTx } from '@potswap_io/sdk'

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const WALLET = kp.publicKey.toBase58()
const OTHER = Keypair.generate().publicKey.toBase58()
const cfgJson = { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false }
const SIG = '5'.padEnd(88, 'a')

function fakeRpc(over: Partial<Rpc> & { onSend?: (tx: Transaction) => void; dstExists?: boolean; err?: unknown } = {}) {
  const sent: Uint8Array[] = []
  const rpc: Rpc = {
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 100 }),
    getAccountOwner: async () => (over.dstExists ? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' : null),
    sendRawTransaction: async (raw) => { sent.push(raw); over.onSend?.(Transaction.from(raw)); return SIG },
    confirmTransaction: async () => ({ err: over.err ?? null }),
    ...over,
  }
  return { rpc, sent }
}

async function app(opts: { signer?: typeof signer | null; env?: Record<string, string>; rpc?: Rpc; txRpc?: TxRpc; state?: Partial<MockState>; balances?: Record<string, number> } = {}) {
  const st: MockState = { calls: [], config: cfgJson, orderTx: unsignedTx(kp), ...opts.state }
  const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local', POTSWAP_STATE_DIR: mkdtempSync(join(tmpdir(), 'potswap-')), ...opts.env })
  const balances = async () => opts.balances ?? { [SOL]: 10, [USDC]: 1000, [BONK]: 1_000_000 }
  const c = await connect({ signer: opts.signer === undefined ? signer : opts.signer, fetchFn: mockFetch(st), balances, config, rpc: opts.rpc ?? fakeRpc().rpc, txRpc: opts.txRpc })
  return { ...c, st, config }
}

// T-96 (P13.1)
describe('wallet_create / get_wallet', () => {
  it('creates a 0600 wallet file once, never prints the secret, and loadSigner picks it up from the state dir', async () => {
    const { call, config } = await app({ signer: null })
    expect((await call('get_wallet')).data.publicKey).toBeNull()
    const r0 = await call('wallet_create')
    expect(r0.isError).toBe(true); expect(r0.text).toMatch(/confirm=true/)
    expect(existsSync(join(config.stateDir, 'wallet.json'))).toBe(false)
    const r1 = await call('wallet_create', { confirm: true })
    expect(r1.isError).toBe(false)
    const pub = r1.data.publicKey as string
    expect(() => new PublicKey(pub)).not.toThrow()
    const file = join(config.stateDir, 'wallet.json')
    expect(existsSync(file)).toBe(true)
    const secret = JSON.parse(readFileSync(file, 'utf8')) as number[]
    expect(secret).toHaveLength(64)
    expect(r1.text).not.toContain(JSON.stringify(secret))
    expect(r1.text).not.toContain(bs58.encode(Uint8Array.from(secret)))
    // the server now signs with it
    expect((await call('get_wallet')).data.publicKey).toBe(pub)
    const r2 = await call('wallet_create', { confirm: true })
    expect(r2.isError).toBe(true); expect(r2.text).toMatch(/already configured/)
    expect(loadSigner({ stateDir: config.stateDir })!.publicKey).toBe(pub)
  })
  it('get_wallet reports limits, allowlists and funding instructions', async () => {
    const { call } = await app({ env: { POTSWAP_ALLOWED_TOKENS: `${SOL},${USDC}`, POTSWAP_ALLOWED_RECIPIENTS: OTHER, POTSWAP_MAX_TRADE_SOL: '0.5' } })
    const r = await call('get_wallet')
    expect(r.data).toMatchObject({ publicKey: WALLET, allowedTokens: [SOL, USDC], allowedRecipients: [OTHER], limits: { maxTradeSol: 0.5, dryRun: false } })
    expect(r.data.fund as string).toContain(WALLET)
  })
})

// T-97 (P13.2, P13.3)
describe('transfer', () => {
  it('SOL: quote-only without confirm, then signs a SystemProgram transfer with no Potswap fee', async () => {
    let seen: Transaction | undefined
    const { rpc, sent } = fakeRpc({ onSend: (tx) => { seen = tx } })
    const { call, st } = await app({ rpc })
    const q = await call('transfer', { to: OTHER, amount: 0.5 })
    expect(q.isError).toBe(false); expect(q.data.confirmRequired).toBe(true); expect(sent).toHaveLength(0)
    const r = await call('transfer', { to: OTHER, amount: 0.5, confirm: true })
    expect(r.isError).toBe(false)
    expect(r.data.signature).toBe(SIG)
    expect(sent).toHaveLength(1)
    expect(seen!.instructions).toHaveLength(1)
    expect(seen!.instructions[0].programId.toBase58()).toBe('11111111111111111111111111111111')
    expect(seen!.signatures[0].publicKey.toBase58()).toBe(WALLET)
    expect(st.calls.some((c) => c.url.pathname.includes('/swap/'))).toBe(false) // no Jupiter, no fee
  })
  it('SPL: creates the recipient ATA when missing and uses transferChecked with the token decimals', async () => {
    let seen: Transaction | undefined
    const { rpc } = fakeRpc({ onSend: (tx) => { seen = tx } })
    const { call } = await app({ rpc })
    const r = await call('transfer', { to: OTHER, mint: BONK, amount: 1000, confirm: true })
    expect(r.isError).toBe(false)
    expect(seen!.instructions.map((i) => i.programId.toBase58())).toEqual(['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'])
    const existing = fakeRpc({ dstExists: true })
    const { call: call2 } = await app({ rpc: existing.rpc })
    await call2('transfer', { to: OTHER, mint: BONK, amount: 1000, confirm: true })
    expect(existing.sent).toHaveLength(1)
  })
  it('refuses: no wallet, recipient not allowlisted, above cap, below reserve, dry run — each saying no funds were debited', async () => {
    const nw = await app({ signer: null })
    expect((await nw.call('transfer', { to: OTHER, amount: 0.1, confirm: true })).text).toBe(NO_WALLET)
    const al = await app({ env: { POTSWAP_ALLOWED_RECIPIENTS: Keypair.generate().publicKey.toBase58() } })
    const r1 = await al.call('transfer', { to: OTHER, amount: 0.1, confirm: true })
    expect(r1.isError).toBe(true); expect(r1.text).toBe(RECIPIENT_NOT_ALLOWED)
    const { rpc, sent } = fakeRpc()
    const { call } = await app({ rpc })
    const r2 = await call('transfer', { to: OTHER, amount: 2, confirm: true })
    expect(r2.text).toMatch(/POTSWAP_MAX_TRADE_SOL/); expect(r2.text).toMatch(/No funds were debited/)
    const r3 = await call('transfer', { to: OTHER, mint: USDC, amount: 150, confirm: true }) // 150 USDC ≈ 1.5 SOL
    expect(r3.text).toMatch(/POTSWAP_MAX_TRADE_SOL/)
    const low = await app({ rpc, balances: { [SOL]: 0.1 } })
    const r4 = await low.call('transfer', { to: OTHER, amount: 0.095, confirm: true })
    expect(r4.text).toMatch(/keep at least/)
    const dry = await app({ rpc, env: { POTSWAP_DRY_RUN: 'true' } })
    const r5 = await dry.call('transfer', { to: OTHER, amount: 0.1, confirm: true })
    expect(r5.isError).toBe(false); expect(r5.data.dryRun).toBe(true)
    expect(sent).toHaveLength(0)
    const failed = await app({ rpc: fakeRpc({ err: { InstructionError: [0, 'Custom'] } }).rpc })
    const r6 = await failed.call('transfer', { to: OTHER, amount: 0.1, confirm: true })
    expect(r6.isError).toBe(true); expect(r6.text).toMatch(/failed on-chain/)
  })
})

// T-99 (P13.5)
describe('get_transaction', () => {
  const txRpc = (status: string | null, err: unknown = null): TxRpc => ({
    getSignatureStatus: async () => (status ? { confirmationStatus: status, err, slot: 42 } : null),
    getParsedTransaction: async () => ({ slot: 42, fee: 5000, err, preBalances: [2e9, 0], postBalances: [1.5e9 - 5000, 0.5e9], accountKeys: [WALLET, OTHER],
      preTokenBalances: [{ mint: BONK, owner: WALLET, uiTokenAmount: { uiAmount: 100 } }], postTokenBalances: [{ mint: BONK, owner: WALLET, uiTokenAmount: { uiAmount: 60 } }] }),
  })
  it('maps status and reports SOL / token changes for the wallet', async () => {
    const { call } = await app({ txRpc: txRpc('finalized') })
    const r = await call('get_transaction', { signature: SIG })
    expect(r.data).toMatchObject({ status: 'finalized', slot: 42, feeSol: 0.000005, tokenChanges: [{ mint: BONK, change: -40 }] })
    expect(r.data.solChange as number).toBeCloseTo(-0.500005, 6)
    expect(r.text).toMatch(/finalized/)
  })
  it('not found and failed', async () => {
    expect((await (await app({ txRpc: txRpc(null) })).call('get_transaction', { signature: SIG })).data.status).toBe('not found')
    const f = await (await app({ txRpc: txRpc('confirmed', { InstructionError: [1, 'Custom'] }) })).call('get_transaction', { signature: SIG })
    expect(f.data.status).toBe('failed'); expect(f.data.error).toBeTruthy()
  })
})

const swapTx = (sig: string, ts: number, inSol: number, outBonk: number): HeliusTx => ({
  signature: sig, timestamp: ts, type: 'SWAP', source: 'JUPITER', fee: 5000, feePayer: WALLET,
  events: { swap: { nativeInput: { account: WALLET, amount: String(inSol * 1e9) }, nativeOutput: null, tokenInputs: [], tokenOutputs: [{ userAccount: WALLET, mint: BONK, rawTokenAmount: { tokenAmount: String(outBonk * 1e5), decimals: 5 } }] } },
})
const sellTx = (sig: string, ts: number, inBonk: number, outSol: number): HeliusTx => ({
  signature: sig, timestamp: ts, type: 'SWAP', source: 'JUPITER', fee: 5000, feePayer: WALLET,
  events: { swap: { nativeInput: null, nativeOutput: { account: WALLET, amount: String(outSol * 1e9) }, tokenInputs: [{ userAccount: WALLET, mint: BONK, rawTokenAmount: { tokenAmount: String(inBonk * 1e5), decimals: 5 } }], tokenOutputs: [] } },
})

// T-99 (P13.6)
describe('get_history', () => {
  it('normalizes swaps, transfers and failures from Helius parsed transactions', async () => {
    const history: HeliusTx[] = [
      swapTx('s1', 1_700_000_100, 1, 10_000_000),
      { signature: 's2', timestamp: 1_700_000_050, type: 'TRANSFER', source: 'SYSTEM_PROGRAM', fee: 5000, nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 0.25e9 }] },
      { signature: 's3', timestamp: 1_700_000_000, type: 'TRANSFER', source: 'SOLANA_PROGRAM_LIBRARY', fee: 5000, tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, tokenAmount: 500, mint: USDC }] },
      { signature: 's4', timestamp: 1_699_999_900, type: 'UNKNOWN', source: 'UNKNOWN', fee: 5000, transactionError: { err: 'x' } },
    ]
    const { call, st } = await app({ state: { history } })
    const r = await call('get_history', { limit: 10 })
    const items = r.data.items as Record<string, unknown>[]
    expect(st.calls.find((c) => c.url.pathname === `/api/history/${WALLET}`)!.url.searchParams.get('limit')).toBe('10')
    expect(items.map((i) => i.kind)).toEqual(['swap', 'transfer', 'transfer', 'other'])
    expect(items[0]).toMatchObject({ inMint: SOL, inAmount: 1, outMint: BONK, outAmount: 10_000_000, feeSol: 0.000005 })
    expect(items[1]).toMatchObject({ direction: 'out', counterparty: OTHER, mint: SOL, amount: 0.25 })
    expect(items[2]).toMatchObject({ direction: 'in', counterparty: OTHER, mint: USDC, amount: 500 })
    expect(items[3].failed).toBe(true)
    expect((await (await app({ signer: null })).call('get_history')).text).toBe(NO_WALLET)
  })
})

// T-100 (P13.7)
describe('get_positions with PnL', () => {
  it('average cost, unrealised and realised PnL from the swap history', async () => {
    // Bought 10M BONK for 1 SOL ($100) → avg $0.00001. Sold 2M for 0.3 SOL ($30): realised 30 − 20 = +10. Hold 8M at $0.00002 = $160, cost 80 → unrealised +80.
    const history = [sellTx('s2', 1_700_000_200, 2_000_000, 0.3), swapTx('s1', 1_700_000_100, 1, 10_000_000)]
    const { call } = await app({ state: { history, prices: { [SOL]: 100, [USDC]: 1, [BONK]: 0.00002 } }, balances: { [SOL]: 5, [BONK]: 8_000_000 } })
    const r = await call('get_positions')
    const p = (r.data.positions as Record<string, number>[]).find((x) => x.mint === BONK)!
    expect(p.amount).toBe(8_000_000)
    expect(p.avgCostUsd).toBeCloseTo(0.00001, 10)
    expect(p.valueUsd).toBeCloseTo(160, 6)
    expect(p.unrealisedUsd).toBeCloseTo(80, 6)
    expect(p.realisedUsd).toBeCloseTo(10, 6)
    expect(r.data.sol).toBe(5)
    expect(r.text).toMatch(/unrealised \+\$80/)
  })
})

// T-101 (P13.8)
describe('stake_sol / unstake_sol', () => {
  it('routes SOL ↔ jitoSOL through the shared swap engine with the fee and confirm gate', async () => {
    const { call, st } = await app({ balances: { [SOL]: 10, [JITOSOL_MINT]: 1 } })
    const q = await call('stake_sol', { amount: 0.5 })
    expect(q.isError).toBe(false); expect(q.data.confirmRequired).toBe(true)
    const r = await call('stake_sol', { amount: 0.5, confirm: true })
    expect(r.isError).toBe(false)
    const order = st.calls.filter((c) => c.url.pathname.endsWith('/order') && c.url.searchParams.has('taker')).at(-1)!.url.searchParams
    expect(order.get('inputMint')).toBe(SOL); expect(order.get('outputMint')).toBe(JITOSOL_MINT); expect(order.get('referralFee')).toBe('250')
    expect(st.calls.filter((c) => c.url.pathname.endsWith('/execute'))).toHaveLength(1)
    const u = await call('unstake_sol', { amount: 0.1, confirm: true })
    expect(u.isError).toBe(false)
    const order2 = st.calls.filter((c) => c.url.pathname.endsWith('/order') && c.url.searchParams.has('taker')).at(-1)!.url.searchParams
    expect(order2.get('inputMint')).toBe(JITOSOL_MINT); expect(order2.get('outputMint')).toBe(SOL)
    expect((await (await app({ signer: null })).call('stake_sol', { amount: 0.1, confirm: true })).text).toBe(NO_WALLET)
  })
})

// T-98 (P13.4)
describe('token allowlist', () => {
  it('blocks swaps outside POTSWAP_ALLOWED_TOKENS before any quote; allowed pairs still work', async () => {
    const { call, st } = await app({ env: { POTSWAP_ALLOWED_TOKENS: `${SOL},${USDC}` } })
    const r = await call('swap', { inputMint: SOL, outputMint: BONK, amount: 0.1, confirm: true })
    expect(r.isError).toBe(true); expect(r.text).toBe(TOKEN_NOT_ALLOWED)
    expect(st.calls.some((c) => c.url.pathname.endsWith('/order'))).toBe(false)
    const ok = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true })
    expect(ok.isError).toBe(false)
  })
})

// T-102 (P13.9)
// P12.1 / P12.6a
describe('get_launch_status', () => {
  it('reports the meter, season, split and claim pressure; works without a wallet', async () => {
    const { call } = await app({ signer: null })
    const r = await call('get_launch_status')
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ balanceSol: 125, targetSol: 500, pct: 25, season: { n: 0 }, splits: { launchPool: 0.6 }, unclaimedSol: 12.5 })
    expect((r.data.claimLadder as unknown[]).length).toBe(1)
    expect(r.text).toMatch(/125 \/ 500 SOL \(25%\)/)
    expect(r.text).toMatch(/Unclaimed reward balances: 12.5 SOL/)
    const launched = await app({ state: { launchPool: { enabled: true, address: 'Poo1', balanceSol: 500, targetSol: 500, pct: 100, remainingSol: 0, reached: true, launch: '2026-01-01T00:00:00Z', season: { n: 3, dayIndex: 4, start: null, end: '2026-03-31T00:00:00Z' }, splits: { burn: 0.3 } } } })
    expect((await launched.call('get_launch_status')).text).toMatch(/Season 3 day 4\/30/)
  })
})

describe('get_price_history', () => {
  it('returns candles from the Potswap OHLCV endpoint', async () => {
    const { call, st } = await app()
    const r = await call('get_price_history', { mint: BONK, timeframe: '1h', limit: 2 })
    expect(r.isError).toBe(false)
    expect((r.data.candles as unknown[]).length).toBe(2)
    const u = st.calls.find((c) => c.url.pathname === `/api/terminal/ohlcv/${BONK}`)!.url.searchParams
    expect(u.get('tf')).toBe('1h'); expect(u.get('limit')).toBe('2')
    expect(r.text).toMatch(/2 1h candles/)
  })
})
