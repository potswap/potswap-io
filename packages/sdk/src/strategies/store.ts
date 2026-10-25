// PRD P11 — persistence: a JSON file with atomic writes (tmp + rename), plus an in-memory store for tests.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redact } from '../redact.js'
import { EMPTY_STATE, type Run, type Strategy, type StrategyState } from './types.js'

export interface StrategyStore {
  load(): StrategyState
  save(state: StrategyState): void
  /** Convenience: read-modify-write. */
  update<T>(fn: (state: StrategyState) => T): T
  readonly location: string
}

export const MAX_RUNS_KEPT = 2000

export class MemoryStore implements StrategyStore {
  private state: StrategyState = structuredClone(EMPTY_STATE)
  location = 'memory'
  load() { return structuredClone(this.state) }
  save(state: StrategyState) { this.state = structuredClone(trim(state)) }
  update<T>(fn: (state: StrategyState) => T): T { const s = this.load(); const r = fn(s); this.save(s); return r }
}

export class FileStore implements StrategyStore {
  location: string
  constructor(dir = defaultStateDir()) {
    mkdirSync(dir, { recursive: true })
    this.location = join(dir, 'strategies.json')
  }
  load(): StrategyState {
    if (!existsSync(this.location)) return structuredClone(EMPTY_STATE)
    try {
      const parsed = JSON.parse(readFileSync(this.location, 'utf8')) as StrategyState
      if (parsed.version !== 1 || !Array.isArray(parsed.strategies)) return structuredClone(EMPTY_STATE)
      parsed.runs ??= []
      return parsed
    } catch { return structuredClone(EMPTY_STATE) }
  }
  save(state: StrategyState) {
    // Redaction is belt and braces: nothing here should hold a key, but the file is on disk forever.
    const body = redact(JSON.stringify(trim(state), null, 2))
    const tmp = `${this.location}.${process.pid}.tmp`
    writeFileSync(tmp, body)
    renameSync(tmp, this.location)
  }
  update<T>(fn: (state: StrategyState) => T): T { const s = this.load(); const r = fn(s); this.save(s); return r }
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env) {
  return env.POTSWAP_STATE_DIR || join(homedir(), '.potswap')
}

function trim(state: StrategyState): StrategyState {
  if (state.runs.length > MAX_RUNS_KEPT) state.runs = state.runs.slice(-MAX_RUNS_KEPT)
  return state
}

export const findStrategy = (state: StrategyState, id: string): Strategy | undefined => state.strategies.find((s) => s.id === id)
export const runsOf = (state: StrategyState, id: string, limit = 50): Run[] => state.runs.filter((r) => r.strategyId === id).slice(-limit).reverse()
