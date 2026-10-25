// PRD P15 — sign, verify and build observations on the agent's machine. The schema lives in the shared module.
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'
import type { PotswapApi } from './api.js'
import type { Signer } from './wallet.js'
import { aggregate, canonical, canonicalBytes, consumeMessage, DEFAULT_TTL_SEC, isFresh, observationId, validateSigned, type Aggregate, type Observation, type ObservationBody, type ObservationKind } from './shared/observation-schema.js'

export interface BuildArgs { kind: ObservationKind; mint: string; value: number; unit?: string; source: string; slot: number; ttlSec?: number; note?: string; now?: number }

const DEFAULT_UNIT: Record<ObservationKind, string> = { price: 'usd', liquidity: 'usd', volume24h: 'usd', holders: 'count', risk: 'level', route: 'bps' }

/** Builds and signs an observation with the agent wallet. Throws when the body is invalid. */
export function signObservation(signer: Signer, a: BuildArgs): Observation {
  const body: ObservationBody = { v: 1, kind: a.kind, mint: a.mint, value: a.value, unit: a.unit ?? DEFAULT_UNIT[a.kind], source: a.source, slot: a.slot, observedAt: a.now ?? Date.now(), ttlSec: a.ttlSec ?? DEFAULT_TTL_SEC, publisher: signer.publicKey, ...(a.note ? { note: a.note } : {}) }
  const sig = bs58.encode(signer.signMessage(canonicalBytes(body)))
  const v = validateSigned({ ...body, sig }, body.observedAt)
  if (!v.ok) throw new Error(v.error)
  return v.obs
}

export interface Verification { ok: boolean; reason?: string; fresh: boolean; id: string | null; deviationPct?: number | null }

/** Schema + id + Ed25519 signature + freshness, locally. With `referencePrice` (price kind) it also reports the deviation. */
export function verifyObservation(input: unknown, opts: { now?: number; referencePrice?: number | null } = {}): Verification {
  const now = opts.now ?? Date.now()
  const v = validateSigned(input, now)
  if (!v.ok) return { ok: false, reason: v.error, fresh: false, id: null }
  const { id, sig, ...body } = v.obs
  let sigOk = false
  try { sigOk = ed25519.verify(bs58.decode(sig), canonicalBytes(body), bs58.decode(body.publisher)) } catch { sigOk = false }
  if (!sigOk) return { ok: false, reason: 'Signature does not match the publisher.', fresh: isFresh(body, now), id }
  const deviationPct = body.kind === 'price' && opts.referencePrice ? ((body.value - opts.referencePrice) / opts.referencePrice) * 100 : undefined
  return { ok: true, fresh: isFresh(body, now), id, ...(deviationPct !== undefined ? { deviationPct } : {}) }
}

/** Signed receipt proving this wallet used an observation (weights Season 2 publisher rewards). */
export function signConsumption(signer: Signer, observationId: string, now = Date.now()): { wallet: string; message: string; signature: string } {
  const message = consumeMessage(observationId, signer.publicKey, now)
  return { wallet: signer.publicKey, message, signature: bs58.encode(signer.signMessage(new TextEncoder().encode(message))) }
}

/** Median price from fresh observations of ≥ minPublishers distinct publishers, or undefined. */
export async function observedPrice(api: PotswapApi, mint: string, minPublishers = 2, now = Date.now()): Promise<{ price: number | undefined; aggregate: Aggregate }> {
  const r = await api.observations({ mint, kind: 'price', limit: 100 })
  const agg = aggregate(r.items, 'price', mint, now)
  return { price: agg.publishers >= minPublishers && agg.median !== null ? agg.median : undefined, aggregate: agg }
}

