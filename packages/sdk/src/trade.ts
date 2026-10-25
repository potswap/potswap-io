// Swap execution shared by the `swap` tool (P10) and the strategy scheduler (P11).
// One path: quote → limits → fresh order as taker → local signature → execute.
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import type { PotswapApi } from './api.js'
import type { Rpc } from './transfer.js'
import { nowIso, replayDecision, type OpsStore } from './ops.js'
import { DEFAULT_ALLOWED_PROGRAMS, validateTransaction, validatorRefusal } from './security/validate.js'
import { buildDirectSwapTx, directQuote, loadPool, type DirectQuote } from './direct/raydiumCpmm.js'
import { NO_WALLET, SOL_MINT, TOKEN_NOT_ALLOWED, type Config } from './config.js'
import { checkLimits } from './limits.js'
import { explorer, fromRaw, toRaw } from './format.js'
import type { Signer } from './wallet.js'
import { describeOrderError, friendlyError } from './shared/errors.js'
import { feeBpsFor } from './shared/fee.js'

export type BalancesFn = (wallet: string) => Promise<Record<string, number>>

export interface TradeContext {
  api: PotswapApi
  config: Config
  signer: Signer | null
  balances: BalancesFn
  /** RPC for direct routes (send / confirm / account reads). Optional: without it direct quotes and swaps are unavailable. */
  rpc?: Rpc
  /** Idempotent operation records (P14.3). Optional. */
  ops?: OpsStore
}

export interface SwapArgs {
  inputMint: string
  outputMint: string
  amount: number // UI units of the input
  slippageBps?: number
  confirm?: boolean
  /** Extra SOL-equivalent already spent in the current window (strategies' daily cap). */
  extraSolCap?: { remainingSol: number; label: string }
  /** PRD P14 — `jupiter` (default), `direct` (Raydium CPMM pool) or `auto` (better net output). */
  route?: 'jupiter' | 'direct' | 'auto'
  /** PRD P14.3 — caller-supplied id that makes the swap safe to retry. */
  opId?: string
}

export interface Quote {
  inputMint: string; inputSymbol: string; outputMint: string; outputSymbol: string
  inAmount: number; inAmountRaw: string; outAmount: number; price: number
  priceImpactPct?: number; slippageBps?: number; feeBps: number
  feeTier: string | null; feeLabel: string | null; scheduledFeeBps: number; inputUsd?: number
  router: string; requestId: string; expiresAt: string | null
  /** PRD P14.7 — the best direct CPMM pool, net of the same Potswap fee; null when none / unavailable. */
  direct?: { poolId: string; router: 'raydium-cpmm'; outAmount: number; priceImpactPct: number; poolTradeFeeBps: number; savedVsAggregatorPct: number; tvlUsd?: number } | null
}

export interface SwapOk {
  signature: string; explorerUrl: string; inAmount: number; inputSymbol: string; outAmount: number; outputSymbol: string
  router: string; feeBps: number; feeUsd?: number; pointsAdded?: number; solEquivalent?: number
  opId?: string; replayed?: boolean
}

export type SwapOutcome =
  | { kind: 'no-wallet'; message: string }
  | { kind: 'refused'; message: string; quote: Quote }
  | { kind: 'quote-only'; quote: Quote }
  | { kind: 'dry-run'; quote: Quote }
  | { kind: 'failed'; message: string; quote?: Quote; signature?: string; explorerUrl?: string }
  | { kind: 'ok'; result: SwapOk; quote: Quote }

