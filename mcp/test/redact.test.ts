import { describe, expect, it } from 'vitest'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { loadSigner } from '@potswap_io/sdk'
import { redact, redactValue } from '@potswap_io/sdk'
import { connect, mockFetch, SOL, USDC, type MockState } from './helpers.js'

const kp = Keypair.generate()
const b58 = bs58.encode(kp.secretKey)
const arr = JSON.stringify(Array.from(kp.secretKey))

// T-65 (PRD P10.9)
describe('redaction', () => {
  it('scrubs the registered secret in both encodings', () => {
    loadSigner({ privateKey: b58 })
    expect(redact(`key=${b58} done`)).toBe('key=[REDACTED] done')
    expect(redact(`arr=${arr}`)).toBe('arr=[REDACTED]')
    expect(redact(`spaced=${JSON.stringify(Array.from(kp.secretKey), null, 1)}`)).toContain('[REDACTED]')
    expect(redactValue({ nested: { k: b58 } })).toEqual({ nested: { k: '[REDACTED]' } })
  })
  it('never lets the secret reach a tool result, even via an upstream error message', async () => {
    const signer = loadSigner({ privateKey: b58 })!
    const st: MockState = { calls: [], config: {} }
    const leaky: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/order')) return new Response(JSON.stringify({ error: `boom ${b58}` }), { status: 500 })
      return mockFetch(st)(input, init)
    }) as typeof fetch
    const { call } = await connect({ signer, fetchFn: leaky, balances: async () => ({ [SOL]: 1 }) })
    const r = await call('swap', { inputMint: SOL, outputMint: USDC, amount: 0.1, confirm: true })
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain(b58)
    expect(JSON.stringify(r.data)).not.toContain(b58)
    expect(r.text).toContain('[REDACTED]')
    const ok = await call('get_balances')
    expect(JSON.stringify(ok.data)).not.toContain(b58)
    expect(ok.data.wallet).toBe(kp.publicKey.toBase58())
  })
})
