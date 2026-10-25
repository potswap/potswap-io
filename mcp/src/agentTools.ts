// PRD P13 — Tier 1 agent tools: wallet, transfer, history, positions with PnL, staking, price history.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Connection } from '@solana/web3.js'
import { z } from 'zod'
import type { PotswapApi } from '@potswap_io/sdk'
import { JITOSOL_MINT, MSOL_MINT, NO_WALLET, SOL_MINT, type Config } from '@potswap_io/sdk'
import { redact, redactValue } from '@potswap_io/sdk'
import { createWallet } from '@potswap_io/sdk'
import { executeSwap, type TradeContext } from '@potswap_io/sdk'
import { executeTransfer, rpcFromConnection, type Rpc } from '@potswap_io/sdk'
import { mapSignatureStatus, normalizeHistory, type HeliusTx } from '@potswap_io/sdk'
import { computePositions } from '@potswap_io/sdk'

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
const ok = (data: Record<string, unknown>, summary?: string): ToolResult => ({ content: [{ type: 'text', text: redact(summary ?? JSON.stringify(data, null, 2)) }], structuredContent: redactValue(data) })
const fail = (message: string, extra: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: 'text', text: redact(message) }], structuredContent: redactValue({ error: message, ...extra }), isError: true })
const MINT = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

/** Transaction-level RPC reads; injectable for tests. */
export interface TxRpc {
  getSignatureStatus(sig: string): Promise<{ confirmationStatus?: string; err?: unknown; slot?: number } | null>
  getParsedTransaction(sig: string): Promise<{ slot: number; fee: number; err: unknown; preBalances: number[]; postBalances: number[]; accountKeys: string[]; preTokenBalances: { mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }[]; postTokenBalances: { mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }[] } | null>
}

export function txRpcFromConnection(conn: Connection): TxRpc {
  return {
    async getSignatureStatus(sig) { const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }); const s = r.value[0]; return s ? { confirmationStatus: s.confirmationStatus ?? undefined, err: s.err, slot: s.slot } : null },
    async getParsedTransaction(sig) {
      const t = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      if (!t?.meta) return null
      return {
        slot: t.slot, fee: t.meta.fee, err: t.meta.err, preBalances: t.meta.preBalances, postBalances: t.meta.postBalances,
        accountKeys: t.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()),
        preTokenBalances: (t.meta.preTokenBalances ?? []).map((b) => ({ mint: b.mint, owner: b.owner, uiTokenAmount: { uiAmount: b.uiTokenAmount.uiAmount } })),
        postTokenBalances: (t.meta.postTokenBalances ?? []).map((b) => ({ mint: b.mint, owner: b.owner, uiTokenAmount: { uiAmount: b.uiTokenAmount.uiAmount } })),
      }
    },
  }
}

export interface AgentToolDeps {
  trade: TradeContext
  config: Config
  rpc?: Rpc
  txRpc?: TxRpc
  schedulerActive?: () => boolean
}

