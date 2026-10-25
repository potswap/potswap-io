// PRD P16 — T-112, T-113, T-114: the CLI over a mocked API, fake RPC and an in-memory strategy store.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { loadConfig, loadSigner, MemoryStore, SOL_MINT, USDC_MINT, NO_WALLET, type Rpc, type StrategyStore, type DcaStrategy } from '@potswap_io/sdk'
import { run, USAGE } from '../src/cli.js'

const SOL = SOL_MINT, USDC = USDC_MINT
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const TOKENS = [
  { id: SOL, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, usdPrice: 100, isVerified: true },
  { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, usdPrice: 1, isVerified: true },
  { id: BONK, symbol: 'Bonk', name: 'Bonk', decimals: 5, usdPrice: 0.00001, isVerified: true, liquidity: 9_000_000, holderCount: 800_000 },
  { id: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9, usdPrice: 120, isVerified: true },
]
const cfgJson = { referralAccount: 'RefAcct111', referralFeeBps: 250, fee: { standardBps: 250, sizeBps: 100, sizeThresholdUsd: 1000, stakerDiscountBps: 100, stakerMinPot: null }, seasonStart: null, pointsEnabled: false }
const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const OTHER = Keypair.generate().publicKey.toBase58()
const SIG = '5'.padEnd(88, 'a')

function unsignedTx(payer: Keypair) {
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(USDC), lamports: 1 })] }).compileToV0Message()
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64')
}

interface State { calls: URL[]; points?: number }
function mockFetch(st: State) {
  const j = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } })
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); st.calls.push(url); const p = url.pathname
    if (p === '/api/config') return j(cfgJson)
    if (p === '/api/jup/tokens/v2/search') { const q = url.searchParams.get('query') ?? ''; return j(TOKENS.filter((t) => q.split(',').includes(t.id) || `${t.symbol} ${t.name}`.toLowerCase().includes(q.toLowerCase()))) }
    if (p === '/api/jup/price/v3') return j(Object.fromEntries((url.searchParams.get('ids') ?? '').split(',').filter((i) => TOKENS.some((t) => t.id === i)).map((i) => [i, { usdPrice: TOKENS.find((t) => t.id === i)!.usdPrice }])))
    if (p === '/api/jup/swap/v2/order') { const amount = url.searchParams.get('amount')!; const taker = url.searchParams.get('taker'); return j({ router: 'metis', inAmount: amount, outAmount: String(Math.round(Number(amount) / 1e9 * 104.3637 * 1e6)), priceImpactPct: '0.01', slippageBps: 30, feeBps: 250, platformFee: { amount: '1', feeBps: 250, feeMint: USDC }, transaction: taker ? unsignedTx(kp) : null, requestId: 'req-1', expireAt: null }) }
    if (p === '/api/jup/swap/v2/execute') return j({ status: 'Success', signature: SIG, code: 0, totalOutputAmount: '104363700' })
    if (p.startsWith('/api/points/')) return st.points ? j({ error: 'off' }, st.points) : j({ wallet: p.split('/').pop(), epochFeeUsd: 1.5, allTimeFeeUsd: 61.4, swapCount: 23, potAllocatedMicro: '0', potClaimableMicro: '0', rewardBalanceSol: 0.0982, claimsOpen: false, level: { level: 'Bee', multiplier: 1.1, nextAt: 1000 }, season: { n: 0 } })
    if (p === '/api/launch-pool') return j({ enabled: true, address: 'Poo1', balanceSol: 125, targetSol: 500, pct: 25, remainingSol: 375, reached: false, launch: null, season: { n: 0, dayIndex: null, start: null, end: null }, splits: { launchPool: 0.6, rewardBalances: 0.2, burn: 0, team: 0.2 }, rules: 'Only protocol fees enter the pool.' })
    return j({ error: 'not found' }, 404)
  }) as typeof fetch
}

function fakeRpc(onSend?: (tx: Transaction) => void): Rpc {
  return { getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 100 }), getAccountOwner: async () => null, sendRawTransaction: async (raw) => { onSend?.(Transaction.from(raw)); return SIG }, confirmTransaction: async () => ({ err: null }) }
}

