// T-138 — the owner-run jobs over mocked API + fake RPC (dry-run plans and executed paths).
import { describe, expect, it } from 'vitest'
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { loadConfig, loadSigner, PotswapApi, SOL_MINT, USDC_MINT, type Rpc } from '@potswap_io/sdk'
import { runAdmin } from '../src/admin.js'

const SOL = SOL_MINT, USDC = USDC_MINT
const POT = 'PoT1111111111111111111111111111111111111111'
const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const SIG = '9'.padEnd(88, 'd')
const addr = () => Keypair.generate().publicKey.toBase58()
const TOKENS = [
  { id: SOL, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, usdPrice: 100, isVerified: true },
  { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, usdPrice: 1, isVerified: true },
  { id: POT, symbol: 'POT', name: 'Potswap', decimals: 6, usdPrice: 0.008, isVerified: true },
]
function unsignedTx(payer: Keypair) {
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(USDC), lamports: 1 })] }).compileToV0Message()
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64')
}

interface St { calls: { path: string; method: string; auth: string | null; body?: unknown }[]; claims: Record<string, unknown>[]; season: number; potPrice?: number }
function mockFetch(st: St) {
  const j = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } })
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const p = url.pathname
    const headers = new Headers(init?.headers)
    st.calls.push({ path: p, method: init?.method ?? 'GET', auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (p === '/api/config') return j({ referralAccount: 'Ref', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, season: { n: st.season }, splits: st.season === 0 ? { launchPool: 0.6, rewardBalances: 0.2, burn: 0, team: 0.2 } : { launchPool: 0, rewardBalances: 0.2, burn: 0.3, team: 0.5 } })
    if (p === '/api/jup/tokens/v2/search') { const q = url.searchParams.get('query') ?? ''; return j(TOKENS.filter((t) => q.split(',').includes(t.id) || t.symbol.toLowerCase().includes(q.toLowerCase()))) }
    if (p === '/api/jup/price/v3') return j(Object.fromEntries((url.searchParams.get('ids') ?? '').split(',').filter((i) => TOKENS.some((t) => t.id === i) && !(i === POT && st.potPrice === 0)).map((i) => [i, { usdPrice: i === POT && st.potPrice ? st.potPrice : TOKENS.find((t) => t.id === i)!.usdPrice }])))
    if (p === '/api/jup/swap/v2/order') { const amount = url.searchParams.get('amount')!; const taker = url.searchParams.get('taker'); const out = url.searchParams.get('outputMint') === POT ? String(Math.round(Number(amount) / 1e9 * 100 / 0.008 * 1e6)) : String(Math.round(Number(amount) / 1e9 * 104 * 1e6)); return j({ router: 'metis', inAmount: amount, outAmount: out, priceImpactPct: '0.01', slippageBps: 30, feeBps: 250, platformFee: { amount: '1', feeBps: 250, feeMint: USDC }, transaction: taker ? unsignedTx(kp) : null, requestId: 'r', expireAt: null }) }
    if (p === '/api/jup/swap/v2/execute') return j({ status: 'Success', signature: SIG, code: 0, totalOutputAmount: (init?.body && JSON.parse(String(init.body)).requestId === 'r') ? undefined : undefined })
    if (p === '/api/admin/claims' && (init?.method ?? 'GET') === 'GET') return headers.get('authorization') === 'Bearer sekrit' ? j({ claims: st.claims }) : j({ error: 'unauthorized' }, 401)
    if (p === '/api/admin/claims') return j({ claim: { ...(init?.body ? JSON.parse(String(init.body)) : {}) } })
    if (p === '/api/admin/ledger') return j({ recorded: true }, 201)
    return j({ error: 'not found' }, 404)
  }) as typeof fetch
}
function fakeRpc(sent: Uint8Array[]): Rpc {
  return { getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 1)), lastValidBlockHeight: 5 }), getAccountOwner: async () => null, sendRawTransaction: async (raw) => { sent.push(raw); return SIG }, confirmTransaction: async () => ({ err: null }) }
}
function setup(over: Partial<St> = {}, balances: Record<string, number> = { [SOL]: 10.05, [USDC]: 1000, [POT]: 0 }) {
  const st: St = { calls: [], claims: [], season: 0, ...over }
  const sent: Uint8Array[] = []
  const out: string[] = [], err: string[] = []
  const config = loadConfig({ POTSWAP_API: 'https://t.local' })
  const run = (job: string | undefined, flags: Record<string, unknown> = {}, s: typeof signer | null = signer, secret = 'sekrit') => runAdmin(job, flags, { api: new PotswapApi(config.apiBase, mockFetch(st)), config, signer: s, balances: async () => balances, rpc: fakeRpc(sent), io: { out: (l) => out.push(l), err: (l) => err.push(l) }, secret, now: () => Date.parse('2027-02-01T00:00:00Z'), random: () => 0.5, sleep: async () => {} })
  return { st, sent, out, err, run, text: () => out.join('\n'), errText: () => err.join('\n') }
}

describe('admin: guards', () => {
  it('usage without a job, no wallet, no secret, unknown job', async () => {
    const c = setup()
    expect(await c.run(undefined)).toBe(2); expect(c.text()).toMatch(/potswap admin <job>/)
    expect(await c.run('sweep', {}, null)).toBe(1)
    expect(await c.run('sweep', {}, signer, '')).toBe(2); expect(c.errText()).toMatch(/CRON_SECRET/)
    expect(await c.run('nope')).toBe(2)
  })
})