export function registerAgentTools(server: McpServer, deps: AgentToolDeps) {
  const { trade, config } = deps
  const api: PotswapApi = trade.api
  const conn = () => new Connection(config.rpcUrl, 'confirmed')
  const rpc = deps.rpc ?? rpcFromConnection(conn())
  const txRpc = deps.txRpc ?? txRpcFromConnection(conn())
  const walletOr = (w?: string) => w ?? trade.signer?.publicKey ?? null

  server.registerTool('wallet_create', {
    title: 'Create an agent wallet',
    description: 'Generates a new keypair and stores it in the Potswap state directory (0600). Only when no wallet is configured. Returns the public key; the secret key is never shown. Back up the file.',
    inputSchema: { confirm: z.boolean().default(false) },
  }, async ({ confirm }) => {
    if (trade.signer) return fail(`A wallet is already configured (${trade.signer.publicKey}). Nothing was created.`)
    if (!confirm) return fail('Set confirm=true to create a wallet. Nothing was created.')
    try {
      const { signer, file } = createWallet(config.stateDir)
      trade.signer = signer
      return ok({ publicKey: signer.publicKey, file, backup: 'Copy this file somewhere safe; it is the only copy of the secret key.' },
        `Wallet created: ${signer.publicKey}\nSecret stored at ${file} (0600). Fund it with SOL to start; keep ≥ 0.01 SOL for fees.`)
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('get_wallet', {
    title: 'Wallet, limits and status',
    description: 'Public key, funding instructions, configured limits and allowlists, scheduler status.',
    inputSchema: {},
  }, async () => ok({
    publicKey: trade.signer?.publicKey ?? null,
    fund: trade.signer ? `Send SOL to ${trade.signer.publicKey}. Keep at least 0.01 SOL for network fees.` : NO_WALLET,
    limits: { maxTradeSol: config.maxTradeSol, maxDailySol: config.maxDailySol, maxSlippageBps: config.maxSlippageBps, dryRun: config.dryRun },
    allowedTokens: [...config.allowedTokens], allowedRecipients: [...config.allowedRecipients],
    schedulerActive: !!deps.schedulerActive?.(), stateDir: config.stateDir, api: config.apiBase, rpc: config.rpcUrl.replace(/api-key=[^&]+/, 'api-key=***'),
  }))

  server.registerTool('transfer', {
    title: 'Transfer SOL or a token (no Potswap fee)',
    description: 'Sends SOL or an SPL token from the agent wallet. Requires confirm=true. Subject to POTSWAP_ALLOWED_RECIPIENTS, the per-trade cap and the SOL reserve. Every error states whether funds were debited.',
    inputSchema: { to: z.string().min(32).max(44), mint: MINT.optional(), amount: z.number().positive(), confirm: z.boolean().default(false) },
  }, async (a) => {
    const out = await executeTransfer({
      config, signer: trade.signer, rpc, balances: trade.balances, prices: (m) => api.prices(m),
      decimalsOf: async (m) => (await api.token(m)).decimals,
    }, { to: a.to, mint: a.mint, amount: a.amount, confirm: a.confirm })
    if (out.kind === 'ok') return ok({ signature: out.signature, explorerUrl: out.explorerUrl }, `${out.summary}. ${out.explorerUrl}`)
    if (out.kind === 'quote-only' || out.kind === 'dry-run') return ok({ [out.kind === 'dry-run' ? 'dryRun' : 'confirmRequired']: true }, out.summary)
    return fail(out.message)
  })

  server.registerTool('get_transaction', {
    title: 'Transaction status',
    description: 'Status (processed / confirmed / finalized / failed / not found), slot, fee and the wallet balance changes for a signature.',
    inputSchema: { signature: z.string().min(64).max(90), wallet: MINT.optional() },
  }, async ({ signature, wallet }) => {
    try {
      const st = await txRpc.getSignatureStatus(signature)
      const status = mapSignatureStatus(st)
      const data: Record<string, unknown> = { signature, status, slot: st?.slot ?? null, explorerUrl: `https://solscan.io/tx/${signature}` }
      if (status === 'confirmed' || status === 'finalized' || status === 'failed') {
        const t = await txRpc.getParsedTransaction(signature)
        if (t) {
          const w = walletOr(wallet)
          const idx = w ? t.accountKeys.indexOf(w) : -1
          data.feeSol = t.fee / 1e9
          data.error = t.err ?? null
          if (idx >= 0) data.solChange = (t.postBalances[idx] - t.preBalances[idx]) / 1e9
          if (w) {
            const pre = Object.fromEntries(t.preTokenBalances.filter((b) => b.owner === w).map((b) => [b.mint, b.uiTokenAmount.uiAmount ?? 0]))
            const post = Object.fromEntries(t.postTokenBalances.filter((b) => b.owner === w).map((b) => [b.mint, b.uiTokenAmount.uiAmount ?? 0]))
            const mints = new Set([...Object.keys(pre), ...Object.keys(post)])
            data.tokenChanges = [...mints].map((m) => ({ mint: m, change: (post[m] ?? 0) - (pre[m] ?? 0) })).filter((c) => c.change !== 0)
          }
        }
      }
      return ok(data, `${signature.slice(0, 8)}… ${status}${data.solChange !== undefined ? ` · SOL ${(data.solChange as number) >= 0 ? '+' : ''}${data.solChange}` : ''}`)
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('get_history', {
    title: 'Recent transactions',
    description: 'Parsed recent transactions for a wallet (swaps, transfers, other), newest first.',
    inputSchema: { wallet: MINT.optional(), limit: z.number().int().min(1).max(100).default(25) },
  }, async ({ wallet, limit }) => {
    const w = walletOr(wallet)
    if (!w) return fail(NO_WALLET)
    try {
      const raw = await api.history(w, limit)
      const items = normalizeHistory(raw, w)
      return ok({ wallet: w, items }, items.map((i) => `${i.time} ${i.kind}${i.failed ? ' (failed)' : ''}: ${i.kind === 'swap' ? `${i.inAmount} ${short(i.inMint)} → ${i.outAmount} ${short(i.outMint)}` : i.kind === 'transfer' ? `${i.direction} ${i.amount} ${short(i.mint)} ${i.direction === 'out' ? 'to' : 'from'} ${i.counterparty}` : i.source ?? ''} ${i.signature.slice(0, 8)}…`).join('\n') || 'No transactions yet.')
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('get_price_history', {
    title: 'Price history (OHLCV)',
    description: 'Candles for a token from its top pool. Timeframes: 1m, 5m, 15m, 1h, 4h, 1d.',
    inputSchema: { mint: MINT, timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('15m'), limit: z.number().int().min(1).max(1000).default(100) },
  }, async ({ mint, timeframe, limit }) => {
    try {
      const d = await api.ohlcv(mint, timeframe, limit)
      const c = d.candles
      return ok(d as unknown as Record<string, unknown>, c.length ? `${c.length} ${timeframe} candles · last close ${c[c.length - 1].close} · range ${Math.min(...c.map((x) => x.low))}–${Math.max(...c.map((x) => x.high))}` : d.reason ?? 'No candles')
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  const stakeTool = (name: string, title: string, description: string, from: (p: 'jito' | 'marinade') => string, to: (p: 'jito' | 'marinade') => string) =>
    server.registerTool(name, { title, description, inputSchema: { amount: z.number().positive(), provider: z.enum(['jito', 'marinade']).default('jito'), confirm: z.boolean().default(false), maxSlippageBps: z.number().int().min(1).max(5000).optional() } },
      async (a) => {
        const out = await executeSwap(trade, { inputMint: from(a.provider), outputMint: to(a.provider), amount: a.amount, slippageBps: a.maxSlippageBps, confirm: a.confirm })
        switch (out.kind) {
          case 'no-wallet': return fail(out.message)
          case 'refused': return fail(out.message, { quote: out.quote })
          case 'quote-only': return ok({ confirmRequired: true, quote: out.quote }, `Quote only (confirm=true to execute): ${a.amount} ${out.quote.inputSymbol} → ${out.quote.outAmount} ${out.quote.outputSymbol}`)
          case 'dry-run': return ok({ dryRun: true, quote: out.quote }, `DRY RUN: ${a.amount} ${out.quote.inputSymbol} → ${out.quote.outAmount} ${out.quote.outputSymbol}`)
          case 'failed': return fail(out.message, { signature: out.signature })
          case 'ok': return ok({ ...out.result }, `${name === 'stake_sol' ? 'Staked' : 'Unstaked'}: ${a.amount} ${out.result.inputSymbol} → ${out.result.outAmount} ${out.result.outputSymbol}. ${out.result.explorerUrl}`)
        }
      })
  const lst = (p: 'jito' | 'marinade') => (p === 'jito' ? JITOSOL_MINT : MSOL_MINT)
  stakeTool('stake_sol', 'Liquid-stake SOL', 'Swaps SOL into jitoSOL (Jito) or mSOL (Marinade) at the best route. Normal fee and points apply. Requires confirm=true.', () => SOL_MINT, lst)
  stakeTool('unstake_sol', 'Unstake liquid SOL', 'Swaps jitoSOL or mSOL back into SOL at the best route. Normal fee and points apply. Requires confirm=true.', lst, () => SOL_MINT)

  // PRD P12.1 / P12.6a — launch meter, season, splits and the public claim pressure.
  server.registerTool('get_launch_status', {
    title: 'POT launch status',
    description: 'Launch-pool meter (SOL collected / target, read from chain), current season and day, fee split in force, total unclaimed reward balances and the pending claim ladder. Only protocol fees fill the pool; nothing can be deposited.',
    inputSchema: {},
  }, async () => {
    try {
      const pool = await api.launchPool()
      const stats = await api.stats().catch(() => ({} as Record<string, unknown>))
      const season = pool.season as { n: number; dayIndex: number | null; end: string | null } | undefined
      const data = { ...pool, unclaimedSol: stats.unclaimedSol ?? null, claimLadder: stats.claimLadder ?? [], potDistributedMicro: stats.potDistributedMicro ?? null }
      const line = pool.launch && Date.parse(String(pool.launch)) <= Date.now()
        ? `POT launched ${pool.launch}. Season ${season?.n}${season?.dayIndex ? ` day ${season.dayIndex}/30` : ''}${season?.end ? `, ends ${season.end}` : ''}.`
        : `Launch pool: ${pool.balanceSol} / ${pool.targetSol} SOL (${Math.round(Number(pool.pct))}%)${pool.enabled ? '' : ' — pool address not published yet'}. Season 0: 60% of every net fee fills the pool; 20% builds your reward balance.`
      return ok(data, `${line}${data.unclaimedSol !== null && data.unclaimedSol !== undefined ? ` Unclaimed reward balances: ${data.unclaimedSol} SOL.` : ''}`)
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  // Upgraded positions with PnL (P13.7): replaces the basic tool registered by the core server.
  server.registerTool('get_positions', {
    title: 'Positions with PnL',
    description: 'Token holdings with USD value, average cost, unrealised and realised PnL from the wallet\'s swap history.',
    inputSchema: { wallet: MINT.optional() },
  }, async ({ wallet }) => {
    const w = walletOr(wallet)
    if (!w) return fail(NO_WALLET)
    try {
      const [bal, raw] = await Promise.all([trade.balances(w), api.history(w, 100).catch(() => [] as HeliusTx[])])
      const history = normalizeHistory(raw, w)
      const mints = [...new Set([...Object.keys(bal), ...history.flatMap((h) => [h.inMint, h.outMint]).filter((m): m is string => !!m)])].slice(0, 50)
      const prices = await api.prices(mints).catch(() => ({} as Record<string, number>))
      const positions = computePositions(history, bal, prices)
      return ok({ wallet: w, sol: bal[SOL_MINT] ?? 0, solUsd: prices[SOL_MINT] ? (bal[SOL_MINT] ?? 0) * prices[SOL_MINT] : undefined, positions },
        positions.map((p) => `${short(p.mint)}: ${p.amount}${p.valueUsd !== undefined ? ` ($${p.valueUsd.toFixed(2)})` : ''}${p.unrealisedUsd !== undefined ? ` unrealised ${p.unrealisedUsd >= 0 ? '+' : ''}$${p.unrealisedUsd.toFixed(2)}` : ''}${p.realisedUsd ? ` realised ${p.realisedUsd >= 0 ? '+' : ''}$${p.realisedUsd.toFixed(2)}` : ''}`).join('\n') || 'No positions.')
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })
}

const short = (m?: string) => (!m ? '?' : m === SOL_MINT ? 'SOL' : m === JITOSOL_MINT ? 'jitoSOL' : m === MSOL_MINT ? 'mSOL' : m.slice(0, 4) + '…')
