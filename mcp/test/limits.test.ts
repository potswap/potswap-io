import { describe, expect, it } from 'vitest'
import { checkLimits } from '@potswap_io/sdk'

const base = { inputMint: 'X', inputSymbol: 'X', isSol: false, maxTradeSol: 1, maxSlippageBps: 300 }

// T-63 (PRD P10.6)
describe('checkLimits', () => {
  it('passes a normal trade', () => {
    expect(checkLimits({ ...base, amountUi: 0.5, isSol: true, balanceUi: 2 })).toBeNull()
    expect(checkLimits({ ...base, amountUi: 50, inputUsd: 50, solUsd: 100, balanceUi: 100 })).toBeNull()
  })
  it('refuses non-positive amounts', () => {
    expect(checkLimits({ ...base, amountUi: 0 })).toMatch(/positive number/)
  })
  it('caps by SOL-equivalent using prices', () => {
    expect(checkLimits({ ...base, amountUi: 150, inputUsd: 150, solUsd: 100 })).toMatch(/≈ 1\.500 SOL is above POTSWAP_MAX_TRADE_SOL \(1\)/)
  })
  it('lets unpriced tokens through the cap (no basis to refuse) but still checks balance', () => {
    expect(checkLimits({ ...base, amountUi: 1e9 })).toBeNull()
    expect(checkLimits({ ...base, amountUi: 5, balanceUi: 4 })).toMatch(/Insufficient X balance/)
  })
  it('hints about raw units for absurd SOL amounts', () => {
    expect(checkLimits({ ...base, amountUi: 1_000_000_000, isSol: true })).toMatch(/not lamports/)
  })
  it('caps slippage', () => {
    expect(checkLimits({ ...base, amountUi: 0.1, isSol: true, slippageBps: 301 })).toMatch(/slippage 3\.01%/)
    expect(checkLimits({ ...base, amountUi: 0.1, isSol: true, slippageBps: 300 })).toBeNull()
  })
  it('keeps the SOL reserve', () => {
    expect(checkLimits({ ...base, amountUi: 0.995, isSol: true, balanceUi: 1 })).toMatch(/keep at least 0\.01 SOL/)
    expect(checkLimits({ ...base, amountUi: 0.99, isSol: true, balanceUi: 1 })).toBeNull()
  })
})
