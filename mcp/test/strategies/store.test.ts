import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore, MemoryStore, findStrategy, runsOf } from '@potswap_io/sdk'
import { acquireLock } from '@potswap_io/sdk'
import { registerSecret } from '@potswap_io/sdk'
import type { DcaStrategy } from '@potswap_io/sdk'

const dca: DcaStrategy = { id: 'dca_1', kind: 'dca', createdAt: 't', status: 'active', nextRunAt: 't', consecutiveFailures: 0, totals: { runs: 0, volumeUsd: 0, feeUsd: 0, pointsAdded: 0 }, inputMint: 'A', outputMint: 'B', amountPerRun: 1, intervalMinutes: 60, runsDone: 0 }

// T-80 (PRD P11.10), T-83 (P11.14)
describe('FileStore', () => {
  it('round-trips state atomically and survives a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potswap-store-'))
    const store = new FileStore(dir)
    expect(store.load().strategies).toEqual([])
    store.update((st) => { st.strategies.push(dca) })
    expect(findStrategy(new FileStore(dir).load(), 'dca_1')).toMatchObject({ kind: 'dca' })
    expect(JSON.parse(readFileSync(store.location, 'utf8')).version).toBe(1)
    const fresh = new FileStore(dir)
    fresh.save({ version: 1, strategies: [], runs: [] })
    require('node:fs').writeFileSync(store.location, '{not json')
    expect(new FileStore(dir).load()).toEqual({ version: 1, strategies: [], runs: [] })
  })
  it('redacts a registered secret before it hits disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potswap-store-'))
    const store = new FileStore(dir)
    const secret = 'SUPERSECRETKEYMATERIAL1234567890'
    registerSecret(secret)
    store.update((st) => { st.runs.push({ id: 'r', strategyId: 'dca_1', at: 't', action: `oops ${secret}`, outcome: 'failed' }) })
    const raw = readFileSync(store.location, 'utf8')
    expect(raw).not.toContain(secret)
    expect(raw).toContain('[REDACTED]')
  })
  it('keeps only the most recent runs and returns them newest first', () => {
    const store = new MemoryStore()
    store.update((st) => { for (let i = 0; i < 2100; i++) st.runs.push({ id: String(i), strategyId: 'dca_1', at: String(i), action: 'a', outcome: 'ok' }) })
    expect(store.load().runs.length).toBe(2000)
    expect(runsOf(store.load(), 'dca_1', 2).map((r) => r.id)).toEqual(['2099', '2098'])
  })
})

// T-81 (PRD P11.11/P11.12)
describe('scheduler lock', () => {
  it('second process does not acquire; stale lock from a dead pid is reclaimed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potswap-lock-'))
    const alive = (pid: number) => pid === 111
    const a = acquireLock(dir, 111, alive)
    expect(a.acquired).toBe(true)
    const b = acquireLock(dir, 222, alive)
    expect(b).toMatchObject({ acquired: false, ownerPid: 111 })
    a.release()
    const c = acquireLock(dir, 222, alive)
    expect(c.acquired).toBe(true)
    // dead owner (pid 999 not alive) → reclaimable
    require('node:fs').writeFileSync(join(dir, 'scheduler.lock'), '999')
    expect(acquireLock(dir, 333, alive).acquired).toBe(true)
  })
})
