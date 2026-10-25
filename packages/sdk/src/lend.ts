// PRD P19.1–P19.4 — lending through Jupiter Lend Earn: markets, deposit, withdraw, positions.
// Transactions come from Jupiter (through Potswap's proxy), pass the validator, are signed locally and sent through RPC.
// Entries pay the Potswap fee as a separate transfer after the deposit confirms (see PRD P19 for why it is not atomic).
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import type { PotswapApi } from './api.js'
import { NO_WALLET, SOL_MINT, TOKEN_NOT_ALLOWED } from './config.js'
import { explorer, fromRaw, toRaw } from './format.js'
import { checkLimits } from './limits.js'
import { DEFAULT_ALLOWED_PROGRAMS, PROGRAMS, validateTransaction, validatorRefusal } from './security/validate.js'
import type { TradeContext } from './trade.js'

export interface LendMarket { shareToken: string; symbol: string; assetMint: string; assetSymbol: string; decimals: number; supplyApyPct: number; rewardsApyPct: number; totalAssets: number; priceUsd?: number }
export interface LendPosition { shareToken: string; symbol: string; assetMint: string; assetSymbol: string; shares: number; underlying: number; underlyingUsd?: number }

export type RawLendToken = { address: string; symbol: string; assetAddress: string; decimals: number; supplyRate: string | number; rewardsRate?: string | number; totalAssets: string; asset?: { symbol?: string; decimals?: number; price?: string } }
export type RawLendPosition = { token: RawLendToken; shares: string; underlyingAssets?: string; underlyingBalance?: string; ownerAddress?: string }
type RawToken = RawLendToken

export function normalizeMarkets(raw: RawToken[]): LendMarket[] {
  return raw.map((t) => ({
    shareToken: t.address, symbol: t.symbol, assetMint: t.assetAddress, assetSymbol: t.asset?.symbol ?? t.symbol.replace(/^jl/, ''), decimals: t.asset?.decimals ?? t.decimals,
    supplyApyPct: Number(t.supplyRate) / 100, rewardsApyPct: Number(t.rewardsRate ?? 0) / 100,
    totalAssets: fromRaw(t.totalAssets || '0', t.asset?.decimals ?? t.decimals), priceUsd: t.asset?.price !== undefined ? Number(t.asset.price) : undefined,
  }))
}

export function normalizePositions(raw: RawLendPosition[]): LendPosition[] {
  return raw.filter((p) => p.shares && p.shares !== '0').map((p) => {
    const dec = p.token.asset?.decimals ?? p.token.decimals
    const underlying = fromRaw(p.underlyingAssets || p.underlyingBalance || '0', dec)
    const price = p.token.asset?.price !== undefined ? Number(p.token.asset.price) : undefined
    return { shareToken: p.token.address, symbol: p.token.symbol, assetMint: p.token.assetAddress, assetSymbol: p.token.asset?.symbol ?? p.token.symbol.replace(/^jl/, ''), shares: fromRaw(p.shares, p.token.decimals), underlying, underlyingUsd: price !== undefined ? underlying * price : undefined }
  })
}

export type LendOutcome =
  | { kind: 'no-wallet' | 'refused' | 'failed'; message: string; signature?: string; explorerUrl?: string }
  | { kind: 'plan'; plan: Record<string, unknown> }
  | { kind: 'dry-run'; plan: Record<string, unknown> }
  | { kind: 'ok'; result: Record<string, unknown> }

export interface LendArgs { action: 'deposit' | 'withdraw'; mint: string; amount: number | 'all'; confirm?: boolean }

