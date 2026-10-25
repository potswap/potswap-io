// T-110 (P16.1) — the SDK's public surface and dependency boundary.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as sdk from '../src/index.js'

describe('@potswap_io/sdk', () => {
  it('exports the documented surface from one entry point', () => {
    for (const name of ['PotswapApi', 'ApiError', 'buildQuote', 'executeSwap', 'executeTransfer', 'rpcFromConnection', 'checkLimits', 'redact', 'redactValue', 'registerSecret', 'loadSigner', 'createWallet', 'normalizeHistory', 'mapSignatureStatus', 'computePositions', 'createRuntime', 'rpcBalances', 'loadConfig', 'DEFAULTS', 'SOL_MINT', 'USDC_MINT', 'JITOSOL_MINT', 'MSOL_MINT', 'NO_WALLET', 'TOKEN_NOT_ALLOWED', 'RECIPIENT_NOT_ALLOWED', 'FileStore', 'MemoryStore', 'acquireLock', 'Scheduler', 'findStrategy', 'runsOf', 'nextRunAfter', 'limitDecision', 'rebalancePlan', 'tpslDecision', 'feeBpsFor', 'parseFeeSchedule', 'DEFAULT_FEE_SCHEDULE', 'riskBadges', 'riskLevel', 'friendlyError', 'toRaw', 'fromRaw', 'levelLabel']) {
      expect(sdk, name).toHaveProperty(name)
    }
  })
  it('has no MCP or zod dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    const deps = Object.keys(pkg.dependencies)
    expect(deps).toEqual(['@noble/curves', '@noble/hashes', '@solana/spl-token', '@solana/web3.js', 'bs58'])
    expect(deps).not.toContain('@modelcontextprotocol/sdk'); expect(deps).not.toContain('zod')
  })
  it('config defaults match the MCP contract', () => {
    const c = sdk.loadConfig({})
    expect(c).toMatchObject({ maxTradeSol: 1, maxSlippageBps: 300, maxDailySol: 5, dryRun: false, apiBase: 'https://www.potswap.io' })
    expect(sdk.levelLabel({ level: 'Queen', multiplier: 1.25 })).toBe('Queen ×1.25')
    expect(sdk.levelLabel(undefined)).toBe('Larva ×1')
  })
})
