// PRD P13.5/P13.6 — normalize Helius parsed transactions and RPC transaction status.
export interface HeliusTx {
  signature: string
  timestamp: number
  type?: string
  source?: string
  fee?: number
  feePayer?: string
  transactionError?: unknown
  nativeTransfers?: { fromUserAccount?: string; toUserAccount?: string; amount?: number }[]
  tokenTransfers?: { fromUserAccount?: string; toUserAccount?: string; tokenAmount?: number; mint?: string }[]
  events?: { swap?: { nativeInput?: { account: string; amount: string } | null; nativeOutput?: { account: string; amount: string } | null; tokenInputs?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[]; tokenOutputs?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[] } }
}

export const SOL = 'So11111111111111111111111111111111111111112'

export interface HistoryItem {
  signature: string
  time: string
  kind: 'swap' | 'transfer' | 'other'
  source?: string
  feeSol: number
  failed: boolean
  /** For swaps: what the wallet gave and got. For transfers: amount and direction. */
  inMint?: string; inAmount?: number; outMint?: string; outAmount?: number
  direction?: 'in' | 'out'; counterparty?: string; mint?: string; amount?: number
}

export function normalizeHistory(txs: HeliusTx[], wallet: string): HistoryItem[] {
  return txs.map((t) => {
    const base: HistoryItem = { signature: t.signature, time: new Date((t.timestamp ?? 0) * 1000).toISOString(), kind: 'other', source: t.source, feeSol: (t.fee ?? 0) / 1e9, failed: !!t.transactionError }
    const sw = t.events?.swap
    if (sw) {
      // Determine what this wallet put in and took out.
      let inMint: string | undefined, inAmount = 0, outMint: string | undefined, outAmount = 0
      if (sw.nativeInput && sw.nativeInput.account === wallet) { inMint = SOL; inAmount = Number(sw.nativeInput.amount) / 1e9 }
      if (sw.nativeOutput && sw.nativeOutput.account === wallet) { outMint = SOL; outAmount = Number(sw.nativeOutput.amount) / 1e9 }
      for (const i of sw.tokenInputs ?? []) if (i.userAccount === wallet) { inMint = i.mint; inAmount += Number(i.rawTokenAmount.tokenAmount) / 10 ** i.rawTokenAmount.decimals }
      for (const o of sw.tokenOutputs ?? []) if (o.userAccount === wallet) { outMint = o.mint; outAmount += Number(o.rawTokenAmount.tokenAmount) / 10 ** o.rawTokenAmount.decimals }
      if (inMint || outMint) return { ...base, kind: 'swap', inMint, inAmount, outMint, outAmount }
    }
    const tt = (t.tokenTransfers ?? []).find((x) => x.fromUserAccount === wallet || x.toUserAccount === wallet)
    if (tt && tt.mint && tt.tokenAmount) {
      const out = tt.fromUserAccount === wallet
      return { ...base, kind: 'transfer', direction: out ? 'out' : 'in', counterparty: out ? tt.toUserAccount : tt.fromUserAccount, mint: tt.mint, amount: tt.tokenAmount }
    }
    const nt = (t.nativeTransfers ?? []).find((x) => (x.fromUserAccount === wallet || x.toUserAccount === wallet) && (x.amount ?? 0) > 0)
    if (nt) {
      const out = nt.fromUserAccount === wallet
      return { ...base, kind: 'transfer', direction: out ? 'out' : 'in', counterparty: out ? nt.toUserAccount : nt.fromUserAccount, mint: SOL, amount: (nt.amount ?? 0) / 1e9 }
    }
    return base
  })
}

export type TxStatus = 'not found' | 'processed' | 'confirmed' | 'finalized' | 'failed'

export function mapSignatureStatus(s: { confirmationStatus?: string; err?: unknown } | null): TxStatus {
  if (!s) return 'not found'
  if (s.err) return 'failed'
  if (s.confirmationStatus === 'finalized') return 'finalized'
  if (s.confirmationStatus === 'confirmed') return 'confirmed'
  return 'processed'
}
