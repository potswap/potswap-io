// PRD P19.5–P19.9 — liquidity on Raydium CP-Swap pools: deposit / withdraw math, instructions, transactions, positions.
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { sha256 } from '@noble/hashes/sha2.js'
import type { PotswapApi } from '../api.js'
import { NO_WALLET, SOL_MINT, TOKEN_NOT_ALLOWED } from '../config.js'
import { explorer, fromRaw, toRaw } from '../format.js'
import { checkLimits } from '../limits.js'
import { DEFAULT_ALLOWED_PROGRAMS, validateTransaction, validatorRefusal } from '../security/validate.js'
import type { TradeContext } from '../trade.js'
import { CPMM_PROGRAM, ceilDiv, loadPool, poolAuthority, type AccountsReader, type LoadedPool } from './raydiumCpmm.js'

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const depositDiscriminator = () => sha256(new TextEncoder().encode('global:deposit')).slice(0, 8)
export const withdrawDiscriminator = () => sha256(new TextEncoder().encode('global:withdraw')).slice(0, 8)

export const up = (x: bigint, bps: number) => (x * BigInt(10_000 + bps)) / 10_000n
export const down = (x: bigint, bps: number) => (x * BigInt(10_000 - bps)) / 10_000n

/** LP tokens for a given amount of token 0 and the token 1 needed (ceil), from the current reserves. */
export function lpDepositMath(amount0: bigint, reserve0: bigint, reserve1: bigint, lpSupply: bigint): { lp: bigint; amount1: bigint } {
  if (amount0 <= 0n || reserve0 <= 0n || lpSupply <= 0n) return { lp: 0n, amount1: 0n }
  const lp = (amount0 * lpSupply) / reserve0
  return { lp, amount1: ceilDiv(lp * reserve1, lpSupply) }
}

/** Tokens returned for burning `lp` LP tokens (floor). */
export function lpWithdrawMath(lp: bigint, lpSupply: bigint, reserve0: bigint, reserve1: bigint): { amount0: bigint; amount1: bigint } {
  if (lp <= 0n || lpSupply <= 0n) return { amount0: 0n, amount1: 0n }
  return { amount0: (lp * reserve0) / lpSupply, amount1: (lp * reserve1) / lpSupply }
}

