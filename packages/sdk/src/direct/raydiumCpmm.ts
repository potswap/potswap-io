// PRD P14.5–P14.8 — Raydium CP-Swap (CPMM) direct adapter: decode pool state, quote, build the swap.
// Program: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C. Layouts follow raydium-cp-swap `states/pool.rs` and `config.rs`.
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { sha256 } from '@noble/hashes/sha2.js'
import type { PotswapApi } from '../api.js'
import { PROGRAMS } from '../security/validate.js'

export const CPMM_PROGRAM = new PublicKey(PROGRAMS.raydiumCpmm)
export const AUTH_SEED = 'vault_and_lp_mint_auth_seed'
export const FEE_RATE_DENOMINATOR = 1_000_000n

export interface PoolState {
  ammConfig: string; poolCreator: string; token0Vault: string; token1Vault: string; lpMint: string
  token0Mint: string; token1Mint: string; token0Program: string; token1Program: string; observationKey: string
  authBump: number; status: number; lpMintDecimals: number; mint0Decimals: number; mint1Decimals: number
  lpSupply: bigint; protocolFeesToken0: bigint; protocolFeesToken1: bigint; fundFeesToken0: bigint; fundFeesToken1: bigint; openTime: bigint; recentEpoch: bigint
}
export interface AmmConfig { bump: number; disableCreatePool: boolean; index: number; tradeFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint; createPoolFee: bigint; protocolOwner: string; fundOwner: string }

const pk = (b: Uint8Array, o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58()
const u64 = (b: Uint8Array, o: number) => { let n = 0n; for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[o + i]); return n }

export function decodePoolState(data: Uint8Array): PoolState {
  if (data.length < 8 + 320 + 5 + 56) throw new Error('PoolState account too short')
  const p = (i: number) => pk(data, 8 + 32 * i)
  const o = 8 + 320
  const q = o + 5
  return {
    ammConfig: p(0), poolCreator: p(1), token0Vault: p(2), token1Vault: p(3), lpMint: p(4), token0Mint: p(5), token1Mint: p(6), token0Program: p(7), token1Program: p(8), observationKey: p(9),
    authBump: data[o], status: data[o + 1], lpMintDecimals: data[o + 2], mint0Decimals: data[o + 3], mint1Decimals: data[o + 4],
    lpSupply: u64(data, q), protocolFeesToken0: u64(data, q + 8), protocolFeesToken1: u64(data, q + 16), fundFeesToken0: u64(data, q + 24), fundFeesToken1: u64(data, q + 32), openTime: u64(data, q + 40), recentEpoch: u64(data, q + 48),
  }
}

export function decodeAmmConfig(data: Uint8Array): AmmConfig {
  if (data.length < 8 + 1 + 1 + 2 + 32 + 64) throw new Error('AmmConfig account too short')
  return { bump: data[8], disableCreatePool: data[9] !== 0, index: data[10] | (data[11] << 8), tradeFeeRate: u64(data, 12), protocolFeeRate: u64(data, 20), fundFeeRate: u64(data, 28), createPoolFee: u64(data, 36), protocolOwner: pk(data, 44), fundOwner: pk(data, 76) }
}

/** SPL token account: mint(32) owner(32) amount(u64) … */
export const tokenAccountAmount = (data: Uint8Array) => u64(data, 64)

/** Swap is enabled unless status bit 2 is set; the pool must be open. */
export const swapEnabled = (p: PoolState, nowSec = Math.floor(Date.now() / 1000)) => ((p.status >> 2) & 1) === 0 && Number(p.openTime) <= nowSec

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** raydium-cp-swap curve: trade fee on input (ceil), then constant product with ceil on the new output reserve. */
export function cpmmQuote(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, tradeFeeRate: bigint): { amountOut: bigint; fee: bigint; priceImpactPct: number } {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return { amountOut: 0n, fee: 0n, priceImpactPct: 0 }
  const fee = ceilDiv(amountIn * tradeFeeRate, FEE_RATE_DENOMINATOR)
  const net = amountIn - fee
  const invariant = reserveIn * reserveOut
  const newIn = reserveIn + net
  const newOut = ceilDiv(invariant, newIn)
  const amountOut = reserveOut - newOut
  const spot = Number(reserveOut) / Number(reserveIn)
  const realized = Number(amountOut) / Number(net || 1n)
  return { amountOut: amountOut > 0n ? amountOut : 0n, fee, priceImpactPct: spot > 0 ? Math.max(0, (1 - realized / spot) * 100) : 0 }
}