export async function executeLend(ctx: TradeContext, a: LendArgs): Promise<LendOutcome> {
  const { api, config, signer } = ctx
  if (!signer) return { kind: 'no-wallet', message: NO_WALLET }
  if (config.allowedTokens.size && !config.allowedTokens.has(a.mint)) return { kind: 'refused', message: TOKEN_NOT_ALLOWED }
  const rpc = ctx.rpc
  if (!rpc) return { kind: 'failed', message: 'Lending needs an RPC connection. No funds were debited.' }
  try {
    const markets = normalizeMarkets(await api.lendTokens())
    const market = markets.find((m) => m.assetMint === a.mint)
    if (!market) return { kind: 'failed', message: `No Jupiter Lend Earn market for this token. Markets: ${markets.map((m) => m.assetSymbol).join(', ')}. No funds were debited.` }
    let amount: number
    if (a.amount === 'all') {
      if (a.action === 'deposit') return { kind: 'refused', message: "'all' is only valid for withdrawals. No funds were debited." }
      const pos = normalizePositions(await api.lendPositions([signer.publicKey])).find((p) => p.assetMint === a.mint)
      if (!pos || pos.underlying <= 0) return { kind: 'refused', message: `No ${market.assetSymbol} Earn position to withdraw. No funds were debited.` }
      amount = pos.underlying
    } else amount = a.amount
    if (!(amount > 0)) return { kind: 'refused', message: 'Amount must be positive. No funds were debited.' }
    const amountRaw = toRaw(amount, market.decimals)
    const [cfg, prices, bal] = await Promise.all([api.config(), api.prices([SOL_MINT, a.mint]).catch(() => ({} as Record<string, number>)), a.action === 'deposit' ? ctx.balances(signer.publicKey).catch(() => ({} as Record<string, number>)) : Promise.resolve({} as Record<string, number>)])
    const inputUsd = prices[a.mint] ? amount * prices[a.mint] : undefined
    const feeBps = a.action === 'deposit' && cfg.feeWallet ? cfg.fee.standardBps : 0
    if (a.action === 'deposit') {
      const refusal = checkLimits({ amountUi: amount, inputMint: a.mint, inputSymbol: market.assetSymbol, isSol: a.mint === SOL_MINT, inputUsd, solUsd: prices[SOL_MINT], slippageBps: undefined, maxTradeSol: config.maxTradeSol, maxSlippageBps: config.maxSlippageBps, balanceUi: bal[a.mint] ?? 0 })
      if (refusal) return { kind: 'refused', message: refusal }
    }
    const plan = { action: a.action, market: market.symbol, assetMint: a.mint, assetSymbol: market.assetSymbol, amount, supplyApyPct: market.supplyApyPct, feeBps, fee: (amount * feeBps) / 10_000, feeNote: a.action === 'deposit' && !cfg.feeWallet ? 'No fee wallet published: no fee charged and no points for this deposit.' : a.action === 'withdraw' ? 'Withdrawals are free.' : 'The fee is sent as a separate transfer after the deposit confirms.' }
    if (!a.confirm) return { kind: 'plan', plan }
    if (config.dryRun) return { kind: 'dry-run', plan }

    const { transaction } = await api.lendTx(a.action, { asset: a.mint, signer: signer.publicKey, amount: amountRaw })
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'))
    const report = validateTransaction(tx, { signer: signer.publicKey, allowedPrograms: new Set([...DEFAULT_ALLOWED_PROGRAMS, ...config.allowedPrograms]), allowUnresolved: true, maxLamportsToUnknown: a.mint === SOL_MINT ? BigInt(amountRaw) : 0n })
    if (!report.ok) return { kind: 'refused', message: validatorRefusal(report) }
    signer.sign(tx)
    const bh = await rpc.getLatestBlockhash('confirmed')
    const signature = await rpc.sendRawTransaction(tx.serialize())
    const conf = await rpc.confirmTransaction(signature, bh.blockhash, bh.lastValidBlockHeight)
    if (conf.err) return { kind: 'failed', message: `${a.action === 'deposit' ? 'Deposit' : 'Withdrawal'} failed on-chain: ${JSON.stringify(conf.err)}. No funds were debited. Check ${explorer(signature)}`, signature, explorerUrl: explorer(signature) }

    // P19 fee: a separate transfer after a successful deposit.
    let feeSignature: string | undefined, feeCollected = false, feeNote = plan.feeNote
    if (a.action === 'deposit' && feeBps > 0 && cfg.feeWallet) {
      try {
        const feeRaw = (BigInt(amountRaw) * BigInt(feeBps)) / 10_000n
        const feeTx = buildFeeTransfer({ payer: new PublicKey(signer.publicKey), feeWallet: new PublicKey(cfg.feeWallet), mint: a.mint, amountRaw: feeRaw, decimals: market.decimals, recentBlockhash: bh.blockhash, tokenProgram: tx.message.staticAccountKeys.some((k) => k.equals(TOKEN_2022_PROGRAM_ID)) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID })
        const feeReport = validateTransaction(feeTx, { signer: signer.publicKey, allowedRecipients: new Set([cfg.feeWallet]) })
        if (!feeReport.ok) throw new Error(feeReport.reasons.join('; '))
        signer.sign(feeTx)
        feeSignature = await rpc.sendRawTransaction(feeTx.serialize())
        const fc = await rpc.confirmTransaction(feeSignature, bh.blockhash, bh.lastValidBlockHeight)
        feeCollected = !fc.err
        if (fc.err) feeNote = `The deposit succeeded but the fee transfer failed on-chain (${JSON.stringify(fc.err)}); no points for this deposit.`
      } catch (e) { feeNote = `The deposit succeeded but the fee transfer could not be sent (${e instanceof Error ? e.message : String(e)}); no points for this deposit.` }
    }
    const feeUsd = feeCollected && inputUsd !== undefined ? (inputUsd * feeBps) / 10_000 : 0
    return { kind: 'ok', result: { ...plan, signature, explorerUrl: explorer(signature), feeSignature, feeCollected, feeNote, feeUsd, pointsAdded: feeUsd } }
  } catch (e) { return { kind: 'failed', message: `${e instanceof Error ? e.message : String(e)} No funds were debited.` } }
}

function buildFeeTransfer(a: { payer: PublicKey; feeWallet: PublicKey; mint: string; amountRaw: bigint; decimals: number; recentBlockhash: string; tokenProgram: PublicKey }): VersionedTransaction {
  const ixs = a.mint === SOL_MINT
    ? [SystemProgram.transfer({ fromPubkey: a.payer, toPubkey: a.feeWallet, lamports: a.amountRaw })]
    : (() => { const m = new PublicKey(a.mint); const src = getAssociatedTokenAddressSync(m, a.payer, false, a.tokenProgram); const dst = getAssociatedTokenAddressSync(m, a.feeWallet, true, a.tokenProgram); return [createAssociatedTokenAccountIdempotentInstruction(a.payer, dst, a.feeWallet, m, a.tokenProgram), createTransferCheckedInstruction(src, m, dst, a.payer, a.amountRaw, a.decimals, [], a.tokenProgram)] })()
  return new VersionedTransaction(new TransactionMessage({ payerKey: a.payer, recentBlockhash: a.recentBlockhash, instructions: ixs }).compileToV0Message())
}

export const JUP_LEND_PROGRAM = PROGRAMS.jupiterLend
