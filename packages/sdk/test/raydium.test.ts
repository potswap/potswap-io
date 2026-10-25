// PRD P14 — T-123 decoding and quote against real on-chain bytes; T-124 the swap instruction; direct quote + tx build.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { sha256 } from '@noble/hashes/sha2.js'
import { buildDirectSwapTx, buildSwapBaseInput, cpmmQuote, decodeAmmConfig, decodePoolState, directQuote, loadPool, poolAuthority, swapEnabled, tokenAccountAmount, CPMM_PROGRAM } from '../src/direct/raydiumCpmm.js'
import { validateTransaction, DEFAULT_ALLOWED_PROGRAMS } from '../src/security/validate.js'
import { PotswapApi } from '../src/api.js'

interface Fixture { poolId: string; accounts: Record<'pool' | 'ammConfig' | 'token0Vault' | 'token1Vault', { owner: string; data: string }>; decoded: Record<string, string | number> }
const fx = JSON.parse(readFileSync(new URL('./fixtures/cpmm-pool.json', import.meta.url), 'utf8')) as Fixture
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const byAddress: Record<string, Uint8Array> = {
  [fx.poolId]: bytes(fx.accounts.pool.data),
  [fx.decoded.ammConfig as string]: bytes(fx.accounts.ammConfig.data),
  [fx.decoded.token0Vault as string]: bytes(fx.accounts.token0Vault.data),
  [fx.decoded.token1Vault as string]: bytes(fx.accounts.token1Vault.data),
}
const read = async (addrs: string[]) => addrs.map((a) => byAddress[a] ?? null)
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// T-123 (P14.5)
describe('Raydium CPMM decoding (real bytes)', () => {
  it('decodes PoolState and AmmConfig to the known on-chain values', () => {
    const p = decodePoolState(byAddress[fx.poolId])
    expect(p).toMatchObject({ ammConfig: fx.decoded.ammConfig, token0Vault: fx.decoded.token0Vault, token1Vault: fx.decoded.token1Vault, token0Mint: NATIVE_MINT.toBase58(), token1Mint: USDC, observationKey: fx.decoded.observationKey, status: 0, mint0Decimals: 9, mint1Decimals: 6 })
    expect(p.protocolFeesToken0).toBe(BigInt(fx.decoded.protocolFeesToken0)); expect(p.fundFeesToken1).toBe(BigInt(fx.decoded.fundFeesToken1))
    const c = decodeAmmConfig(byAddress[fx.decoded.ammConfig as string])
    expect(c).toMatchObject({ index: 5, tradeFeeRate: 3000n, protocolFeeRate: 120000n, fundFeeRate: 40000n })
    expect(tokenAccountAmount(byAddress[fx.decoded.token0Vault as string])).toBe(2870467566n)
    expect(swapEnabled(p)).toBe(true)
    expect(() => decodePoolState(new Uint8Array(10))).toThrow(/too short/)
  })
  it('loadPool nets protocol and fund fees out of the vaults', async () => {
    const lp = (await loadPool(read, fx.poolId))!
    expect(lp.reserve0).toBe(2870467566n - 8152608n - 22688545n)
    expect(lp.reserve1).toBe(289784488n - 713254n - 1460123n)
    expect(await loadPool(read, 'Missing1111111111111111111111111111111111111')).toBeNull()
  })
  it('constant-product quote with the 0.3% pool fee: output rises with input but less than linearly; empty reserves give 0', () => {
    const q1 = cpmmQuote(1_000_000_000n, 100_000_000n, 10_000_000n, 3000n) // 0.01 SOL into a 1 SOL / 100 USDC pool
    expect(q1.fee).toBe(30_000n)
    // net 9_970_000 → out = 100e6 − ceil(1e9·1e8 / 1_009_970_000) = 100_000_000 − 99_012_842 = 987_158 (≈ 0.987 USDC)
    expect(q1.amountOut).toBe(987_158n)
    expect(q1.priceImpactPct).toBeGreaterThan(0.9); expect(q1.priceImpactPct).toBeLessThan(1.1)
    const q2 = cpmmQuote(1_000_000_000n, 100_000_000n, 20_000_000n, 3000n)
    expect(q2.amountOut).toBeGreaterThan(q1.amountOut); expect(q2.amountOut).toBeLessThan(q1.amountOut * 2n)
    expect(cpmmQuote(0n, 1n, 1n, 3000n).amountOut).toBe(0n)
    expect(cpmmQuote(10n, 10n, 0n, 3000n).amountOut).toBe(0n)
  })
})