export async function buildQuote(api: PotswapApi, a: { inputMint: string; outputMint: string; amount: number; slippageBps?: number }, opts: { direct?: Rpc } = {}): Promise<Quote> {
  const [inTok, outTok, cfg, px] = await Promise.all([
    api.token(a.inputMint), api.token(a.outputMint), api.config(), api.prices([a.inputMint]).catch(() => ({} as Record<string, number>)),
  ])
  const inAmountRaw = toRaw(a.amount, inTok.decimals)
  // PRD P8.12–P8.15: the fee tier depends on the USD value of the input at quote time.
  const inputUsd = px[a.inputMint] ? a.amount * px[a.inputMint] : undefined
  const feeDecision = feeBpsFor(cfg.fee, inputUsd)
  const o = await api.order({ inputMint: a.inputMint, outputMint: a.outputMint, amount: inAmountRaw, slippageBps: a.slippageBps, feeBps: feeDecision.bps })
  if (o.errorMessage && !o.outAmount) throw new Error(`${describeOrderError(o)} No funds were debited.`)
  const outAmount = fromRaw(o.outAmount, outTok.decimals)
  let direct: Quote['direct'] = null
  if (opts.direct?.getAccountsData) {
    try {
      const dq = await directQuote(api, opts.direct.getAccountsData.bind(opts.direct), { inputMint: a.inputMint, outputMint: a.outputMint, amountInRaw: BigInt(inAmountRaw), potswapFeeBps: cfg.referralAccount || cfg.feeWallet ? feeDecision.bps : 0 })
      if (dq) { const dOut = fromRaw(dq.outAmountRaw, outTok.decimals); direct = { poolId: dq.poolId, router: 'raydium-cpmm', outAmount: dOut, priceImpactPct: dq.priceImpactPct, poolTradeFeeBps: dq.poolTradeFeeBps, savedVsAggregatorPct: outAmount > 0 ? ((dOut - outAmount) / outAmount) * 100 : 0, tvlUsd: dq.tvlUsd } }
    } catch { direct = null }
  }
  return {
    inputMint: a.inputMint, inputSymbol: inTok.symbol, outputMint: a.outputMint, outputSymbol: outTok.symbol,
    inAmount: a.amount, inAmountRaw, outAmount, price: outAmount / a.amount,
    priceImpactPct: o.priceImpactPct !== undefined ? Math.abs(Number(o.priceImpactPct)) : undefined,
    slippageBps: o.slippageBps, feeBps: o.platformFee?.feeBps ?? o.feeBps ?? 0,
    feeTier: cfg.referralAccount ? feeDecision.tier : null, feeLabel: cfg.referralAccount ? feeDecision.label : null,
    scheduledFeeBps: feeDecision.bps, inputUsd, router: o.router, requestId: o.requestId, expiresAt: o.expireAt ?? null, direct,
  }
}

