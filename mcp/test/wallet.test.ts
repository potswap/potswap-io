import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { loadSigner, parseSecret } from '@potswap_io/sdk'

const kp = Keypair.generate()

// T-59 (PRD P10.2)
describe('wallet loading', () => {
  it('accepts a base58 64-byte secret', () => {
    expect(loadSigner({ privateKey: bs58.encode(kp.secretKey) })!.publicKey).toBe(kp.publicKey.toBase58())
  })
  it('accepts a JSON byte array', () => {
    expect(loadSigner({ privateKey: JSON.stringify(Array.from(kp.secretKey)) })!.publicKey).toBe(kp.publicKey.toBase58())
  })
  it('accepts a 32-byte seed', () => {
    const seed = kp.secretKey.slice(0, 32)
    expect(parseSecret(bs58.encode(seed))).toEqual(kp.secretKey)
  })
  it('loads from SOLANA_KEYPAIR_PATH (solana-keygen format)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potswap-'))
    const file = join(dir, 'id.json')
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)))
    expect(loadSigner({ keypairPath: file })!.publicKey).toBe(kp.publicKey.toBase58())
  })
  it('prefers SOLANA_PRIVATE_KEY over the path', () => {
    expect(loadSigner({ privateKey: bs58.encode(kp.secretKey), keypairPath: '/nope' })!.publicKey).toBe(kp.publicKey.toBase58())
  })
  it('returns null when nothing is configured', () => {
    expect(loadSigner({})).toBeNull()
  })
  it('rejects garbage with clear messages', () => {
    expect(() => parseSecret('not-base58-!!')).toThrow(/base58/)
    expect(() => parseSecret(bs58.encode(new Uint8Array(10)))).toThrow(/10 bytes/)
    expect(() => parseSecret('[1,2,3]')).toThrow(/64 bytes/)
    expect(() => loadSigner({ keypairPath: '/definitely/missing.json' })).toThrow(/Cannot read keypair file/)
  })
})