const u64le = (n: bigint) => { const b = new Uint8Array(8); let x = n; for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
const data3 = (disc: Uint8Array, a: bigint, b: bigint, c: bigint) => Buffer.concat([Buffer.from(disc), Buffer.from(u64le(a)), Buffer.from(u64le(b)), Buffer.from(u64le(c))])

export interface LpIxArgs { owner: PublicKey; poolId: PublicKey; pool: LoadedPool['pool']; ownerLp: PublicKey; token0Account: PublicKey; token1Account: PublicKey }

function lpKeys(a: LpIxArgs) {
  return [
    { pubkey: a.owner, isSigner: true, isWritable: false },
    { pubkey: poolAuthority(), isSigner: false, isWritable: false },
    { pubkey: a.poolId, isSigner: false, isWritable: true },
    { pubkey: a.ownerLp, isSigner: false, isWritable: true },
    { pubkey: a.token0Account, isSigner: false, isWritable: true },
    { pubkey: a.token1Account, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(a.pool.token0Vault), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(a.pool.token1Vault), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(a.pool.token0Mint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(a.pool.token1Mint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(a.pool.lpMint), isSigner: false, isWritable: true },
  ]
}

/** `deposit(lp_token_amount, maximum_token_0_amount, maximum_token_1_amount)` — 13 accounts. */
export function buildDepositIx(a: LpIxArgs & { lp: bigint; max0: bigint; max1: bigint }): TransactionInstruction {
  return new TransactionInstruction({ programId: CPMM_PROGRAM, keys: lpKeys(a), data: data3(depositDiscriminator(), a.lp, a.max0, a.max1) })
}
/** `withdraw(lp_token_amount, minimum_token_0_amount, minimum_token_1_amount)` — 14 accounts (adds the Memo program). */
export function buildWithdrawIx(a: LpIxArgs & { lp: bigint; min0: bigint; min1: bigint }): TransactionInstruction {
  return new TransactionInstruction({ programId: CPMM_PROGRAM, keys: [...lpKeys(a), { pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false }], data: data3(withdrawDiscriminator(), a.lp, a.min0, a.min1) })
}

export interface LpDepositPlan {
  poolId: string; lpTokens: bigint; amount0: bigint; amount1: bigint; max0: bigint; max1: bigint
  feeMint: string; feeRaw: bigint; grossRaw: bigint; mint: string
}

/** Plan a deposit from an amount of one side (`mint`); the fee comes off that side first. */
export function planLpDeposit(lp: LoadedPool, mint: string, amountRaw: bigint, feeBps: number, slippageBps: number): LpDepositPlan {
  const feeRaw = (amountRaw * BigInt(feeBps)) / 10_000n
  const net = amountRaw - feeRaw
  const zero = mint === lp.pool.token0Mint
  if (!zero && mint !== lp.pool.token1Mint) throw new Error('mint is not one of the pool tokens')
  let lpTokens: bigint, amount0: bigint, amount1: bigint
  if (zero) { const m = lpDepositMath(net, lp.reserve0, lp.reserve1, lp.pool.lpSupply); lpTokens = m.lp; amount0 = net; amount1 = m.amount1 }
  else { const m = lpDepositMath(net, lp.reserve1, lp.reserve0, lp.pool.lpSupply); lpTokens = m.lp; amount1 = net; amount0 = m.amount1 }
  return { poolId: lp.poolId, lpTokens, amount0, amount1, max0: up(amount0, slippageBps), max1: up(amount1, slippageBps), feeMint: mint, feeRaw, grossRaw: amountRaw, mint }
}

export interface LpTxCommon { payer: PublicKey; lp: LoadedPool; recentBlockhash: string }

export function buildLpDepositTx(a: LpTxCommon & { plan: LpDepositPlan; feeWallet: PublicKey | null }): VersionedTransaction {
  const { pool } = a.lp
  const m0 = new PublicKey(pool.token0Mint), m1 = new PublicKey(pool.token1Mint)
  const p0 = new PublicKey(pool.token0Program), p1 = new PublicKey(pool.token1Program)
  const ata0 = getAssociatedTokenAddressSync(m0, a.payer, false, p0), ata1 = getAssociatedTokenAddressSync(m1, a.payer, false, p1)
  const lpAta = getAssociatedTokenAddressSync(new PublicKey(pool.lpMint), a.payer, false)
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })]
  // wrap the SOL side (gross amount of that side, including a fee that might be taken from it)
  for (const [mint, ata, amount] of [[m0, ata0, a.plan.max0 + (a.plan.feeMint === pool.token0Mint ? a.plan.feeRaw : 0n)], [m1, ata1, a.plan.max1 + (a.plan.feeMint === pool.token1Mint ? a.plan.feeRaw : 0n)]] as [PublicKey, PublicKey, bigint][]) {
    if (mint.equals(NATIVE_MINT)) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, ata, a.payer, NATIVE_MINT))
      ixs.push(SystemProgram.transfer({ fromPubkey: a.payer, toPubkey: ata, lamports: amount }))
      ixs.push(createSyncNativeInstruction(ata))
    }
  }
  if (a.feeWallet && a.plan.feeRaw > 0n) {
    const feeIsZero = a.plan.feeMint === pool.token0Mint
    const fm = feeIsZero ? m0 : m1, fp = feeIsZero ? p0 : p1, src = feeIsZero ? ata0 : ata1
    const dec = feeIsZero ? pool.mint0Decimals : pool.mint1Decimals
    const feeAta = getAssociatedTokenAddressSync(fm, a.feeWallet, true, fp)
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, feeAta, a.feeWallet, fm, fp))
    ixs.push(createTransferCheckedInstruction(src, fm, feeAta, a.payer, a.plan.feeRaw, dec, [], fp))
  }
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, lpAta, a.payer, new PublicKey(pool.lpMint)))
  ixs.push(buildDepositIx({ owner: a.payer, poolId: new PublicKey(a.lp.poolId), pool, ownerLp: lpAta, token0Account: ata0, token1Account: ata1, lp: a.plan.lpTokens, max0: a.plan.max0, max1: a.plan.max1 }))
  if (m0.equals(NATIVE_MINT)) ixs.push(createCloseAccountInstruction(ata0, a.payer, a.payer))
  if (m1.equals(NATIVE_MINT)) ixs.push(createCloseAccountInstruction(ata1, a.payer, a.payer))
  return new VersionedTransaction(new TransactionMessage({ payerKey: a.payer, recentBlockhash: a.recentBlockhash, instructions: ixs }).compileToV0Message())
}

