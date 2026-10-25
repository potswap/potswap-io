// PRD P15 — T-117 SDK signing / verification round trip and the observation-fed price.
import { describe, expect, it } from 'vitest'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { loadSigner } from '../src/wallet.js'
import { PotswapApi } from '../src/api.js'
import { observedPrice, signConsumption, signObservation, verifyObservation } from '../src/observations.js'

const kp = Keypair.generate()
const signer = loadSigner({ privateKey: bs58.encode(kp.secretKey) })!
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const NOW = Date.parse('2026-11-01T12:00:00Z')

describe('observations (SDK)', () => {
  it('signs with the agent wallet, verifies locally, and detects tampering and staleness', () => {
    const obs = signObservation(signer, { kind: 'price', mint: MINT, value: 0.00001, source: 'test', slot: 300_000_000, now: NOW })
    expect(obs.publisher).toBe(kp.publicKey.toBase58())
    expect(obs.unit).toBe('usd'); expect(obs.ttlSec).toBe(300); expect(obs.id).toMatch(/^[0-9a-f]{32}$/)
    expect(verifyObservation(obs, { now: NOW })).toMatchObject({ ok: true, fresh: true, id: obs.id })
    expect(verifyObservation({ ...obs, value: 0.00002, id: undefined }, { now: NOW })).toMatchObject({ ok: false, reason: expect.stringMatching(/Signature/) })
    expect(verifyObservation({ ...obs, value: 0.00002 }, { now: NOW })).toMatchObject({ ok: false, reason: expect.stringMatching(/id does not match/) })
    expect(verifyObservation(obs, { now: NOW + 301_000 })).toMatchObject({ ok: true, fresh: false })
    expect(verifyObservation(obs, { now: NOW, referencePrice: 0.00002 }).deviationPct).toBeCloseTo(-50)
    expect(() => signObservation(signer, { kind: 'price', mint: 'bad', value: 1, source: 'x', slot: 1, now: NOW })).toThrow(/mint/)
    const receipt = signConsumption(signer, obs.id, NOW)
    expect(JSON.parse(receipt.message)).toEqual({ wallet: signer.publicKey, ts: NOW, action: 'consume', observationId: obs.id })
    expect(receipt.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/)
  })
  it('observedPrice needs enough distinct publishers', async () => {
    const mk = (pub: Keypair, value: number) => signObservation(loadSigner({ privateKey: bs58.encode(pub.secretKey) })!, { kind: 'price', mint: MINT, value, source: 'bot', slot: 1, now: NOW })
    const items = [mk(Keypair.generate(), 10), mk(Keypair.generate(), 12), mk(Keypair.generate(), 11)]
    const api = new PotswapApi('https://t.local', (async () => new Response(JSON.stringify({ items, now: NOW }), { headers: { 'content-type': 'application/json' } })) as typeof fetch)
    expect((await observedPrice(api, MINT, 2, NOW)).price).toBe(11)
    expect((await observedPrice(api, MINT, 4, NOW)).price).toBeUndefined()
    const empty = new PotswapApi('https://t.local', (async () => new Response(JSON.stringify({ items: [], now: NOW }), { headers: { 'content-type': 'application/json' } })) as typeof fetch)
    expect((await observedPrice(empty, MINT, 1, NOW)).aggregate.publishers).toBe(0)
  })
})
