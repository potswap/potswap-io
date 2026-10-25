// Potswap HTTP client. All upstream keys stay on the Potswap side; this only talks to potswap.io.
import type { ExecuteResponse, OrderResponse, Token } from './shared/lib-types.js'
import type { TerminalToken } from './shared/types.js'
import { DEFAULT_FEE_SCHEDULE, parseFeeSchedule, type FeeSchedule } from './shared/fee.js'

export type FetchFn = typeof fetch

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export interface PublicConfig { feeWallet?: string | null; season?: { n: number; dayIndex: number | null; start: string | null; end: string | null }; splits?: { launchPool: number; rewardBalances: number; burn: number; team: number }; potMint?: string | null; claimsOpen?: boolean; referralAccount: string | null; referralFeeBps: number; fee: FeeSchedule; burnShare: number; seasonStart: string | null; pointsEnabled: boolean }

export class PotswapApi {
  private base: string
  private fetchFn: FetchFn
  private configCache: { value: PublicConfig; at: number } | null = null
  private tokenCache = new Map<string, Token>()

  constructor(base: string, fetchFn: FetchFn = fetch) { this.base = base; this.fetchFn = fetchFn }

  private async req<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
    const res = await this.fetchFn(this.base + path, { ...init, headers: { accept: 'application/json', ...(init?.headers as Record<string, string>) } })
    if (res.status === 429 || res.status === 503) {
      if (retry) { await new Promise((r) => setTimeout(r, 1100)); return this.req<T>(path, init, false) }
      throw new ApiError(res.status, 'Potswap is busy; retry in a few seconds. No funds were debited.')
    }
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { data = { error: text } }
    if (!res.ok) {
      const msg = (data as { error?: string; message?: string })?.error ?? (data as { message?: string })?.message ?? `HTTP ${res.status}`
      throw new ApiError(res.status, msg)
    }
    return data as T
  }

  async config(): Promise<PublicConfig> {
    if (this.configCache && Date.now() - this.configCache.at < 300_000) return this.configCache.value
    let value: PublicConfig
    try {
      const raw = await this.req<Partial<PublicConfig> & { fee?: unknown }>('/api/config')
      value = { feeWallet: raw.feeWallet ?? null, season: raw.season, splits: raw.splits, potMint: raw.potMint ?? null, claimsOpen: !!raw.claimsOpen, referralAccount: raw.referralAccount ?? null, referralFeeBps: raw.referralFeeBps ?? 0, fee: parseFeeSchedule(raw.fee), burnShare: raw.burnShare ?? 0.5, seasonStart: raw.seasonStart ?? null, pointsEnabled: !!raw.pointsEnabled }
    } catch { value = { feeWallet: null, referralAccount: null, referralFeeBps: 0, fee: DEFAULT_FEE_SCHEDULE, burnShare: 0.5, seasonStart: null, pointsEnabled: false } }
    this.configCache = { value, at: Date.now() }
    return value
  }

  async order(p: { inputMint: string; outputMint: string; amount: string; taker?: string; slippageBps?: number; feeBps?: number }): Promise<OrderResponse> {
    const cfg = await this.config()
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount })
    if (p.taker) q.set('taker', p.taker)
    if (p.slippageBps !== undefined) q.set('slippageBps', String(p.slippageBps))
    if (cfg.referralAccount) { q.set('referralAccount', cfg.referralAccount); q.set('referralFee', String(p.feeBps ?? cfg.fee.standardBps)) }
    return this.req<OrderResponse>(`/api/jup/swap/v2/order?${q}`)
  }

  execute(signedTransaction: string, requestId: string) {
    return this.req<ExecuteResponse>('/api/jup/swap/v2/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction, requestId }) })
  }

  async searchTokens(query: string): Promise<Token[]> {
    const list = await this.req<Token[]>(`/api/jup/tokens/v2/search?query=${encodeURIComponent(query)}`)
    for (const t of list) this.tokenCache.set(t.id, t)
    return list
  }

  async token(mint: string): Promise<Token> {
    const hit = this.tokenCache.get(mint)
    if (hit) return hit
    const list = await this.searchTokens(mint)
    const t = list.find((x) => x.id === mint)
    if (!t) throw new ApiError(404, `Unknown token ${mint}`)
    return t
  }

  async prices(mints: string[]): Promise<Record<string, number>> {
    if (!mints.length) return {}
    const d = await this.req<Record<string, { usdPrice: number }>>(`/api/price/v3?ids=${mints.join(',')}`.replace('/api/price', '/api/jup/price'))
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.usdPrice]))
  }

  list(kind: string) { return this.req<TerminalToken[]>(`/api/terminal/list/${kind}`) }
  terminalToken(mint: string) { return this.req<TerminalToken>(`/api/terminal/token/${mint}`) }
  points(wallet: string) { return this.req<Record<string, unknown>>(`/api/points/${wallet}`) }
  launchPool() { return this.req<Record<string, unknown>>('/api/launch-pool') }
  observations(q: { mint?: string; kind?: string; publisher?: string; limit?: number; fresh?: boolean } = {}) {
    const p = new URLSearchParams()
    if (q.mint) p.set('mint', q.mint); if (q.kind) p.set('kind', q.kind); if (q.publisher) p.set('publisher', q.publisher); if (q.limit) p.set('limit', String(q.limit)); if (q.fresh === false) p.set('fresh', '0')
    return this.req<{ items: import('./shared/observation-schema.js').Observation[]; aggregate?: import('./shared/observation-schema.js').Aggregate; now?: number; persistent?: boolean }>(`/api/observations${p.size ? `?${p}` : ''}`)
  }
  publishObservation(obs: import('./shared/observation-schema.js').Observation) {
    return this.req<{ id: string; duplicate: boolean; expiresAt: number; persistent?: boolean }>('/api/observations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obs) })
  }
  consumeObservation(receipt: { wallet: string; message: string; signature: string }) {
    return this.req<{ observationId: string; publisher: string; consumer: string; duplicate: boolean }>('/api/observations/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(receipt) })
  }
  observationStats() { return this.req<Record<string, unknown>>('/api/observations/stats') }
  lendTokens() { return this.req<import('./lend.js').RawLendToken[]>('/api/jup/lend/v1/earn/tokens') }
  lendPositions(users: string[]) { return this.req<import('./lend.js').RawLendPosition[]>(`/api/jup/lend/v1/earn/positions?users=${users.join(',')}`) }
  lendTx(action: 'deposit' | 'withdraw', body: { asset: string; signer: string; amount: string }) {
    return this.req<{ transaction: string }>(`/api/jup/lend/v1/earn/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  adminClaims(secret: string) { return this.req<{ claims: (Omit<import('./shared/claims-types.js').ClaimJson, never>)[] }>('/api/admin/claims', { headers: { authorization: `Bearer ${secret}` } }).then((r) => r.claims) }
  adminClaimAction(secret: string, body: { action: 'fill' | 'expire'; id: string; sol?: number; potMicro?: string; signature?: string }) {
    return this.req<{ claim: Record<string, unknown> }>('/api/admin/claims', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  adminLedger(secret: string, body: { kind: 'treasury' | 'burn' | 'airdrop' | 'rollover'; epoch?: number | null; micro: string; note?: string }) {
    return this.req<{ recorded: unknown }>('/api/admin/ledger', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  raydiumPools(mint1: string, mint2: string) { return this.req<import('./direct/raydiumCpmm.js').RaydiumPoolInfo[]>(`/api/raydium/pools?mint1=${mint1}&mint2=${mint2}`) }
  stats() { return this.req<Record<string, unknown>>('/api/stats') }
  history(wallet: string, limit = 25) { return this.req<import('./history.js').HeliusTx[]>(`/api/history/${wallet}?limit=${limit}`) }
  ohlcv(mint: string, tf: string, limit = 100) { return this.req<{ mint: string; pool: { id: string; name: string } | null; candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[]; reason?: string }>(`/api/terminal/ohlcv/${mint}?tf=${tf}&limit=${limit}`) }
  leaderboard() { return this.req<Record<string, unknown>>('/api/leaderboard') }
}
