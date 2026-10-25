// PRD P14.3/P14.4 — idempotent operations: a caller-supplied opId makes a swap safe to retry.
// States: pending (about to send) → sent (signature known, not confirmed) → ok | failed | unknown
// (send happened or may have happened but the outcome could not be read).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './redact.js'

export type OpState = 'pending' | 'sent' | 'ok' | 'failed' | 'unknown'

export interface OperationRecord {
  id: string
  kind: 'swap'
  state: OpState
  createdAt: string
  updatedAt: string
  args: Record<string, unknown>
  signature?: string
  result?: Record<string, unknown>
  quote?: Record<string, unknown>
  error?: string
}

export interface OpsStore {
  get(id: string): OperationRecord | undefined
  put(rec: OperationRecord): void
  list(limit?: number): OperationRecord[]
}

export const MAX_OPS_KEPT = 1000

export class MemoryOpsStore implements OpsStore {
  private m = new Map<string, OperationRecord>()
  get(id: string) { return this.m.get(id) }
  put(rec: OperationRecord) { this.m.set(rec.id, { ...rec }) }
  list(limit = 50) { return [...this.m.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit) }
}

export class FileOpsStore implements OpsStore {
  readonly location: string
  private cache: Record<string, OperationRecord> | null = null
  constructor(dir: string) { mkdirSync(dir, { recursive: true }); this.location = join(dir, 'operations.json') }
  private load(): Record<string, OperationRecord> {
    if (this.cache) return this.cache
    if (!existsSync(this.location)) return (this.cache = {})
    try { this.cache = JSON.parse(readFileSync(this.location, 'utf8')) as Record<string, OperationRecord> } catch { this.cache = {} }
    return this.cache!
  }
  get(id: string) { return this.load()[id] }
  put(rec: OperationRecord) {
    const all = this.load()
    all[rec.id] = { ...rec }
    const keep = Object.values(all).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_OPS_KEPT)
    this.cache = Object.fromEntries(keep.map((r) => [r.id, r]))
    const tmp = `${this.location}.tmp`
    writeFileSync(tmp, redact(JSON.stringify(this.cache, null, 2)))
    renameSync(tmp, this.location)
  }
  list(limit = 50) { return Object.values(this.load()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit) }
}

/** What a repeated opId means for the caller. */
export function replayDecision(rec: OperationRecord | undefined): { kind: 'fresh' } | { kind: 'replay'; record: OperationRecord } | { kind: 'blocked'; message: string; record: OperationRecord } {
  if (!rec) return { kind: 'fresh' }
  if (rec.state === 'ok') return { kind: 'replay', record: rec }
  if (rec.state === 'failed') return { kind: 'fresh' }
  return { kind: 'blocked', record: rec, message: `Operation ${rec.id} was already ${rec.state === 'pending' ? 'started' : 'sent'}${rec.signature ? ` (signature ${rec.signature})` : ''}; check get_transaction before retrying with a new opId. Funds may have been debited.` }
}

export const nowIso = () => new Date().toISOString()
