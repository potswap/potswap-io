import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createServer, type ServerDeps } from '../src/server.js'
import { loadConfig, SOL_MINT, USDC_MINT } from '@potswap_io/sdk'

export const SOL = SOL_MINT
export const USDC = USDC_MINT
export const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
export const JITOSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'

export const TOKENS = [
  { id: SOL, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, usdPrice: 100, isVerified: true },
  { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, usdPrice: 1, isVerified: true },
  { id: JITOSOL, symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9, usdPrice: 120, isVerified: true },
  { id: BONK, symbol: 'Bonk', name: 'Bonk', decimals: 5, usdPrice: 0.00001, isVerified: true, mcap: 800_000_000, liquidity: 9_000_000, holderCount: 800_000, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 30.3, devMints: 10 } },
]

export interface MockState {
  calls: { url: URL; init?: RequestInit; body?: unknown }[]
  config: Record<string, unknown>
  orderTx?: string | null
  executeResult?: Record<string, unknown>
  prices?: Record<string, number>
  status?: { order?: number; points?: number; search?: number }
  orderError?: { errorCode: number; errorMessage: string }
  history?: unknown[]
  ohlcv?: unknown
  launchPool?: unknown
  observations?: unknown[]
  raydiumPools?: unknown[]
  lendTokens?: unknown[]
  lendPositions?: unknown[]
  lendTx?: string
}

/** Builds a real v0 transaction the test keypair can sign (what /order would return). */
export function unsignedTx(payer: Keypair): string {
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(USDC), lamports: 1 })],
  }).compileToV0Message()
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64')
}