// T-124 (P14.6)
describe('swap_base_input instruction', () => {
  it('targets the CPMM program with 13 accounts in order, the anchor discriminator and LE u64 args', () => {
    const payer = Keypair.generate().publicKey
    const pool = decodePoolState(byAddress[fx.poolId])
    const inAta = Keypair.generate().publicKey, outAta = Keypair.generate().publicKey
    const ix = buildSwapBaseInput({ payer, poolId: new PublicKey(fx.poolId), pool, inputMint: NATIVE_MINT, outputMint: new PublicKey(USDC), inputTokenAccount: inAta, outputTokenAccount: outAta, amountIn: 1_000_000n, minimumAmountOut: 258n })
    expect(ix.programId.equals(CPMM_PROGRAM)).toBe(true)
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([payer.toBase58(), poolAuthority().toBase58(), pool.ammConfig, fx.poolId, inAta.toBase58(), outAta.toBase58(), pool.token0Vault, pool.token1Vault, pool.token0Program, pool.token1Program, NATIVE_MINT.toBase58(), USDC, pool.observationKey])
    expect(ix.keys[0].isSigner).toBe(true); expect(ix.keys[3].isWritable).toBe(true); expect(ix.keys[12].isWritable).toBe(true)
    expect([...ix.data.subarray(0, 8)]).toEqual([...sha256(new TextEncoder().encode('global:swap_base_input')).slice(0, 8)])
    expect([...ix.data.subarray(8, 16)]).toEqual([0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]); expect(ix.data[16]).toBe(2); expect(ix.data[17]).toBe(1)
    // reversed direction swaps the vault / program order
    const rev = buildSwapBaseInput({ payer, poolId: new PublicKey(fx.poolId), pool, inputMint: new PublicKey(USDC), outputMint: NATIVE_MINT, inputTokenAccount: inAta, outputTokenAccount: outAta, amountIn: 1n, minimumAmountOut: 1n })
    expect(rev.keys[6].pubkey.toBase58()).toBe(pool.token1Vault); expect(rev.keys[7].pubkey.toBase58()).toBe(pool.token0Vault)
  })
})

// P14.7 / P14.8 (SDK level)
describe('direct quote and transaction', () => {
  const api = (pools: unknown) => new PotswapApi('https://t.local', (async (input: RequestInfo | URL) => {
    const u = new URL(String(input))
    if (u.pathname === '/api/raydium/pools') return new Response(JSON.stringify(pools), { headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 404 })
  }) as typeof fetch)
  it('quotes the best CPMM pool net of the Potswap fee, null without a pool', async () => {
    const q = await directQuote(api([{ id: fx.poolId, programId: CPMM_PROGRAM.toBase58(), mintA: NATIVE_MINT.toBase58(), mintB: USDC, tvl: 580 }]), read, { inputMint: NATIVE_MINT.toBase58(), outputMint: USDC, amountInRaw: 10_000_000n, potswapFeeBps: 250 })
    expect(q).toMatchObject({ poolId: fx.poolId, router: 'raydium-cpmm', potswapFeeRaw: '250000', poolTradeFeeBps: 30 })
    expect(BigInt(q!.outAmountRaw)).toBeGreaterThan(0n)
    expect(await directQuote(api([]), read, { inputMint: NATIVE_MINT.toBase58(), outputMint: USDC, amountInRaw: 1n, potswapFeeBps: 250 })).toBeNull()
    expect(await directQuote(api([{ id: fx.poolId, programId: 'other', mintA: '', mintB: '' }]), read, { inputMint: NATIVE_MINT.toBase58(), outputMint: USDC, amountInRaw: 1n, potswapFeeBps: 250 })).toBeNull()
  })
  it('builds a SOL → USDC transaction (wrap, fee, output ATA, swap, unwrap) that passes the validator', async () => {
    const payer = Keypair.generate(), feeWallet = Keypair.generate().publicKey
    const lp = (await loadPool(read, fx.poolId))!
    const tx = buildDirectSwapTx({ payer: payer.publicKey, feeWallet, lp, inputMint: NATIVE_MINT, outputMint: new PublicKey(USDC), amountInRaw: 10_000_000n, potswapFeeRaw: 250_000n, minimumOutRaw: 1n, recentBlockhash: '11111111111111111111111111111111' })
    const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58())
    expect(programs).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // wrap
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // fee
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', CPMM_PROGRAM.toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // out ATA, swap, close wSOL
    ])
    const report = validateTransaction(tx, { signer: payer.publicKey.toBase58(), allowedPrograms: DEFAULT_ALLOWED_PROGRAMS })
    expect(report).toMatchObject({ ok: true, unresolved: 0, instructions: 9 })
    // USDC → SOL unwraps the output
    const back = buildDirectSwapTx({ payer: payer.publicKey, feeWallet, lp, inputMint: new PublicKey(USDC), outputMint: NATIVE_MINT, amountInRaw: 1_000_000n, potswapFeeRaw: 25_000n, minimumOutRaw: 1n, recentBlockhash: '11111111111111111111111111111111' })
    expect(back.message.compiledInstructions).toHaveLength(6) // budget, fee ATA, fee transfer, out ATA, swap, close
  })
})