function cli(opts: { signer?: typeof signer | null; env?: Record<string, string>; store?: StrategyStore; rpc?: Rpc; state?: State; balances?: Record<string, number> } = {}) {
  const st: State = opts.state ?? { calls: [] }
  const out: string[] = [], err: string[] = []
  const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local', POTSWAP_STATE_DIR: mkdtempSync(join(tmpdir(), 'potswap-cli-')), ...opts.env })
  const exec = (argv: string[]) => run(argv, { config, fetchFn: mockFetch(st), signer: opts.signer === undefined ? signer : opts.signer, balances: async () => opts.balances ?? { [SOL]: 10, [USDC]: 1000, [BONK]: 1_000_000 }, rpc: opts.rpc ?? fakeRpc(), store: opts.store, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, now: () => Date.parse('2026-11-01T12:00:00Z') })
  return { exec, out, err, st, config, text: () => out.join('\n'), errText: () => err.join('\n') }
}

// T-114 (P16.9)
describe('usage', () => {
  it('prints usage and exits 2 on no command, unknown command, missing args or bad flags; --help exits 0', async () => {
    const c = cli()
    expect(await c.exec([])).toBe(2); expect(c.text()).toContain('Usage: potswap')
    expect(await c.exec(['nope'])).toBe(2); expect(c.errText()).toMatch(/Unknown command: nope/)
    expect(await c.exec(['quote', 'SOL'])).toBe(2)
    expect(await c.exec(['--bogus'])).toBe(2)
    const h = cli(); expect(await h.exec(['--help'])).toBe(0); expect(h.text()).toBe(USAGE)
    const v = cli(); expect(await v.exec(['--version'])).toBe(0); expect(v.text()).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

// T-112 (P16.3 / P16.4)
describe('quote and swap', () => {
  it('quote resolves symbols, prints the route and --json; works without a wallet', async () => {
    const c = cli({ signer: null })
    expect(await c.exec(['quote', 'SOL', 'USDC', '0.1'])).toBe(0)
    expect(c.text()).toMatch(/0.1 SOL → 10.43637 USDC via metis · fee 2.5% \(250 bps\)/)
    const j = cli({ signer: null })
    expect(await j.exec(['quote', 'sol', 'Bonk', '0.1', '--json'])).toBe(0)
    expect(JSON.parse(j.text())).toMatchObject({ inputMint: SOL, outputMint: BONK, router: 'metis' })
    const u = cli(); expect(await u.exec(['quote', 'SOL', 'NOPE', '1'])).toBe(1); expect(u.errText()).toMatch(/Unknown token NOPE.*No funds were debited/)
  })
  it('swap without --confirm prints the quote and exits 0; with --confirm executes; refusals exit 1 with the limit copy', async () => {
    const c = cli()
    expect(await c.exec(['swap', 'SOL', 'USDC', '0.1'])).toBe(0)
    expect(c.text()).toMatch(/Add --confirm to execute/)
    expect(c.st.calls.some((u) => u.pathname.endsWith('/execute'))).toBe(false)
    expect(await c.exec(['swap', 'SOL', 'USDC', '0.1', '--confirm'])).toBe(0)
    expect(c.text()).toMatch(/Swapped: 0.1 SOL → 104.3637 USDC via metis/)
    expect(c.st.calls.filter((u) => u.pathname.endsWith('/execute'))).toHaveLength(1)
    const big = cli()
    expect(await big.exec(['swap', 'SOL', 'USDC', '5', '--confirm'])).toBe(1)
    expect(big.errText()).toMatch(/POTSWAP_MAX_TRADE_SOL.*No funds were debited/)
    const nw = cli({ signer: null }); expect(await nw.exec(['swap', 'SOL', 'USDC', '0.1', '--confirm'])).toBe(1); expect(nw.errText()).toBe(NO_WALLET)
    const dry = cli({ env: { POTSWAP_DRY_RUN: 'true' } }); expect(await dry.exec(['swap', 'SOL', 'USDC', '0.1', '--confirm'])).toBe(0); expect(dry.text()).toMatch(/DRY RUN, nothing signed/)
    const al = cli({ env: { POTSWAP_ALLOWED_TOKENS: `${SOL},${USDC}` } }); expect(await al.exec(['swap', 'SOL', 'Bonk', '0.1', '--confirm'])).toBe(1); expect(al.errText()).toMatch(/POTSWAP_ALLOWED_TOKENS/)
    const stake = cli(); expect(await stake.exec(['stake', '0.2'])).toBe(0); expect(stake.st.calls.find((u) => u.pathname.endsWith('/order'))!.searchParams.get('outputMint')).toBe('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn')
  })
})

// T-113 (P16.5 / P16.6)
describe('wallet and transfer', () => {
  it('wallet create writes the state-dir wallet and prints only the public key; wallet show prints limits', async () => {
    const c = cli({ signer: null })
    expect(await c.exec(['wallet', 'create'])).toBe(0)
    const file = join(c.config.stateDir, 'wallet.json')
    expect(existsSync(file)).toBe(true)
    const secret = JSON.parse(readFileSync(file, 'utf8')) as number[]
    expect(c.text()).not.toContain(JSON.stringify(secret))
    expect(c.text()).toMatch(/Wallet created: [1-9A-HJ-NP-Za-km-z]{32,44}/)
    const again = cli({ signer: null, env: { POTSWAP_STATE_DIR: c.config.stateDir } })
    expect(await again.exec(['wallet', 'create'])).toBe(1) // loadSigner found the file → "already configured"
    const show = cli({ env: { POTSWAP_ALLOWED_RECIPIENTS: OTHER, POTSWAP_MAX_TRADE_SOL: '0.5' } })
    expect(await show.exec(['wallet', 'show'])).toBe(0)
    expect(show.text()).toContain(`Wallet ${signer.publicKey}`); expect(show.text()).toContain('maxTradeSol=0.5'); expect(show.text()).toContain(OTHER)
    const nw = cli({ signer: null }); await nw.exec(['wallet']); expect(nw.text()).toMatch(/No wallet configured/)
  })
  it('transfer needs --confirm, honours the recipient allowlist and sends SOL through the fake RPC with no fee', async () => {
    let seen: Transaction | undefined
    const c = cli({ rpc: fakeRpc((tx) => { seen = tx }) })
    expect(await c.exec(['transfer', OTHER, '0.5'])).toBe(0)
    expect(c.text()).toMatch(/Add --confirm to send/); expect(seen).toBeUndefined()
    expect(await c.exec(['transfer', OTHER, '0.5', '--confirm'])).toBe(0)
    expect(seen!.instructions[0].programId.toBase58()).toBe('11111111111111111111111111111111')
    expect(c.text()).toContain(`https://solscan.io/tx/${SIG}`)
    expect(c.st.calls.some((u) => u.pathname.includes('/swap/'))).toBe(false)
    const al = cli({ env: { POTSWAP_ALLOWED_RECIPIENTS: Keypair.generate().publicKey.toBase58() } })
    expect(await al.exec(['transfer', OTHER, '0.1', '--confirm'])).toBe(1); expect(al.errText()).toMatch(/POTSWAP_ALLOWED_RECIPIENTS/)
    const spl = cli({ rpc: fakeRpc((tx) => { seen = tx }) })
    expect(await spl.exec(['transfer', OTHER, '1000', '--mint', 'Bonk', '--confirm'])).toBe(0)
    expect(seen!.instructions.map((i) => i.programId.toBase58())).toEqual(['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'])
  })
})

// T-114 (P16.7 / P16.8)
describe('strategies, points, launch', () => {
  const dca = (over: Partial<DcaStrategy> = {}): DcaStrategy => ({ id: 'dca_1', kind: 'dca', createdAt: '2026-11-01T00:00:00.000Z', status: 'active', nextRunAt: '2026-11-01T13:00:00.000Z', consecutiveFailures: 0, totals: { runs: 2, volumeUsd: 20, feeUsd: 0.5, pointsAdded: 0.5 }, inputMint: SOL, outputMint: USDC, amountPerRun: 0.1, intervalMinutes: 60, runsDone: 2, ...over })
  it('list / runs / pause / resume / delete on the shared store', async () => {
    const store = new MemoryStore()
    store.update((s) => { s.strategies.push(dca()); s.runs.push({ id: 'r1', strategyId: 'dca_1', at: '2026-11-01T12:00:00.000Z', action: '0.1 SOL → USDC', outcome: 'ok', signature: SIG }) })
    const c = cli({ store })
    expect(await c.exec(['strategies', 'list'])).toBe(0); expect(c.text()).toMatch(/dca_1 {2}dca {2}active.*runs=2.*fees=\$0.50/)
    expect(await c.exec(['strategies', 'runs', 'dca_1'])).toBe(0); expect(c.text()).toMatch(/ok: 0.1 SOL → USDC sig=5/)
    expect(await c.exec(['strategies', 'pause', 'dca_1'])).toBe(0); expect(store.load().strategies[0]).toMatchObject({ status: 'paused', nextRunAt: null })
    expect(await c.exec(['strategies', 'resume', 'dca_1'])).toBe(0); expect(store.load().strategies[0].status).toBe('active'); expect(store.load().strategies[0].nextRunAt).not.toBeNull()
    expect(await c.exec(['strategies', 'runs', 'nope'])).toBe(1)
    expect(await c.exec(['strategies', 'delete', 'dca_1'])).toBe(0); expect(store.load().strategies).toHaveLength(0)
    expect(await c.exec(['strategies', 'delete', 'dca_1'])).toBe(1)
    expect(await c.exec(['strategies', 'pause'])).toBe(2)
    const j = cli({ store }); expect(await j.exec(['strategies', 'list', '--json'])).toBe(0); expect(JSON.parse(j.text())).toMatchObject({ strategies: [] })
  })
  it('points prints balance, level and season; 503 says the engine is off; launch prints the meter and split', async () => {
    const c = cli()
    expect(await c.exec(['points'])).toBe(0)
    expect(c.text()).toMatch(/reward balance: 0.098200 SOL \(claims open at launch\)/); expect(c.text()).toMatch(/level: Bee ×1.1 · season 0/)
    const off = cli({ state: { calls: [], points: 503 } }); expect(await off.exec(['points', OTHER])).toBe(0); expect(off.text()).toMatch(/not enabled yet/)
    const l = cli({ signer: null }); expect(await l.exec(['launch'])).toBe(0)
    expect(l.text()).toMatch(/Launch pool: 125 \/ 500 SOL \(25%\)/); expect(l.text()).toMatch(/pool 60% · reward balances 20% · burn 0% · team 20%/)
    const lj = cli({ signer: null }); await lj.exec(['launch', '--json']); expect(JSON.parse(lj.text())).toMatchObject({ balanceSol: 125 })
    const b = cli(); expect(await b.exec(['balances'])).toBe(0); expect(b.text()).toMatch(/SOL {2}10 {2}\(\$1000.00\)/)
    const nw = cli({ signer: null }); expect(await nw.exec(['balances'])).toBe(1)
  })
})

// T-120 (P15.8)
describe('observations', () => {
  it('observe --once publishes one signed observation per kind from Potswap data; observations prints the aggregate', async () => {
    const posted: Record<string, unknown>[] = []
    const st: State = { calls: [] }
    const base = mockFetch(st)
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/observations' && init?.method === 'POST') { const o = JSON.parse(String(init.body)) as Record<string, unknown>; posted.push(o); return new Response(JSON.stringify({ id: o.id, duplicate: false, expiresAt: 0 }), { status: 201, headers: { 'content-type': 'application/json' } }) }
      if (url.pathname === '/api/observations') return new Response(JSON.stringify({ items: posted, now: Date.now() }), { headers: { 'content-type': 'application/json' } })
      if (url.pathname.startsWith('/api/terminal/token/')) return new Response(JSON.stringify({ ...TOKENS[2], liquidity: 9_000_000, holderCount: 800_000 }), { headers: { 'content-type': 'application/json' } })
      return base(input, init)
    }) as typeof fetch
    const out: string[] = [], err: string[] = []
    const config = loadConfig({ POTSWAP_API: 'https://test.potswap.local', POTSWAP_STATE_DIR: mkdtempSync(join(tmpdir(), 'potswap-cli-')) })
    const exec = (argv: string[]) => run(argv, { config, fetchFn, signer, balances: async () => ({}), io: { out: (l) => out.push(l), err: (l) => err.push(l) }, getSlot: async () => 300_000_000, sleep: async () => {} })
    expect(await exec(['observe', 'Bonk', '--kinds', 'price,liquidity,holders', '--once'])).toBe(0)
    expect(posted).toHaveLength(3)
    expect(posted.map((o) => [o.kind, o.value, o.unit])).toEqual([['price', 0.00001, 'usd'], ['liquidity', 9_000_000, 'usd'], ['holders', 800_000, 'count']])
    expect(posted[0]).toMatchObject({ publisher: signer.publicKey, slot: 300_000_000, source: 'potswap-cli' })
    expect(out.join('\n')).toMatch(/price Dez.* = 0.00001 usd slot 300000000/)
    expect(await exec(['observations', 'Bonk'])).toBe(0)
    expect(out.join('\n')).toMatch(/1 fresh price observation\(s\) from 1 publisher\(s\) · median 0.00001/)
    expect(await exec(['observe', 'Bonk', '--kinds', 'mood', '--once'])).toBe(2)
    const nw = cli({ signer: null }); expect(await nw.exec(['observe', 'Bonk', '--once'])).toBe(1); expect(nw.errText()).toBe(NO_WALLET)
  })
})