describe('admin sweep (P12.1)', () => {
  it('plans the season-0 split per mint, requires destinations, executes transfers and records a treasury entry', async () => {
    const pool = addr(), reward = addr(), team = addr()
    const c = setup()
    expect(await c.run('sweep', { pool, reward })).toBe(2); expect(c.errText()).toMatch(/--team/)
    expect(await c.run('sweep', { pool, reward, team })).toBe(0)
    expect(c.text()).toMatch(/So11.*: 10 → pool 6 · reward 2 · team 2 · burn share kept 0/) // 10.05 − 0.05 reserve
    expect(c.text()).toMatch(/EPjF.*: 1000 → pool 600 · reward 200 · team 200/)
    expect(c.sent).toHaveLength(0)
    expect(await c.run('sweep', { pool, reward, team, execute: true, mints: 'SOL' }), c.errText()).toBe(0)
    expect(c.sent).toHaveLength(3)
    const dests = c.sent.map((raw) => Transaction.from(raw).instructions[0].keys[1].pubkey.toBase58())
    expect(dests).toEqual([pool, reward, team])
    const ledger = c.st.calls.find((x) => x.path === '/api/admin/ledger')!
    expect(ledger.auth).toBe('Bearer sekrit'); expect(ledger.body).toMatchObject({ kind: 'treasury', micro: '0' })
    // season 1+: no pool share, burn share retained
    const s1 = setup({ season: 1 })
    await s1.run('sweep', { reward, team })
    expect(s1.text()).toMatch(/So11.*: 10 → pool 0 · reward 2 · team 5 · burn share kept 3/)
  })
})

describe('admin claims (P12.5)', () => {
  const claim = (id: string, over: Record<string, unknown> = {}) => ({ id, wallet: addr(), kind: 'limit', amountSol: 0.5, maxPriceUsd: 0.01, filledSol: 0, potMicro: '0', status: 'open', createdAt: `2027-01-31T00:00:0${id.slice(-1)}.000Z`, expiresAt: null, ...over })
  it('matches at the POT price within the budget, buys, sends and records; expires stale limits; dry-run first', async () => {
    const claims = [claim('c1'), claim('c2', { maxPriceUsd: 0.005 }), claim('c3', { expiresAt: '2027-01-01T00:00:00Z' }), claim('c4', { kind: 'market', maxPriceUsd: null, amountSol: 0.7 })]
    const c = setup({ claims, potPrice: 0.008 })
    expect(await c.run('claims', { 'pot-mint': POT, budget: '1' }), c.errText()).toBe(0)
    expect(c.text()).toMatch(/POT \$0.008 · 4 open · 2 fill\(s\) within 1 SOL · 1 expired/) // c1 (0.5) + c4 partial (0.5 of 0.7); c2 above its limit; c3 expired
    expect(c.sent).toHaveLength(0)
    expect(await c.run('claims', { 'pot-mint': POT, budget: '1', execute: true }), c.errText()).toBe(0)
    const posts = c.st.calls.filter((x) => x.path === '/api/admin/claims' && x.method === 'POST').map((x) => x.body as Record<string, unknown>)
    expect(posts.find((b) => b.action === 'expire')).toMatchObject({ id: 'c3' })
    const fills = posts.filter((b) => b.action === 'fill')
    expect(fills.map((b) => [b.id, b.sol])).toEqual([['c1', 0.5], ['c4', 0.5]])
    expect(fills[0]).toMatchObject({ signature: SIG, potMicro: '6250000000' }) // 0.5 SOL × $100 / $0.008 = 6,250 POT
    expect(c.sent).toHaveLength(2) // two POT transfers (buys go through /execute)
    expect(c.st.calls.filter((x) => x.path === '/api/jup/swap/v2/execute')).toHaveLength(2)
    expect(await c.run('claims', {})).toBe(2)
    const noPrice = setup({ claims: [claim('c1')], potPrice: 0 })
    expect(await noPrice.run('claims', { 'pot-mint': POT, execute: true })).toBe(1); expect(noPrice.errText()).toMatch(/price unavailable/)
  })
})

describe('admin burn (P12.12)', () => {
  it('dry-run, then buys POT and burns it with a BurnChecked instruction, recording micro', async () => {
    const c = setup()
    expect(await c.run('burn', { 'pot-mint': POT, sol: '0.2' })).toBe(0); expect(c.text()).toMatch(/Would buy POT with 0.2 SOL/)
    expect(await c.run('burn', { 'pot-mint': POT, sol: '0.2', 'max-delay-min': '10', execute: true })).toBe(0)
    expect(c.text()).toMatch(/waiting 300 s/)
    expect(c.sent).toHaveLength(1)
    const tx = VersionedTransaction.deserialize(c.sent[0])
    const ix = tx.message.compiledInstructions[0]
    expect(tx.message.staticAccountKeys[ix.programIdIndex].toBase58()).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'); expect(ix.data[0]).toBe(15) // BurnChecked
    const ledger = c.st.calls.find((x) => x.path === '/api/admin/ledger')!.body as Record<string, unknown>
    expect(ledger).toMatchObject({ kind: 'burn', micro: '2500000000' }) // 0.2 SOL → 2,500 POT
    expect(await c.run('burn', { sol: '1' })).toBe(2)
  })
})
