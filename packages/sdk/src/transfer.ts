// PRD P13.2/P13.3 — SOL and SPL transfers built locally, no Potswap fee, recipient allowlist + caps.
import { Connection, PublicKey, SystemProgram, Transaction, type Commitment } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DEFAULTS, NO_WALLET, RECIPIENT_NOT_ALLOWED, SOL_MINT, type Config } from './config.js'
import type { Signer } from './wallet.js'
import { toRaw } from './format.js'

/** Minimal RPC surface so tests can mock it. */
export interface Rpc {
  getLatestBlockhash(commitment?: Commitment): Promise<{ blockhash: string; lastValidBlockHeight: number }>
  getAccountOwner(address: string): Promise<string | null> // program owning the account, null if missing
  sendRawTransaction(raw: Uint8Array): Promise<string>
  confirmTransaction(sig: string, blockhash: string, lastValidBlockHeight: number): Promise<{ err: unknown | null }>
  /** Raw account data for several addresses (direct routing reads pool state); optional for test doubles. */
  getAccountsData?(addresses: string[]): Promise<(Uint8Array | null)[]>
}

export function rpcFromConnection(conn: Connection): Rpc {
  return {
    getLatestBlockhash: (c) => conn.getLatestBlockhash(c ?? 'confirmed'),
    getAccountOwner: async (a) => { const info = await conn.getAccountInfo(new PublicKey(a)); return info ? info.owner.toBase58() : null },
    sendRawTransaction: (raw) => conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }),
    confirmTransaction: async (signature, blockhash, lastValidBlockHeight) => { const r = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed'); return { err: r.value.err } },
    getAccountsData: async (addresses) => (await conn.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)))).map((i) => (i ? new Uint8Array(i.data) : null)),
  }
}

export interface TransferArgs { to: string; mint?: string; amount: number; decimals?: number; confirm: boolean }

export type TransferOutcome =
  | { kind: 'no-wallet' | 'refused' | 'failed'; message: string }
  | { kind: 'quote-only'; summary: string }
  | { kind: 'dry-run'; summary: string }
  | { kind: 'ok'; signature: string; explorerUrl: string; summary: string }

export interface TransferContext {
  config: Config
  signer: Signer | null
  rpc: Rpc
  balances: (wallet: string) => Promise<Record<string, number>>
  prices: (mints: string[]) => Promise<Record<string, number>>
  decimalsOf: (mint: string) => Promise<number>
  /** Program that owns the mint (Token vs Token-2022); defaults to the classic Token program. */
  getMintOwner?: (mint: string) => Promise<string | null>
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export async function executeTransfer(ctx: TransferContext, a: TransferArgs): Promise<TransferOutcome> {
  const { config, signer } = ctx
  if (!signer) return { kind: 'no-wallet', message: NO_WALLET }
  if (!BASE58.test(a.to)) return { kind: 'refused', message: 'Invalid recipient address. No funds were debited.' }
  if (config.allowedRecipients.size && !config.allowedRecipients.has(a.to)) return { kind: 'refused', message: RECIPIENT_NOT_ALLOWED }
  if (!(a.amount > 0)) return { kind: 'refused', message: 'Amount must be positive. No funds were debited.' }
  const mint = a.mint ?? SOL_MINT
  const isSol = mint === SOL_MINT

  // Caps: per-transfer in SOL-equivalent, SOL reserve, balance.
  let prices: Record<string, number> = {}
  try { prices = await ctx.prices([SOL_MINT, mint]) } catch { prices = {} }
  const solEq = isSol ? a.amount : prices[mint] && prices[SOL_MINT] ? (a.amount * prices[mint]) / prices[SOL_MINT] : undefined
  if (solEq !== undefined && solEq > config.maxTradeSol) return { kind: 'refused', message: `Refused by safety limit: ≈ ${solEq.toFixed(3)} SOL is above POTSWAP_MAX_TRADE_SOL (${config.maxTradeSol}). No funds were debited.` }
  let bal: Record<string, number> = {}
  try { bal = await ctx.balances(signer.publicKey) } catch { bal = {} }
  const have = bal[mint] ?? 0
  const spendable = isSol ? Math.max(have - DEFAULTS.solReserve, 0) : have
  if (a.amount > spendable) return { kind: 'refused', message: isSol ? `Insufficient SOL: balance ${have.toFixed(4)}, keep at least ${DEFAULTS.solReserve} SOL for fees. No funds were debited.` : `Insufficient balance (${have}). No funds were debited.` }

  const summary = `${a.amount} ${isSol ? 'SOL' : mint.slice(0, 4) + '…'} → ${a.to}`
  if (!a.confirm) return { kind: 'quote-only', summary: `Transfer not sent (confirm=true to send): ${summary}` }
  if (config.dryRun) return { kind: 'dry-run', summary: `DRY RUN, nothing signed: ${summary}` }

  try {
    const from = new PublicKey(signer.publicKey)
    const to = new PublicKey(a.to)
    const tx = new Transaction()
    if (isSol) {
      tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: BigInt(toRaw(a.amount, 9)) }))
    } else {
      const mintPk = new PublicKey(mint)
      const decimals = a.decimals ?? (await ctx.decimalsOf(mint))
      const owner = await ctx.getMintOwner?.(mint)
      const program = owner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
      const src = getAssociatedTokenAddressSync(mintPk, from, false, program)
      const dst = getAssociatedTokenAddressSync(mintPk, to, true, program)
      if (!(await ctx.rpc.getAccountOwner(dst.toBase58()))) tx.add(createAssociatedTokenAccountIdempotentInstruction(from, dst, to, mintPk, program))
      tx.add(createTransferCheckedInstruction(src, mintPk, dst, from, BigInt(toRaw(a.amount, decimals)), decimals, [], program))
    }
    const { blockhash, lastValidBlockHeight } = await ctx.rpc.getLatestBlockhash('confirmed')
    tx.recentBlockhash = blockhash
    tx.feePayer = from
    signer.signLegacy(tx)
    const signature = await ctx.rpc.sendRawTransaction(tx.serialize())
    const conf = await ctx.rpc.confirmTransaction(signature, blockhash, lastValidBlockHeight)
    if (conf.err) return { kind: 'failed', message: `Transfer failed on-chain: ${JSON.stringify(conf.err)}. Check https://solscan.io/tx/${signature}` }
    return { kind: 'ok', signature, explorerUrl: `https://solscan.io/tx/${signature}`, summary: `Sent ${summary}` }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    return { kind: 'failed', message: `${m}${/blockhash|expired/i.test(m) ? ' The transaction expired before landing; no funds were debited.' : ''}` }
  }
}

