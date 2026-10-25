// PRD P11 — strategy definitions persisted in ~/.potswap/strategies.json.

export type StrategyStatus = 'active' | 'paused' | 'completed'

interface Base {
  id: string
  createdAt: string
  status: StrategyStatus
  pausedReason?: string
  nextRunAt: string | null
  consecutiveFailures: number
  totals: { runs: number; volumeUsd: number; feeUsd: number; pointsAdded: number }
  maxSlippageBps?: number
}

export interface DcaStrategy extends Base {
  kind: 'dca'
  inputMint: string
  outputMint: string
  amountPerRun: number
  intervalMinutes: number
  totalRuns?: number
  runsDone: number
}

export interface RebalanceStrategy extends Base {
  kind: 'rebalance'
  targets: Record<string, number> // mint → percent, sums to 100
  driftPct: number
  checkIntervalMinutes: number
  minTradeUsd: number
}

export interface TpSlStrategy extends Base {
  kind: 'tpsl'
  mint: string
  sellPct: number
  exitMint: string
  entryPrice: number
  highWater: number
  takeProfitPct?: number
  stopLossPct?: number
  trailingPct?: number
}

export interface LimitStrategy extends Base {
  kind: 'limit'
  side: 'buy' | 'sell'
  mint: string // the token being bought or sold
  quoteMint: string // SOL by default
  amount: number // input UI units: quoteMint amount for buys, mint amount for sells
  triggerPriceUsd: number
  condition: 'above' | 'below'
  expiresAt?: string
  /** PRD P15.5 — where the price comes from: Potswap's price API (default) or the median of fresh observations. */
  priceSource?: 'potswap' | 'observations'
  /** Minimum distinct publishers for an observation price (default 2). */
  minPublishers?: number
}

export type Strategy = DcaStrategy | RebalanceStrategy | TpSlStrategy | LimitStrategy

export type RunOutcome = 'ok' | 'skipped' | 'failed' | 'dry-run' | 'no-op' | 'completed'

export interface Run {
  id: string
  strategyId: string
  at: string
  action: string // e.g. "buy 0.1 SOL → USDC", "sell 50% BONK → SOL (take-profit)"
  outcome: RunOutcome
  message?: string
  signature?: string
  inAmount?: number
  inputSymbol?: string
  outAmount?: number
  outputSymbol?: string
  feeUsd?: number
  pointsAdded?: number
  solEquivalent?: number
}

export interface StrategyState {
  version: 1
  strategies: Strategy[]
  runs: Run[]
}

export const EMPTY_STATE: StrategyState = { version: 1, strategies: [], runs: [] }
