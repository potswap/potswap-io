// PRD P14.3/P14.4 — T-122 idempotent operation records.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileOpsStore, MemoryOpsStore, replayDecision, type OperationRecord } from '../src/ops.js'
import { registerSecret } from '../src/redact.js'

const rec = (over: Partial<OperationRecord> = {}): OperationRecord => ({ id: 'op-1', kind: 'swap', state: 'pending', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', args: { inputMint: 'SOL' }, ...over })

describe('operation records', () => {
  it('replay decisions: fresh when unknown id or failed; replay when ok; blocked when pending / sent / unknown', () => {
    expect(replayDecision(undefined)).toEqual({ kind: 'fresh' })
    expect(replayDecision(rec({ state: 'failed' }))).toEqual({ kind: 'fresh' })
    expect(replayDecision(rec({ state: 'ok', result: { signature: 's' } }))).toMatchObject({ kind: 'replay' })
    for (const state of ['pending', 'sent', 'unknown'] as const) {
      const d = replayDecision(rec({ state, signature: state === 'pending' ? undefined : 'SIG' }))
      expect(d.kind).toBe('blocked')
      expect((d as { message: string }).message).toMatch(/Funds may have been debited/)
      if (state !== 'pending') expect((d as { message: string }).message).toContain('SIG')
    }
  })
  it('file store persists, keeps the newest records, redacts secrets, lists newest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potswap-ops-'))
    const store = new FileOpsStore(dir)
    registerSecret('SUPERSECRETKEY1234567890')
    store.put(rec({ id: 'a', updatedAt: '2026-11-01T00:00:01.000Z', error: 'leaked SUPERSECRETKEY1234567890 here' }))
    store.put(rec({ id: 'b', updatedAt: '2026-11-01T00:00:02.000Z', state: 'ok' }))
    const again = new FileOpsStore(dir)
    expect(again.get('b')!.state).toBe('ok')
    expect(again.list().map((r) => r.id)).toEqual(['b', 'a'])
    expect(readFileSync(again.location, 'utf8')).not.toContain('SUPERSECRETKEY'); expect(again.get('a')!.error).toContain('[REDACTED]')
    const mem = new MemoryOpsStore(); mem.put(rec()); expect(mem.get('op-1')!.state).toBe('pending'); expect(mem.list()).toHaveLength(1)
  })
})