export function buildLpWithdrawTx(a: LpTxCommon & { lpAmount: bigint; min0: bigint; min1: bigint }): VersionedTransaction {
  const { pool } = a.lp
  const m0 = new PublicKey(pool.token0Mint), m1 = new PublicKey(pool.token1Mint)
  const p0 = new PublicKey(pool.token0Program), p1 = new PublicKey(pool.token1Program)
  const ata0 = getAssociatedTokenAddressSync(m0, a.payer, false, p0), ata1 = getAssociatedTokenAddressSync(m1, a.payer, false, p1)
  const lpAta = getAssociatedTokenAddressSync(new PublicKey(pool.lpMint), a.payer, false)
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })]
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, ata0, a.payer, m0, p0))
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, ata1, a.payer, m1, p1))
  ixs.push(buildWithdrawIx({ owner: a.payer, poolId: new PublicKey(a.lp.poolId), pool, ownerLp: lpAta, token0Account: ata0, token1Account: ata1, lp: a.lpAmount, min0: a.min0, min1: a.min1 }))
  if (m0.equals(NATIVE_MINT)) ixs.push(createCloseAccountInstruction(ata0, a.payer, a.payer))
  if (m1.equals(NATIVE_MINT)) ixs.push(createCloseAccountInstruction(ata1, a.payer, a.payer))
  return new VersionedTransaction(new TransactionMessage({ payerKey: a.payer, recentBlockhash: a.recentBlockhash, instructions: ixs }).compileToV0Message())
}

export interface LpPosition { poolId: string; lpMint: string; lpBalance: number; lpBalanceRaw: bigint; sharePct: number; amount0: number; amount1: number; token0Mint: string; token1Mint: string }

export async function lpPosition(read: AccountsReader, balances: Record<string, number>, poolId: string): Promise<LpPosition | null> {
  const lp = await loadPool(read, poolId)
  if (!lp) return null
  const lpBalance = balances[lp.pool.lpMint] ?? 0
  const lpRaw = BigInt(toRaw(lpBalance, lp.pool.lpMintDecimals))
  const m = lpWithdrawMath(lpRaw, lp.pool.lpSupply, lp.reserve0, lp.reserve1)
  return { poolId, lpMint: lp.pool.lpMint, lpBalance, lpBalanceRaw: lpRaw, sharePct: lp.pool.lpSupply > 0n ? Number((lpRaw * 1_000_000n) / lp.pool.lpSupply) / 10_000 : 0, amount0: fromRaw(m.amount0, lp.pool.mint0Decimals), amount1: fromRaw(m.amount1, lp.pool.mint1Decimals), token0Mint: lp.pool.token0Mint, token1Mint: lp.pool.token1Mint }
}

export type LpOutcome =
  | { kind: 'no-wallet' | 'refused' | 'failed'; message: string; signature?: string; explorerUrl?: string }
  | { kind: 'plan'; plan: Record<string, unknown> }
  | { kind: 'dry-run'; plan: Record<string, unknown> }
  | { kind: 'ok'; result: Record<string, unknown> }

const needRpc = (ctx: TradeContext) => ctx.rpc?.getAccountsData ? ctx.rpc : null

