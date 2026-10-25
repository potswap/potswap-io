// PRD P19 — T-131 LP math, T-132 instructions, deposit / withdraw transactions through the validator, lending normalisation.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { sha256 } from '@noble/hashes/sha2.js'
import { buildDepositIx, buildLpDepositTx, buildLpWithdrawTx, buildWithdrawIx, lpDepositMath, lpPosition, lpWithdrawMath, MEMO_PROGRAM, planLpDeposit, up, down } from '../src/direct/raydiumLp.js'
import { loadPool, CPMM_PROGRAM, poolAuthority } from '../src/direct/raydiumCpmm.js'
import { validateTransaction } from '../src/security/validate.js'
import { normalizeMarkets, normalizePositions } from '../src/lend.js'

interface Fixture { poolId: string; accounts: Record<'pool' | 'ammConfig' | 'token0Vault' | 'token1Vault', { data: string }>; decoded: Record<string, string | number> }
const fx = JSON.parse(readFileSync(new URL('./fixtures/cpmm-pool.json', import.meta.url), 'utf8')) as Fixture
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const byAddress: Record<string, Uint8Array> = { [fx.poolId]: bytes(fx.accounts.pool.data), [fx.decoded.ammConfig as string]: bytes(fx.accounts.ammConfig.data), [fx.decoded.token0Vault as string]: bytes(fx.accounts.token0Vault.data), [fx.decoded.token1Vault as string]: bytes(fx.accounts.token1Vault.data) }
const read = async (addrs: string[]) => addrs.map((a) => byAddress[a] ?? null)
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// T-131 (P19.6 / P19.7)
describe('LP math', () => {
  it('lp from token 0 (floor), token 1 needed (ceil), withdraw amounts (floor), slippage bands, pct', () => {
    expect(lpDepositMath(1_000n, 10_000n, 20_000n, 5_000n)).toEqual({ lp: 500n, amount1: 2_000n })
    expect(lpDepositMath(1n, 10_000n, 20_000n, 5_000n)).toEqual({ lp: 0n, amount1: 0n })
    expect(lpDepositMath(1_001n, 10_000n, 30_000n, 7_000n)).toEqual({ lp: 700n, amount1: 3_000n }) // 700·30000/7000 = 3000 exactly
    expect(lpDepositMath(1_000n, 0n, 1n, 1n)).toEqual({ lp: 0n, amount1: 0n })
    expect(lpWithdrawMath(500n, 5_000n, 10_000n, 20_000n)).toEqual({ amount0: 1_000n, amount1: 2_000n })
    expect(up(10_000n, 50)).toBe(10_050n); expect(down(10_000n, 50)).toBe(9_950n)
  })
  it('planLpDeposit takes the fee off the given side and derives the other side from live reserves', async () => {
    const lp = (await loadPool(read, fx.poolId))!
    const plan = planLpDeposit(lp, NATIVE_MINT.toBase58(), 10_000_000n, 250, 50)
    expect(plan.feeRaw).toBe(250_000n); expect(plan.amount0).toBe(9_750_000n)
    expect(plan.lpTokens).toBe((9_750_000n * lp.pool.lpSupply) / lp.reserve0)
    expect(plan.amount1).toBeGreaterThan(0n); expect(plan.max0).toBe(up(plan.amount0, 50)); expect(plan.max1).toBe(up(plan.amount1, 50))
    const other = planLpDeposit(lp, USDC, 1_000_000n, 0, 50)
    expect(other.feeRaw).toBe(0n); expect(other.amount1).toBe(1_000_000n); expect(other.amount0).toBeGreaterThan(0n)
    expect(() => planLpDeposit(lp, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 1n, 0, 50)).toThrow(/pool tokens/)
  })
})

