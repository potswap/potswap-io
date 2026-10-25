// PRD P10.2 / P10.9 / P13.1 — load or create the agent's keypair; the secret never leaves this module.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keypair, type VersionedTransaction, type Transaction } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'
import { registerSecret } from './redact.js'

export interface Signer {
  publicKey: string
  sign(tx: VersionedTransaction): VersionedTransaction
  signLegacy(tx: Transaction): Transaction
  /** Ed25519 detached signature over arbitrary bytes (observations, consume receipts, claim intents). */
  signMessage(bytes: Uint8Array): Uint8Array
}

export const WALLET_FILE = 'wallet.json'

export function parseSecret(raw: string): Uint8Array {
  const s = raw.trim()
  if (s.startsWith('[')) {
    const arr = JSON.parse(s) as unknown
    if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) throw new Error('Keypair JSON must be an array of 64 bytes')
    return Uint8Array.from(arr as number[])
  }
  let bytes: Uint8Array
  try { bytes = bs58.decode(s) } catch { throw new Error('Private key is not valid base58 or a JSON byte array') }
  if (bytes.length === 64) return bytes
  if (bytes.length === 32) return Keypair.fromSeed(bytes).secretKey
  throw new Error(`Private key has ${bytes.length} bytes; expected 64 (or a 32-byte seed)`)
}

function toSigner(kp: Keypair, raw: string): Signer {
  // Register every encoding the secret could leak in, not just the one supplied.
  registerSecret(raw.trim())
  registerSecret(bs58.encode(kp.secretKey))
  registerSecret(JSON.stringify(Array.from(kp.secretKey)))
  return {
    publicKey: kp.publicKey.toBase58(),
    sign(tx) { tx.sign([kp]); return tx },
    signLegacy(tx) { tx.sign(kp); return tx },
    signMessage(bytes) { return ed25519.sign(bytes, kp.secretKey.slice(0, 32)) },
  }
}

/**
 * Resolution order: SOLANA_PRIVATE_KEY → SOLANA_KEYPAIR_PATH → `<stateDir>/wallet.json`
 * (created by `wallet_create`). Returns null when none exists.
 */
export function loadSigner(opts: { privateKey?: string; keypairPath?: string; stateDir?: string }): Signer | null {
  let raw = opts.privateKey
  if (!raw && opts.keypairPath) {
    try { raw = readFileSync(opts.keypairPath, 'utf8') } catch { throw new Error('Cannot read keypair file at SOLANA_KEYPAIR_PATH') }
  }
  if (!raw && opts.stateDir) {
    const file = join(opts.stateDir, WALLET_FILE)
    if (existsSync(file)) raw = readFileSync(file, 'utf8')
  }
  if (!raw) return null
  return toSigner(Keypair.fromSecretKey(parseSecret(raw)), raw)
}

/** PRD P13.1 — creates `<stateDir>/wallet.json` (0600). Refuses to overwrite. */
export function createWallet(stateDir: string): { signer: Signer; file: string } {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, WALLET_FILE)
  if (existsSync(file)) throw new Error(`A wallet already exists at ${file}. Back it up and remove it first if you really want a new one.`)
  const kp = Keypair.generate()
  const raw = JSON.stringify(Array.from(kp.secretKey))
  writeFileSync(file, raw, { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows */ }
  return { signer: toSigner(kp, raw), file }
}