export async function executeSwap(ctx: TradeContext, a: SwapArgs): Promise<SwapOutcome> {
  const { api, config, signer } = ctx
  if (!signer) return { kind: 'no-wallet', message: NO_WALLET }
  if (config.allowedTokens.size && (!config.allowedTokens.has(a.inputMint) || !config.allowedTokens.has(a.outputMint))) {
    return { kind: 'failed', message: TOKEN_NOT_ALLOWED }
  }
  // P14.3 — idempotency
  const ops = a.opId && ctx.ops ? ctx.ops : undefined
  if (a.opId && ops) {
    const d = replayDecision(ops.get(a.opId))
    if (d.kind === 'replay') return { kind: 'ok', result: { ...(d.record.result as unknown as SwapOk), opId: a.opId, replayed: true }, quote: d.record.quote as unknown as Quote }
    if (d.kind === 'blocked') return { kind: 'failed', message: d.message, signature: d.record.signature, explorerUrl: d.record.signature ? explorer(d.record.signature) : undefined }
  }
  const mark = (state: 'pending' | 'sent' | 'ok' | 'failed' | 'unknown', extra: { signature?: string; result?: SwapOk; quote?: Quote; error?: string } = {}) => {
    if (!ops || !a.opId) return
    const prev = ops.get(a.opId)
    ops.put({ id: a.opId, kind: 'swap', state, createdAt: prev?.createdAt ?? nowIso(), updatedAt: nowIso(), args: { inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, route: a.route ?? 'jupiter' }, signature: extra.signature ?? prev?.signature, result: (extra.result as unknown as Record<string, unknown>) ?? prev?.result, quote: (extra.quote as unknown as Record<string, unknown>) ?? prev?.quote, error: extra.error })
  }
  try {
    const wantDirect = a.route === 'direct' || a.route === 'auto'
    const quote = await buildQuote(api, a, wantDirect && ctx.rpc ? { direct: ctx.rpc } : {})
    const prices = await api.prices([SOL_MINT, a.inputMint]).catch(() => ({} as Record<string, number>))
    let balanceUi: number | undefined
    try { balanceUi = (await ctx.balances(signer.publicKey))[a.inputMint] ?? 0 } catch { balanceUi = undefined }
    const inputUsd = prices[a.inputMint] ? a.amount * prices[a.inputMint] : undefined
    const solEquivalent = a.inputMint === SOL_MINT ? a.amount : inputUsd !== undefined && prices[SOL_MINT] ? inputUsd / prices[SOL_MINT] : undefined
    const refusal = checkLimits({
      amountUi: a.amount, inputMint: a.inputMint, inputSymbol: quote.inputSymbol, isSol: a.inputMint === SOL_MINT,
      inputUsd, solUsd: prices[SOL_MINT], slippageBps: a.slippageBps,
      maxTradeSol: config.maxTradeSol, maxSlippageBps: config.maxSlippageBps, balanceUi,
    })
    if (refusal) return { kind: 'refused', message: refusal, quote }
    if (a.extraSolCap && solEquivalent !== undefined && solEquivalent > a.extraSolCap.remainingSol) {
      return { kind: 'refused', message: `${a.extraSolCap.label} No funds were debited.`, quote }
    }
    if (!a.confirm) return { kind: 'quote-only', quote }
    if (config.dryRun) return { kind: 'dry-run', quote }

    const useDirect = a.route === 'direct' || (a.route === 'auto' && !!quote.direct && quote.direct.outAmount > quote.outAmount)
    if (useDirect) return await executeDirect(ctx, a, quote, { inputUsd, solEquivalent, mark })

    const order = await api.order({ inputMint: a.inputMint, outputMint: a.outputMint, amount: quote.inAmountRaw, taker: signer.publicKey, slippageBps: a.slippageBps, feeBps: quote.scheduledFeeBps })
    if (!order.transaction) return { kind: 'failed', message: `${describeOrderError(order)} No funds were debited.`, quote }
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'))
    // P14.1 — validate before signing; Jupiter orders legitimately use lookup tables for DEX programs.
    const report = validateTransaction(tx, { signer: signer.publicKey, allowedPrograms: new Set([...DEFAULT_ALLOWED_PROGRAMS, ...config.allowedPrograms]), allowUnresolved: true, maxLamportsToUnknown: BigInt(toRaw(a.amount, 9)) })
    if (!report.ok) return { kind: 'refused', message: validatorRefusal(report), quote }
    signer.sign(tx)
    mark('pending', { quote })
    let res: Awaited<ReturnType<typeof api.execute>>
    try { res = await api.execute(Buffer.from(tx.serialize()).toString('base64'), order.requestId) }
    catch (e) {
      // The transaction may have been sent; we cannot tell. P14.4
      mark('unknown', { error: e instanceof Error ? e.message : String(e) })
      return { kind: 'failed', message: `${friendlyError(e instanceof Error ? e.message : String(e))} The transaction may have been sent; check get_transaction${a.opId ? ` (operation ${a.opId})` : ''} before retrying. Funds may have been debited.`, quote }
    }
    if (res.status !== 'Success') {
      mark('failed', { signature: res.signature, error: res.error || `code ${res.code}` })
      return { kind: 'failed', message: friendlyError(res.error || `Swap failed (code ${res.code})`), quote, signature: res.signature, explorerUrl: res.signature ? explorer(res.signature) : undefined }
    }
    const outDec = (await api.token(a.outputMint)).decimals
    const outAmount = fromRaw(res.totalOutputAmount ?? order.outAmount, outDec)
    const feeBps = order.platformFee?.feeBps ?? order.feeBps ?? 0
    const feeUsd = inputUsd !== undefined ? inputUsd * feeBps / 10_000 : undefined
    const cfg = await api.config()
    const result: SwapOk = {
      signature: res.signature!, explorerUrl: explorer(res.signature!), inAmount: a.amount, inputSymbol: quote.inputSymbol,
      outAmount, outputSymbol: quote.outputSymbol, router: order.router, feeBps, feeUsd, pointsAdded: cfg.referralAccount ? feeUsd : 0, solEquivalent, ...(a.opId ? { opId: a.opId } : {}),
    }
    mark('ok', { signature: result.signature, result })
    return { kind: 'ok', result, quote }
  } catch (e) {
    return { kind: 'failed', message: friendlyError(e instanceof Error ? e.message : String(e)) }
  }
}

