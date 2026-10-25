// PRD P14.1/P14.2 — T-121 the instruction validator.
import { describe, expect, it } from 'vitest'
import { Keypair, MessageV0, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSetAuthorityInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, AuthorityType } from '@solana/spl-token'
import { validateTransaction, validatorRefusal, PROGRAMS } from '../src/security/validate.js'

const wallet = Keypair.generate()
const other = Keypair.generate().publicKey
const BH = '11111111111111111111111111111111'
const tx = (ixs: TransactionInstruction[], payer = wallet.publicKey) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BH, instructions: ixs }).compileToV0Message())
const ok = (ixs: TransactionInstruction[]) => validateTransaction(tx(ixs), { signer: wallet.publicKey.toBase58() })

describe('transaction validator', () => {
  it('passes a plain wrap + ATA + compute budget transaction', () => {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey)
    const r = ok([ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wsol, wallet.publicKey, NATIVE_MINT), SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsol, lamports: 5_000_000 })])
    expect(r).toMatchObject({ ok: true, unresolved: 0, instructions: 3 })
    expect(r.programs).toEqual(expect.arrayContaining([PROGRAMS.computeBudget, PROGRAMS.ata, PROGRAMS.system]))
  })
  it('refuses a foreign fee payer, an unknown program, delegation, authority changes and closing to someone else', () => {
    const foreign = validateTransaction(tx([SystemProgram.transfer({ fromPubkey: other, toPubkey: wallet.publicKey, lamports: 1 })], other), { signer: wallet.publicKey.toBase58() })
    expect(foreign.ok).toBe(false); expect(foreign.reasons[0]).toMatch(/fee payer/)
    const unknown = ok([new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) })])
    expect(unknown.reasons[0]).toMatch(/not allow-listed/)
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey)
    expect(ok([createApproveInstruction(ata, other, wallet.publicKey, 1n)]).reasons[0]).toMatch(/Approve/)
    expect(ok([createSetAuthorityInstruction(ata, wallet.publicKey, AuthorityType.AccountOwner, other)]).reasons[0]).toMatch(/SetAuthority/)
    expect(ok([createCloseAccountInstruction(ata, other, wallet.publicKey)]).reasons[0]).toMatch(/CloseAccount sends rent/)
    expect(ok([createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey)]).ok).toBe(true)
    expect(validatorRefusal(unknown)).toMatch(/^Refused by the transaction validator: .*No funds were debited\.$/)
  })
  it('SOL transfers from the wallet: own wSOL account ok, allow-listed recipient ok, otherwise capped', () => {
    expect(ok([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other, lamports: 1_000_000 })]).reasons[0]).toMatch(/System transfer of 1000000 lamports/)
    expect(validateTransaction(tx([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other, lamports: 1_000_000 })]), { signer: wallet.publicKey.toBase58(), allowedRecipients: new Set([other.toBase58()]) }).ok).toBe(true)
    expect(validateTransaction(tx([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other, lamports: 1_000 })]), { signer: wallet.publicKey.toBase58(), maxLamportsToUnknown: 10_000n }).ok).toBe(true)
    // transfers from someone else (e.g. a program-owned account) are not our concern
    expect(ok([SystemProgram.transfer({ fromPubkey: other, toPubkey: Keypair.generate().publicKey, lamports: 1e9 })]).ok).toBe(true)
  })
  it('programs behind lookup tables count as unresolved: allowed only for trusted builders', () => {
    // web3.js never compiles program ids into lookup tables, so build the v0 message by hand the way Jupiter's do:
    // static keys = [payer, computeBudget], one lookup table providing [dexProgram, dexAccount] at indexes 2 and 3.
    const lutKey = Keypair.generate().publicKey
    const mk = (extraIx: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[] = [], extraStatic: PublicKey[] = []) => new VersionedTransaction(new MessageV0({
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 + extraStatic.length },
      staticAccountKeys: [wallet.publicKey, ComputeBudgetProgram.programId, ...extraStatic],
      recentBlockhash: BH,
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [], data: ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }).data }, { programIdIndex: 2 + extraStatic.length, accountKeyIndexes: [3 + extraStatic.length], data: new Uint8Array([9, 9]) }, ...extraIx],
      addressTableLookups: [{ accountKey: lutKey, writableIndexes: [1], readonlyIndexes: [0] }],
    }))
    const t = mk()
    expect(t.message.addressTableLookups.length).toBe(1)
    const strict = validateTransaction(t, { signer: wallet.publicKey.toBase58() })
    expect(strict).toMatchObject({ ok: false, unresolved: 1 }); expect(strict.reasons[0]).toMatch(/lookup tables/)
    expect(validateTransaction(t, { signer: wallet.publicKey.toBase58(), allowUnresolved: true })).toMatchObject({ ok: true, unresolved: 1, instructions: 2 })
    // a static unknown program is still refused even for trusted builders
    const unknownProgram = Keypair.generate().publicKey
    const bad = mk([{ programIdIndex: 2, accountKeyIndexes: [], data: new Uint8Array([]) }], [unknownProgram])
    const r = validateTransaction(bad, { signer: wallet.publicKey.toBase58(), allowUnresolved: true })
    expect(r.ok).toBe(false); expect(r.reasons[0]).toMatch(/not allow-listed/)
  })
  it('extra allow-listed programs and PublicKey inputs', () => {
    const custom = Keypair.generate().publicKey
    const ix = new TransactionInstruction({ programId: custom, keys: [], data: Buffer.from([]) })
    expect(ok([ix]).ok).toBe(false)
    expect(validateTransaction(tx([ix]), { signer: wallet.publicKey.toBase58(), allowedPrograms: new Set([custom.toBase58(), PROGRAMS.system]) }).ok).toBe(true)
    expect(new PublicKey(PROGRAMS.raydiumCpmm).toBase58()).toBe(PROGRAMS.raydiumCpmm)
  })
})
