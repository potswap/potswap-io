// PRD P10 / P13 — configuration from environment variables.
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  apiBase: string
  rpcUrl: string
  maxTradeSol: number
  /** SOL-equivalent all strategies together may spend per UTC day (PRD P11.6). */
  maxDailySol: number
  maxSlippageBps: number
  dryRun: boolean
  privateKey?: string
  keypairPath?: string
  /** Where strategies, run logs and a created wallet live. */
  stateDir: string
  /** When non-empty, swaps/strategies/staking may only touch these mints (PRD P13.4). */
  allowedTokens: Set<string>
  /** When non-empty, `transfer` may only send to these addresses (PRD P13.3). */
  allowedRecipients: Set<string>
  /** PRD P14.1 — extra program ids the transaction validator accepts (comma-separated POTSWAP_ALLOWED_PROGRAMS). */
  allowedPrograms: Set<string>
}

export const DEFAULTS = {
  apiBase: 'https://www.potswap.io',
  maxTradeSol: 1,
  maxDailySol: 5,
  maxSlippageBps: 300,
  solReserve: 0.01,
}

const list = (v?: string) => new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiBase = (env.POTSWAP_API || DEFAULTS.apiBase).replace(/\/$/, '')
  const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d }
  return {
    apiBase,
    rpcUrl: env.SOLANA_RPC_URL || `${apiBase}/api/rpc`,
    maxTradeSol: num(env.POTSWAP_MAX_TRADE_SOL, DEFAULTS.maxTradeSol),
    maxDailySol: num(env.POTSWAP_MAX_DAILY_SOL, DEFAULTS.maxDailySol),
    maxSlippageBps: num(env.POTSWAP_MAX_SLIPPAGE_BPS, DEFAULTS.maxSlippageBps),
    dryRun: /^(1|true|yes)$/i.test(env.POTSWAP_DRY_RUN ?? ''),
    privateKey: env.SOLANA_PRIVATE_KEY || undefined,
    keypairPath: env.SOLANA_KEYPAIR_PATH || undefined,
    stateDir: env.POTSWAP_STATE_DIR || join(homedir(), '.potswap'),
    allowedTokens: list(env.POTSWAP_ALLOWED_TOKENS),
    allowedRecipients: list(env.POTSWAP_ALLOWED_RECIPIENTS),
    allowedPrograms: list(env.POTSWAP_ALLOWED_PROGRAMS),
  }
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
export const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
export const NO_WALLET = 'Wallet not configured. Set SOLANA_PRIVATE_KEY or SOLANA_KEYPAIR_PATH, or run wallet_create. No funds were debited.'
export const TOKEN_NOT_ALLOWED = 'Token not in POTSWAP_ALLOWED_TOKENS. No funds were debited.'
export const RECIPIENT_NOT_ALLOWED = 'Recipient not in POTSWAP_ALLOWED_RECIPIENTS. No funds were debited.'

/** PRD P12.11 — "Bee ×1.1" style label for a points level object (tolerates missing data). */
export function levelLabel(l: unknown): string {
  const x = (l ?? {}) as { level?: string; multiplier?: number }
  return `${x.level ?? 'Larva'} ×${x.multiplier ?? 1}`
}