/** PRD P14.8 — the direct Raydium CPMM path: build locally, validate, sign, send and confirm through RPC. */
async function executeDirect(ctx: TradeContext, a: SwapArgs, quote: Quote, x: { inputUsd?: number; solEquivalent?: number; mark: (state: 'pending' | 'sent' | 'ok' | 'failed' | 'unknown', extra?: { signature?: string; result?: SwapOk; quote?: Quote; error?: string }) => void }): Promise<SwapOutcome> {
  const { api, config, signer } = ctx
  if (!signer) return { kind: 'no-wallet', message: NO_WALLET }
  const rpc = ctx.rpc
  if (!rpc?.getAccountsData) return { kind: 'failed', message: 'Direct route is not available without an RPC connection. No funds were debited.', quote }
  if (!quote.direct) return { kind: 'failed', message: 'No direct Raydium CPMM pool for this pair right now; use the aggregator route. No funds were debited.', quote }
  const cfg = await api.config()
  if (!cfg.feeWallet) return { kind: 'failed', message: 'Direct route is not enabled yet: Potswap has not published its fee wallet. The aggregator route works as usual. No funds were debited.', quote }
  const lp = await loadPool(rpc.getAccountsData.bind(rpc), quote.direct.poolId)
  if (!lp) return { kind: 'failed', message: 'The direct pool could not be read; try again or use the aggregator route. No funds were debited.', quote }
  const outTok = await api.token(a.outputMint)
  const amountInRaw = BigInt(quote.inAmountRaw)
  const potswapFeeRaw = (amountInRaw * BigInt(quote.scheduledFeeBps)) / 10_000n
  const slippage = a.slippageBps ?? 50
  const expectedOutRaw = BigInt(toRaw(quote.direct.outAmount, outTok.decimals))
  const minimumOutRaw = (expectedOutRaw * BigInt(10_000 - slippage)) / 10_000n
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed')
  const tx = buildDirectSwapTx({ payer: new PublicKey(signer.publicKey), feeWallet: new PublicKey(cfg.feeWallet), lp, inputMint: new PublicKey(a.inputMint), outputMint: new PublicKey(a.outputMint), amountInRaw, potswapFeeRaw, minimumOutRaw, recentBlockhash: blockhash })
  const report = validateTransaction(tx, { signer: signer.publicKey, allowedPrograms: new Set([...DEFAULT_ALLOWED_PROGRAMS, ...config.allowedPrograms]), allowUnresolved: false })
  if (!report.ok) return { kind: 'refused', message: validatorRefusal(report), quote }
  signer.sign(tx)
  x.mark('pending', { quote })
  let signature: string
  try { signature = await rpc.sendRawTransaction(tx.serialize()) }
  catch (e) { x.mark('failed', { error: e instanceof Error ? e.message : String(e) }); return { kind: 'failed', message: `${friendlyError(e instanceof Error ? e.message : String(e))} No funds were debited.`, quote } }
  x.mark('sent', { signature })
  try {
    const conf = await rpc.confirmTransaction(signature, blockhash, lastValidBlockHeight)
    if (conf.err) { x.mark('failed', { signature, error: JSON.stringify(conf.err) }); return { kind: 'failed', message: `Swap failed on-chain: ${JSON.stringify(conf.err)}. No funds were debited. Check ${explorer(signature)}`, quote, signature, explorerUrl: explorer(signature) } }
  } catch (e) {
    x.mark('unknown', { signature, error: e instanceof Error ? e.message : String(e) })
    return { kind: 'failed', message: `The transaction was sent but its confirmation could not be read. Check ${explorer(signature)}; funds may have been debited.`, quote, signature, explorerUrl: explorer(signature) }
  }
  const feeUsd = x.inputUsd !== undefined ? (x.inputUsd * quote.scheduledFeeBps) / 10_000 : undefined
  const result: SwapOk = { signature, explorerUrl: explorer(signature), inAmount: a.amount, inputSymbol: quote.inputSymbol, outAmount: quote.direct.outAmount, outputSymbol: quote.outputSymbol, router: 'raydium-cpmm', feeBps: quote.scheduledFeeBps, feeUsd, pointsAdded: feeUsd, solEquivalent: x.solEquivalent, ...(a.opId ? { opId: a.opId } : {}) }
  x.mark('ok', { signature, result })
  return { kind: 'ok', result, quote }
}