/** PRD P19.6 — deposit `amount` (UI units of `mint`) into a CPMM pool; the Potswap fee comes off that side first. */
export async function executeLpDeposit(ctx: TradeContext, a: { poolId: string; mint: string; amount: number; slippageBps?: number; confirm?: boolean }): Promise<LpOutcome> {
  const { api, config, signer } = ctx
  if (!signer) return { kind: 'no-wallet', message: NO_WALLET }
  const rpc = needRpc(ctx)
  if (!rpc) return { kind: 'failed', message: 'Liquidity operations need an RPC connection. No funds were debited.' }
  try {
    const lp = await loadPool(rpc.getAccountsData!.bind(rpc), a.poolId)
    if (!lp) return { kind: 'failed', message: 'Pool not found or not a Raydium CPMM pool. No funds were debited.' }
    const mints = [lp.pool.token0Mint, lp.pool.token1Mint]
    if (!mints.includes(a.mint)) return { kind: 'refused', message: 'mint must be one of the pool tokens. No funds were debited.' }
    if (config.allowedTokens.size && mints.some((m) => !config.allowedTokens.has(m))) return { kind: 'refused', message: TOKEN_NOT_ALLOWED }
    const [cfg, tok, prices, bal] = await Promise.all([api.config(), api.token(a.mint), api.prices([SOL_MINT, a.mint]).catch(() => ({} as Record<string, number>)), ctx.balances(signer.publicKey).catch(() => ({} as Record<string, number>))])
    const amountRaw = BigInt(toRaw(a.amount, tok.decimals))
    const feeBps = cfg.feeWallet ? cfg.fee.standardBps : 0
    const inputUsd = prices[a.mint] ? a.amount * prices[a.mint] : undefined
    const refusal = checkLimits({ amountUi: a.amount, inputMint: a.mint, inputSymbol: tok.symbol, isSol: a.mint === SOL_MINT, inputUsd, solUsd: prices[SOL_MINT], slippageBps: a.slippageBps, maxTradeSol: config.maxTradeSol, maxSlippageBps: config.maxSlippageBps, balanceUi: bal[a.mint] ?? 0 })
    if (refusal) return { kind: 'refused', message: refusal }
    const slippage = a.slippageBps ?? 50
    const plan = planLpDeposit(lp, a.mint, amountRaw, feeBps, slippage)
    const otherMint = a.mint === lp.pool.token0Mint ? lp.pool.token1Mint : lp.pool.token0Mint
    const otherNeeded = a.mint === lp.pool.token0Mint ? plan.max1 : plan.max0
    const otherDec = a.mint === lp.pool.token0Mint ? lp.pool.mint1Decimals : lp.pool.mint0Decimals
    if ((bal[otherMint] ?? 0) < fromRaw(otherNeeded, otherDec)) return { kind: 'refused', message: `Insufficient ${otherMint === SOL_MINT ? 'SOL' : otherMint.slice(0, 4) + '…'}: the pool needs up to ${fromRaw(otherNeeded, otherDec)} alongside your ${a.amount} ${tok.symbol}. No funds were debited.` }
    const summary = { poolId: a.poolId, lpTokens: fromRaw(plan.lpTokens, lp.pool.lpMintDecimals), amount0: fromRaw(plan.amount0, lp.pool.mint0Decimals), amount1: fromRaw(plan.amount1, lp.pool.mint1Decimals), token0Mint: lp.pool.token0Mint, token1Mint: lp.pool.token1Mint, feeBps, fee: fromRaw(plan.feeRaw, tok.decimals), feeMint: a.mint, slippageBps: slippage, feeNote: cfg.feeWallet ? undefined : 'No fee wallet published: no fee charged and no points for this deposit.' }
    if (!a.confirm) return { kind: 'plan', plan: summary }
    if (config.dryRun) return { kind: 'dry-run', plan: summary }
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed')
    const tx = buildLpDepositTx({ payer: new PublicKey(signer.publicKey), lp, plan, feeWallet: cfg.feeWallet ? new PublicKey(cfg.feeWallet) : null, recentBlockhash: blockhash })
    const report = validateTransaction(tx, { signer: signer.publicKey, allowedPrograms: new Set([...DEFAULT_ALLOWED_PROGRAMS, ...config.allowedPrograms]) })
    if (!report.ok) return { kind: 'refused', message: validatorRefusal(report) }
    signer.sign(tx)
    const signature = await rpc.sendRawTransaction(tx.serialize())
    const conf = await rpc.confirmTransaction(signature, blockhash, lastValidBlockHeight)
    if (conf.err) return { kind: 'failed', message: `Deposit failed on-chain: ${JSON.stringify(conf.err)}. No funds were debited. Check ${explorer(signature)}`, signature, explorerUrl: explorer(signature) }
    const feeUsd = inputUsd !== undefined ? (inputUsd * feeBps) / 10_000 : undefined
    return { kind: 'ok', result: { ...summary, signature, explorerUrl: explorer(signature), feeUsd, pointsAdded: cfg.feeWallet ? feeUsd : 0 } }
  } catch (e) { return { kind: 'failed', message: `${e instanceof Error ? e.message : String(e)} No funds were debited.` } }
}

