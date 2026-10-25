// PRD P11.11/P11.12 — one scheduler per state directory. The lock is a file holding the owner PID;
// a lock whose PID is no longer alive is stale and may be reclaimed.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Lock { acquired: boolean; ownerPid: number | null; release(): void }

export function pidAlive(pid: number, kill: (pid: number, sig: 0) => void = process.kill): boolean {
  try { kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export function acquireLock(dir: string, pid = process.pid, alive: (pid: number) => boolean = pidAlive): Lock {
  const file = join(dir, 'scheduler.lock')
  if (existsSync(file)) {
    const owner = Number(readFileSync(file, 'utf8').trim())
    if (owner && owner !== pid && alive(owner)) return { acquired: false, ownerPid: owner, release() {} }
  }
  writeFileSync(file, String(pid))
  return {
    acquired: true, ownerPid: pid,
    release() { try { if (Number(readFileSync(file, 'utf8').trim()) === pid) unlinkSync(file) } catch { /* already gone */ } },
  }
}