export function mockFetch(state: MockState): typeof fetch {
  const j = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    state.calls.push({ url, init, body })
    const p = url.pathname
    if (p === '/api/config') return j(state.config)
    if (p === '/api/jup/tokens/v2/search') {
      if (state.status?.search) return j({ error: 'rate' }, state.status.search)
      const q = url.searchParams.get('query') ?? ''
      const ids = q.split(',')
      return j(TOKENS.filter((t) => ids.includes(t.id) || `${t.symbol} ${t.name}`.toLowerCase().includes(q.toLowerCase())))
    }
    if (p === '/api/jup/price/v3') {
      const ids = (url.searchParams.get('ids') ?? '').split(',')
      const prices = state.prices ?? { [SOL]: 100, [USDC]: 1, [BONK]: 0.00001 }
      return j(Object.fromEntries(ids.filter((i) => prices[i]).map((i) => [i, { usdPrice: prices[i] }])))
    }
    if (p === '/api/jup/swap/v2/order') {
      if (state.status?.order) return j({ error: 'busy' }, state.status.order)
      const amount = url.searchParams.get('amount')!
      const taker = url.searchParams.get('taker')
      if (state.orderError && taker) return j({ router: 'metis', inAmount: amount, outAmount: '0', transaction: '', requestId: 'r', ...state.orderError })
      // 1 SOL → 104.3637 USDC, or 1 SOL → 10,000,000 BONK
      const out = url.searchParams.get('outputMint') === BONK ? String(Math.round(Number(amount) / 1e9 * 10_000_000 * 1e5)) : String(Math.round(Number(amount) / 1e9 * 104.3637 * 1e6))
      return j({ router: 'metis', inAmount: amount, outAmount: out, priceImpactPct: '0.01', slippageBps: 30, feeBps: 50, platformFee: { amount: '1', feeBps: 50, feeMint: USDC }, transaction: taker ? (state.orderTx ?? null) : null, requestId: 'req-1', expireAt: null })
    }
    if (p === '/api/jup/swap/v2/execute') return j(state.executeResult ?? { status: 'Success', signature: '5sig'.padEnd(88, 'x'), code: 0, totalOutputAmount: body?.requestId === 'req-1' ? '104363700' : '0' })
    if (p.startsWith('/api/terminal/list/')) return j([{ ...TOKENS[2], stats5m: { priceChange: 3 } }])
    if (p.startsWith('/api/terminal/token/')) return j({ ...TOKENS[2], bondingProgress: undefined })
    if (p.startsWith('/api/points/')) return state.status?.points ? j({ error: 'points engine not enabled yet' }, state.status.points) : j({ wallet: p.split('/').pop(), epochFeeUsd: 1.5, potAllocatedMicro: '0' })
    if (p === '/api/leaderboard') return j({ rows: [] })
    if (p.startsWith('/api/history/')) return j(state.history ?? [])
    if (p === '/api/observations' && init?.method === 'POST') { const o = body as Record<string, unknown>; const dup = (state.observations ?? []).some((x) => (x as { id: string }).id === o.id); if (!dup) (state.observations ??= []).push(o); return j({ id: o.id, duplicate: dup, expiresAt: Number(o.observedAt) + Number(o.ttlSec) * 1000 }, dup ? 200 : 201) }
    if (p === '/api/observations') { const mint = url.searchParams.get('mint'); const kind = url.searchParams.get('kind'); const items = (state.observations ?? []).filter((x) => { const o = x as { mint: string; kind: string }; return (!mint || o.mint === mint) && (!kind || o.kind === kind) }); return j({ items, now: Date.now() }) }
    if (p === '/api/observations/consume') { const m = JSON.parse(String((body as { message: string }).message)) as { observationId: string }; const o = (state.observations ?? []).find((x) => (x as { id: string }).id === m.observationId) as { publisher: string } | undefined; return o ? j({ observationId: m.observationId, publisher: o.publisher, consumer: (body as { wallet: string }).wallet, duplicate: false }, 201) : j({ error: 'No such observation.' }, 404) }
    if (p === '/api/raydium/pools') return j(state.raydiumPools ?? [])
    if (p === '/api/jup/lend/v1/earn/tokens') return j(state.lendTokens ?? [])
    if (p === '/api/jup/lend/v1/earn/positions') return j(state.lendPositions ?? [])
    if (p === '/api/jup/lend/v1/earn/deposit' || p === '/api/jup/lend/v1/earn/withdraw') return state.lendTx ? j({ transaction: state.lendTx }) : j({ message: 'no tx' }, 500)
    if (p === '/api/launch-pool') return j(state.launchPool ?? { enabled: true, address: 'Poo1', balanceSol: 125, targetSol: 500, pct: 25, remainingSol: 375, reached: false, launch: null, season: { n: 0, dayIndex: null, start: null, end: null }, splits: { launchPool: 0.6, rewardBalances: 0.2, burn: 0, team: 0.2 } })
    if (p === '/api/stats') return state.status?.points ? j({ error: 'points engine not enabled yet' }, state.status.points) : j({ unclaimedSol: 12.5, claimLadder: [{ minPriceUsd: 0.01, maxPriceUsd: 0.011, totalSol: 3, claims: 2 }], potDistributedMicro: '0' })
    if (p.startsWith('/api/terminal/ohlcv/')) return j(state.ohlcv ?? { mint: p.split('/').pop()!.split('?')[0], pool: { id: 'pool', name: 'X / SOL' }, candles: [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }, { time: 2, open: 1.5, high: 1.8, low: 1.2, close: 1.6, volume: 80 }] })
    return j({ error: 'not found' }, 404)
  }) as typeof fetch
}

export async function connect(deps: ServerDeps & { env?: Record<string, string> }) {
  // Strategy tools need a store; tests that don't pass one get an in-memory store so the tool list is complete.
  const config = deps.config ?? loadConfig({ POTSWAP_API: 'https://test.potswap.local', ...deps.env })
  const { MemoryStore } = await import('@potswap_io/sdk')
  const server = createServer({ ...deps, config, strategyStore: deps.strategyStore ?? new MemoryStore() })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(ct)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
    return { text: r.content.map((c) => c.text).join('\n'), data: r.structuredContent ?? {}, isError: !!r.isError }
  }
  return { client, server, call }
}