/** PRD P19.7 — burn LP tokens (an amount or a percentage of the balance); no fee. */
export async function executeLpWithdraw(ctx: TradeContext, a: { poolId: string; lpAmount?: number; pct?: number; slippageBps?: number; confirm?: boolean }): Promise<LpOutcome> {
  const { config, signer } = ctx
  if (!signer) return { kind: 'no-wallet', message: NO_WALLET }
  const rpc = needRpc(ctx)
  if (!rpc) return { kind: 'failed', message: 'Liquidity operations need an RPC connection. No funds were debited.' }
  try {
    const bal = await ctx.balances(signer.publicKey).catch(() => ({} as Record<string, number>))
    const pos = await lpPosition(rpc.getAccountsData!.bind(rpc), bal, a.poolId)
    if (!pos) return { kind: 'failed', message: 'Pool not found or not a Raydium CPMM pool. No funds were debited.' }
    const lp = (await loadPool(rpc.getAccountsData!.bind(rpc), a.poolId))!
    const slippage = a.slippageBps ?? 50
    if (slippage > config.maxSlippageBps) return { kind: 'refused', message: `Refused by safety limit: slippage ${slippage / 100}% is above POTSWAP_MAX_SLIPPAGE_BPS (${config.maxSlippageBps / 100}%). No funds were debited.` }
    let lpRaw: bigint
    if (a.lpAmount !== undefined) lpRaw = BigInt(toRaw(a.lpAmount, lp.pool.lpMintDecimals))
    else if (a.pct !== undefined) lpRaw = (pos.lpBalanceRaw * BigInt(Math.round(Math.min(100, Math.max(0, a.pct)) * 100))) / 10_000n
    else return { kind: 'refused', message: 'Give lpAmount or pct. No funds were debited.' }
    if (lpRaw <= 0n) return { kind: 'refused', message: 'Nothing to withdraw. No funds were debited.' }
    if (lpRaw > pos.lpBalanceRaw) return { kind: 'refused', message: `Insufficient LP tokens: balance ${pos.lpBalance}. No funds were debited.` }
    const m = lpWithdrawMath(lpRaw, lp.pool.lpSupply, lp.reserve0, lp.reserve1)
    const summary = { poolId: a.poolId, lpTokens: fromRaw(lpRaw, lp.pool.lpMintDecimals), expected0: fromRaw(m.amount0, lp.pool.mint0Decimals), expected1: fromRaw(m.amount1, lp.pool.mint1Decimals), token0Mint: lp.pool.token0Mint, token1Mint: lp.pool.token1Mint, slippageBps: slippage, fee: 0 }
    if (!a.confirm) return { kind: 'plan', plan: summary }
    if (config.dryRun) return { kind: 'dry-run', plan: summary }
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed')
    const tx = buildLpWithdrawTx({ payer: new PublicKey(signer.publicKey), lp, lpAmount: lpRaw, min0: down(m.amount0, slippage), min1: down(m.amount1, slippage), recentBlockhash: blockhash })
    const report = validateTransaction(tx, { signer: signer.publicKey, allowedPrograms: new Set([...DEFAULT_ALLOWED_PROGRAMS, ...config.allowedPrograms]) })
    if (!report.ok) return { kind: 'refused', message: validatorRefusal(report) }
    signer.sign(tx)
    const signature = await rpc.sendRawTransaction(tx.serialize())
    const conf = await rpc.confirmTransaction(signature, blockhash, lastValidBlockHeight)
    if (conf.err) return { kind: 'failed', message: `Withdrawal failed on-chain: ${JSON.stringify(conf.err)}. No funds were debited. Check ${explorer(signature)}`, signature, explorerUrl: explorer(signature) }
    return { kind: 'ok', result: { ...summary, signature, explorerUrl: explorer(signature) } }
  } catch (e) { return { kind: 'failed', message: `${e instanceof Error ? e.message : String(e)} No funds were debited.` } }
}

export interface LpPoolInfo { poolId: string; token0Mint: string; token1Mint: string; reserve0: number; reserve1: number; lpSupply: number; tradeFeeBps: number; tvlUsd?: number; swapEnabled: boolean }

/** PRD P19.5 — CPMM pools for a pair with live reserves. */
export async function lpPools(api: PotswapApi, read: AccountsReader, mintA: string, mintB: string): Promise<LpPoolInfo[]> {
  const pools = (await api.raydiumPools(mintA, mintB)).filter((p) => p.programId === CPMM_PROGRAM.toBase58())
  const out: LpPoolInfo[] = []
  for (const p of pools.slice(0, 5)) {
    const lp = await loadPool(read, p.id).catch(() => null)
    if (!lp) continue
    out.push({ poolId: p.id, token0Mint: lp.pool.token0Mint, token1Mint: lp.pool.token1Mint, reserve0: fromRaw(lp.reserve0, lp.pool.mint0Decimals), reserve1: fromRaw(lp.reserve1, lp.pool.mint1Decimals), lpSupply: fromRaw(lp.pool.lpSupply, lp.pool.lpMintDecimals), tradeFeeBps: Number(lp.config.tradeFeeRate) / 100, tvlUsd: p.tvl, swapEnabled: ((lp.pool.status >> 2) & 1) === 0 })
  }
  return out
}
