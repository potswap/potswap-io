// PRD P14.1/P14.2 — instruction-level validation of a transaction before the wallet signs it.
// Pure: decodes the compiled message and applies a policy. Programs reached through address-lookup
// tables cannot be resolved offline; they are counted as `unresolved` and only allowed for transactions
// from a trusted builder (Jupiter orders), never for transactions we build ourselves.
import { PublicKey, type VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'

export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  token: TOKEN_PROGRAM_ID.toBase58(),
  token2022: TOKEN_2022_PROGRAM_ID.toBase58(),
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  jupiterV6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  jupiterReferral: 'REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3',
  raydiumCpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  jupiterLend: 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9',
} as const
export const DEFAULT_ALLOWED_PROGRAMS: ReadonlySet<string> = new Set(Object.values(PROGRAMS))

export interface ValidatePolicy {
  signer: string
  allowedPrograms?: ReadonlySet<string>
  /** Extra System-transfer destinations besides the wallet's own wSOL account. */
  allowedRecipients?: ReadonlySet<string>
  /** Largest System transfer (lamports) allowed to a destination that is neither the wallet's wSOL account nor allow-listed. */
  maxLamportsToUnknown?: bigint
  /** Allow instructions whose program sits behind an address-lookup table (trusted builders only). */
  allowUnresolved?: boolean
}

export interface ValidationReport { ok: boolean; reasons: string[]; programs: string[]; unresolved: number; instructions: number }

const TOKEN_IX = { approve: 4, revoke: 5, setAuthority: 6, closeAccount: 9, approveChecked: 13 }
const u64le = (b: Uint8Array, o: number) => { let n = 0n; for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[o + i] ?? 0); return n }

export function validateTransaction(tx: VersionedTransaction, policy: ValidatePolicy): ValidationReport {
  const reasons: string[] = []
  const allowed = policy.allowedPrograms ?? DEFAULT_ALLOWED_PROGRAMS
  const msg = tx.message
  const keys = msg.staticAccountKeys.map((k) => k.toBase58())
  const payer = keys[0]
  if (payer !== policy.signer) reasons.push(`fee payer ${payer?.slice(0, 6)}… is not the agent wallet`)
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(policy.signer), false).toBase58()
  const programs = new Set<string>()
  let unresolved = 0
  const ixs = msg.compiledInstructions
  for (const ix of ixs) {
    const program = keys[ix.programIdIndex]
    if (program === undefined) { unresolved++; continue }
    programs.add(program)
    if (!allowed.has(program)) { reasons.push(`program ${program} is not allow-listed`); continue }
    const acct = (i: number) => keys[ix.accountKeyIndexes[i]]
    const data = ix.data
    if (program === PROGRAMS.token || program === PROGRAMS.token2022) {
      const kind = data[0]
      if (kind === TOKEN_IX.approve || kind === TOKEN_IX.approveChecked) reasons.push('token Approve (delegation) is not allowed')
      else if (kind === TOKEN_IX.setAuthority) reasons.push('token SetAuthority is not allowed')
      else if (kind === TOKEN_IX.closeAccount) {
        const dest = acct(1)
        if (dest !== undefined && dest !== policy.signer) reasons.push(`CloseAccount sends rent to ${dest.slice(0, 6)}… instead of the wallet`)
      }
    } else if (program === PROGRAMS.system) {
      const index = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)
      if (index === 2) { // Transfer { lamports }
        const from = acct(0), to = acct(1)
        const lamports = u64le(data, 4)
        if (from === policy.signer && to !== undefined && to !== wsolAta && !policy.allowedRecipients?.has(to) && lamports > (policy.maxLamportsToUnknown ?? 0n)) {
          reasons.push(`System transfer of ${lamports} lamports to ${to.slice(0, 6)}… is not allowed`)
        }
      } else if (index === 1) { // Assign
        reasons.push('System Assign is not allowed')
      }
    }
  }
  if (unresolved > 0 && !policy.allowUnresolved) reasons.push(`${unresolved} instruction(s) use programs behind address-lookup tables that cannot be verified offline`)
  return { ok: reasons.length === 0, reasons, programs: [...programs], unresolved, instructions: ixs.length }
}

export const validatorRefusal = (r: ValidationReport) => `Refused by the transaction validator: ${r.reasons.join('; ')}. No funds were debited.`