// T-132 (P19.9)
describe('deposit / withdraw instructions', () => {
  it('carry the anchor discriminators, 13 / 14 accounts in order and LE u64 args', async () => {
    const lp = (await loadPool(read, fx.poolId))!
    const owner = Keypair.generate().publicKey, lpAta = Keypair.generate().publicKey, a0 = Keypair.generate().publicKey, a1 = Keypair.generate().publicKey
    const base = { owner, poolId: new PublicKey(fx.poolId), pool: lp.pool, ownerLp: lpAta, token0Account: a0, token1Account: a1 }
    const dep = buildDepositIx({ ...base, lp: 1_000n, max0: 2_000n, max1: 3_000n })
    expect(dep.programId.equals(CPMM_PROGRAM)).toBe(true)
    expect(dep.keys.map((k) => k.pubkey.toBase58())).toEqual([owner.toBase58(), poolAuthority().toBase58(), fx.poolId, lpAta.toBase58(), a0.toBase58(), a1.toBase58(), lp.pool.token0Vault, lp.pool.token1Vault, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', lp.pool.token0Mint, lp.pool.token1Mint, lp.pool.lpMint])
    expect([...dep.data.subarray(0, 8)]).toEqual([...sha256(new TextEncoder().encode('global:deposit')).slice(0, 8)])
    expect(dep.data.readBigUInt64LE(8)).toBe(1_000n); expect(dep.data.readBigUInt64LE(16)).toBe(2_000n); expect(dep.data.readBigUInt64LE(24)).toBe(3_000n)
    const wd = buildWithdrawIx({ ...base, lp: 5n, min0: 6n, min1: 7n })
    expect(wd.keys).toHaveLength(14); expect(wd.keys[13].pubkey.equals(MEMO_PROGRAM)).toBe(true)
    expect([...wd.data.subarray(0, 8)]).toEqual([...sha256(new TextEncoder().encode('global:withdraw')).slice(0, 8)])
    expect(wd.data.readBigUInt64LE(24)).toBe(7n)
  })
  it('deposit tx = budget, wrap SOL side, fee transfer, LP ATA, deposit, unwrap; passes the strict validator; withdraw tx too', async () => {
    const lp = (await loadPool(read, fx.poolId))!
    const payer = Keypair.generate(), feeWallet = Keypair.generate().publicKey
    const plan = planLpDeposit(lp, NATIVE_MINT.toBase58(), 10_000_000n, 250, 50)
    const tx = buildLpDepositTx({ payer: payer.publicKey, lp, plan, feeWallet, recentBlockhash: '11111111111111111111111111111111' })
    const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58())
    expect(programs).toEqual(['ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', CPMM_PROGRAM.toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'])
    expect(validateTransaction(tx, { signer: payer.publicKey.toBase58() })).toMatchObject({ ok: true, unresolved: 0 })
    const noFee = buildLpDepositTx({ payer: payer.publicKey, lp, plan: planLpDeposit(lp, USDC, 1_000_000n, 0, 50), feeWallet: null, recentBlockhash: '11111111111111111111111111111111' })
    expect(noFee.message.compiledInstructions).toHaveLength(7) // budget, wrap(3 for the SOL side), lp ATA, deposit, close wSOL
    const wd = buildLpWithdrawTx({ payer: payer.publicKey, lp, lpAmount: 1_000n, min0: 1n, min1: 1n, recentBlockhash: '11111111111111111111111111111111' })
    expect(validateTransaction(wd, { signer: payer.publicKey.toBase58() }).ok).toBe(true)
    expect(wd.message.compiledInstructions).toHaveLength(5) // budget, ata0, ata1, withdraw, close wSOL
  })
  it('lpPosition reports LP balance and the share of each reserve', async () => {
    const lp = (await loadPool(read, fx.poolId))!
    const pos = (await lpPosition(read, { [lp.pool.lpMint]: 0.00981752 }, fx.poolId))! // the whole supply (9817520 raw, 9 decimals)
    expect(pos.sharePct).toBeCloseTo(100, 2)
    expect(pos.amount0).toBeCloseTo(Number(lp.reserve0) / 1e9, 6); expect(pos.amount1).toBeCloseTo(Number(lp.reserve1) / 1e6, 4)
    expect((await lpPosition(read, {}, fx.poolId))!.lpBalance).toBe(0)
    expect(await lpPosition(read, {}, 'Missing1111111111111111111111111111111111111')).toBeNull()
  })
})

// P19.1 / P19.4 normalisation
describe('lend normalisation', () => {
  const tok = { address: '9BEcn9aP', symbol: 'jlUSDC', assetAddress: USDC, decimals: 6, supplyRate: '460', rewardsRate: '0', totalAssets: '492219208561', asset: { symbol: 'USDC', decimals: 6, price: '1.0001' } }
  it('markets: APY from supplyRate/100, totals in UI units; positions skip zero shares', () => {
    const m = normalizeMarkets([tok])[0]
    expect(m).toMatchObject({ shareToken: '9BEcn9aP', assetMint: USDC, assetSymbol: 'USDC', supplyApyPct: 4.6, rewardsApyPct: 0, priceUsd: 1.0001 })
    expect(m.totalAssets).toBeCloseTo(492_219.208561, 3)
    const p = normalizePositions([{ token: tok, shares: '0' }, { token: tok, shares: '935222', underlyingAssets: '1000000' }])
    expect(p).toHaveLength(1); expect(p[0]).toMatchObject({ assetSymbol: 'USDC', shares: 0.935222, underlying: 1 }); expect(p[0].underlyingUsd).toBeCloseTo(1.0001)
  })
})
