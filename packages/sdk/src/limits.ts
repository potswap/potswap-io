// PRD P10.6 — safety limits applied before anything is signed.
import { DEFAULTS } from './config.js'

export interface LimitInput {
  amountUi: number
  inputMint: string
  inputSymbol: string
  inputUsd?: number // USD value of the trade, when a price is known
  solUsd?: number
  isSol: boolean
  slippageBps?: number
  maxTradeSol: number
  maxSlippageBps: number
  balanceUi?: number
}

export function checkLimits(i: LimitInput): string | null {
  if (!(i.amountUi > 0)) return 'Amount must be a positive number in UI units (1 = 1 SOL). No funds were debited.'
  if (i.slippageBps !== undefined && i.slippageBps > i.maxSlippageBps) {
    return `Refused by safety limit: slippage ${i.slippageBps / 100}% is above POTSWAP_MAX_SLIPPAGE_BPS (${i.maxSlippageBps / 100}%). No funds were debited.`
  }
  const solEquivalent = i.isSol ? i.amountUi : i.inputUsd !== undefined && i.solUsd ? i.inputUsd / i.solUsd : undefined
  if (solEquivalent !== undefined && solEquivalent > i.maxTradeSol) {
    const hint = i.amountUi >= 1_000_000 ? ' Hint: amount is in UI units (1 = 1 SOL), not lamports.' : ''
    return `Refused by safety limit: ${i.amountUi} ${i.inputSymbol} ≈ ${solEquivalent.toFixed(3)} SOL is above POTSWAP_MAX_TRADE_SOL (${i.maxTradeSol}).${hint} No funds were debited.`
  }
  if (i.balanceUi !== undefined) {
    const spendable = i.isSol ? Math.max(i.balanceUi - DEFAULTS.solReserve, 0) : i.balanceUi
    if (i.amountUi > spendable) {
      return i.isSol
        ? `Insufficient SOL: balance ${i.balanceUi.toFixed(4)}, keep at least ${DEFAULTS.solReserve} SOL for fees. No funds were debited.`
        : `Insufficient ${i.inputSymbol} balance (${i.balanceUi}). No funds were debited.`
    }
  }
  return null
}