export const swapBaseInputDiscriminator = () => sha256(new TextEncoder().encode('global:swap_base_input')).slice(0, 8)
export const poolAuthority = () => PublicKey.findProgramAddressSync([Buffer.from(AUTH_SEED)], CPMM_PROGRAM)[0]

export interface SwapIxArgs {
  payer: PublicKey; poolId: PublicKey; pool: PoolState; inputMint: PublicKey; outputMint: PublicKey
  inputTokenAccount: PublicKey; outputTokenAccount: PublicKey; amountIn: bigint; minimumAmountOut: bigint
}

/** `swap_base_input(amount_in, minimum_amount_out)` with the 13 accounts in program order. */
export function buildSwapBaseInput(a: SwapIxArgs): TransactionInstruction {
  const zeroIsInput = a.inputMint.toBase58() === a.pool.token0Mint
  const inputVault = new PublicKey(zeroIsInput ? a.pool.token0Vault : a.pool.token1Vault)
  const outputVault = new PublicKey(zeroIsInput ? a.pool.token1Vault : a.pool.token0Vault)
  const inputProgram = new PublicKey(zeroIsInput ? a.pool.token0Program : a.pool.token1Program)
  const outputProgram = new PublicKey(zeroIsInput ? a.pool.token1Program : a.pool.token0Program)
  const data = new Uint8Array(8 + 8 + 8)
  data.set(swapBaseInputDiscriminator(), 0)
  let x = a.amountIn; for (let i = 0; i < 8; i++) { data[8 + i] = Number(x & 0xffn); x >>= 8n }
  let y = a.minimumAmountOut; for (let i = 0; i < 8; i++) { data[16 + i] = Number(y & 0xffn); y >>= 8n }
  return new TransactionInstruction({
    programId: CPMM_PROGRAM,
    keys: [
      { pubkey: a.payer, isSigner: true, isWritable: false },
      { pubkey: poolAuthority(), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.pool.ammConfig), isSigner: false, isWritable: false },
      { pubkey: a.poolId, isSigner: false, isWritable: true },
      { pubkey: a.inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: inputVault, isSigner: false, isWritable: true },
      { pubkey: outputVault, isSigner: false, isWritable: true },
      { pubkey: inputProgram, isSigner: false, isWritable: false },
      { pubkey: outputProgram, isSigner: false, isWritable: false },
      { pubkey: a.inputMint, isSigner: false, isWritable: false },
      { pubkey: a.outputMint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(a.pool.observationKey), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  })
}

/** Minimal account reader (injected; `rpcFromConnection` provides it). */
export type AccountsReader = (addresses: string[]) => Promise<(Uint8Array | null)[]>

export interface LoadedPool { poolId: string; pool: PoolState; config: AmmConfig; reserve0: bigint; reserve1: bigint; vault0Amount: bigint; vault1Amount: bigint }

export async function loadPool(read: AccountsReader, poolId: string): Promise<LoadedPool | null> {
  const [poolData] = await read([poolId])
  if (!poolData) return null
  const pool = decodePoolState(poolData)
  const [cfg, v0, v1] = await read([pool.ammConfig, pool.token0Vault, pool.token1Vault])
  if (!cfg || !v0 || !v1) return null
  const vault0Amount = tokenAccountAmount(v0), vault1Amount = tokenAccountAmount(v1)
  const reserve0 = vault0Amount - pool.protocolFeesToken0 - pool.fundFeesToken0
  const reserve1 = vault1Amount - pool.protocolFeesToken1 - pool.fundFeesToken1
  return { poolId, pool, config: decodeAmmConfig(cfg), reserve0: reserve0 > 0n ? reserve0 : 0n, reserve1: reserve1 > 0n ? reserve1 : 0n, vault0Amount, vault1Amount }
}

export interface DirectQuote {
  poolId: string
  router: 'raydium-cpmm'
  amountInRaw: string
  potswapFeeRaw: string
  poolFeeRaw: string
  outAmountRaw: string
  priceImpactPct: number
  poolTradeFeeBps: number
  tvlUsd?: number
}

export interface RaydiumPoolInfo { id: string; programId: string; mintA: string; mintB: string; tvl?: number; feeRate?: number }

/** Quote the best CPMM pool for a pair: Potswap fee first (same schedule as the aggregator path), then the pool. */
export async function directQuote(api: PotswapApi, read: AccountsReader, a: { inputMint: string; outputMint: string; amountInRaw: bigint; potswapFeeBps: number }): Promise<DirectQuote | null> {
  const pools = (await api.raydiumPools(a.inputMint, a.outputMint)).filter((p) => p.programId === PROGRAMS.raydiumCpmm).sort((x, y) => (y.tvl ?? 0) - (x.tvl ?? 0))
  if (!pools.length) return null
  let best: DirectQuote | null = null
  for (const info of pools.slice(0, 3)) {
    const lp = await loadPool(read, info.id).catch(() => null)
    if (!lp || !swapEnabled(lp.pool)) continue
    const zeroIsInput = a.inputMint === lp.pool.token0Mint
    if (!zeroIsInput && a.inputMint !== lp.pool.token1Mint) continue
    const reserveIn = zeroIsInput ? lp.reserve0 : lp.reserve1, reserveOut = zeroIsInput ? lp.reserve1 : lp.reserve0
    const potswapFee = (a.amountInRaw * BigInt(a.potswapFeeBps)) / 10_000n
    const q = cpmmQuote(reserveIn, reserveOut, a.amountInRaw - potswapFee, lp.config.tradeFeeRate)
    if (q.amountOut <= 0n) continue
    const dq: DirectQuote = { poolId: info.id, router: 'raydium-cpmm', amountInRaw: a.amountInRaw.toString(), potswapFeeRaw: potswapFee.toString(), poolFeeRaw: q.fee.toString(), outAmountRaw: q.amountOut.toString(), priceImpactPct: q.priceImpactPct, poolTradeFeeBps: Number(lp.config.tradeFeeRate) / 100, tvlUsd: info.tvl }
    if (!best || BigInt(dq.outAmountRaw) > BigInt(best.outAmountRaw)) best = dq
  }
  return best
}

export interface DirectTxArgs {
  payer: PublicKey; feeWallet: PublicKey; lp: LoadedPool; inputMint: PublicKey; outputMint: PublicKey
  amountInRaw: bigint; potswapFeeRaw: bigint; minimumOutRaw: bigint; recentBlockhash: string
}

/** The whole direct swap as one v0 transaction: (wrap SOL) → Potswap fee transfer → output ATA → swap → (unwrap). */
export function buildDirectSwapTx(a: DirectTxArgs): VersionedTransaction {
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })]
  const inIsSol = a.inputMint.equals(NATIVE_MINT), outIsSol = a.outputMint.equals(NATIVE_MINT)
  const inProgram = new PublicKey(a.inputMint.toBase58() === a.lp.pool.token0Mint ? a.lp.pool.token0Program : a.lp.pool.token1Program)
  const outProgram = new PublicKey(a.outputMint.toBase58() === a.lp.pool.token0Mint ? a.lp.pool.token0Program : a.lp.pool.token1Program)
  const inAta = getAssociatedTokenAddressSync(a.inputMint, a.payer, false, inProgram)
  const outAta = getAssociatedTokenAddressSync(a.outputMint, a.payer, false, outProgram)
  const feeAta = getAssociatedTokenAddressSync(a.inputMint, a.feeWallet, true, inProgram)
  const inDecimals = a.inputMint.toBase58() === a.lp.pool.token0Mint ? a.lp.pool.mint0Decimals : a.lp.pool.mint1Decimals
  if (inIsSol) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, inAta, a.payer, NATIVE_MINT))
    ixs.push(SystemProgram.transfer({ fromPubkey: a.payer, toPubkey: inAta, lamports: a.amountInRaw }))
    ixs.push(createSyncNativeInstruction(inAta))
  }
  if (a.potswapFeeRaw > 0n) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, feeAta, a.feeWallet, a.inputMint, inProgram))
    ixs.push(createTransferCheckedInstruction(inAta, a.inputMint, feeAta, a.payer, a.potswapFeeRaw, inDecimals, [], inProgram))
  }
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, outAta, a.payer, a.outputMint, outProgram))
  ixs.push(buildSwapBaseInput({ payer: a.payer, poolId: new PublicKey(a.lp.poolId), pool: a.lp.pool, inputMint: a.inputMint, outputMint: a.outputMint, inputTokenAccount: inAta, outputTokenAccount: outAta, amountIn: a.amountInRaw - a.potswapFeeRaw, minimumAmountOut: a.minimumOutRaw }))
  if (inIsSol) ixs.push(createCloseAccountInstruction(inAta, a.payer, a.payer))
  if (outIsSol) ixs.push(createCloseAccountInstruction(outAta, a.payer, a.payer))
  const msg = new TransactionMessage({ payerKey: a.payer, recentBlockhash: a.recentBlockhash, instructions: ixs }).compileToV0Message()
  return new VersionedTransaction(msg)
}

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID }
