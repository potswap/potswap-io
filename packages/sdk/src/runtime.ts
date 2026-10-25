// Wires config → signer, API, balances, strategy store, lock and scheduler. Used by index.ts (both modes).
import { Connection, PublicKey } from '@solana/web3.js'
import { PotswapApi } from './api.js'
import type { Config } from './config.js'
import { loadSigner, type Signer } from './wallet.js'
import { FileStore, type StrategyStore } from './strategies/store.js'
import { acquireLock } from './strategies/lock.js'
import { Scheduler } from './strategies/scheduler.js'
import type { BalancesFn, TradeContext } from './trade.js'
import { FileOpsStore } from './ops.js'
import { rpcFromConnection } from './transfer.js'

export interface Runtime {
  signer: Signer | null
  store: StrategyStore
  scheduler: Scheduler | null
  lockOwner: number | null
  trade: TradeContext
  release(): void
}

export function createRuntime(config: Config): Runtime {
  const signer = loadSigner({ privateKey: config.privateKey, keypairPath: config.keypairPath, stateDir: config.stateDir })
  const api = new PotswapApi(config.apiBase)
  const balances = rpcBalances(config.rpcUrl)
  const trade: TradeContext = { api, config, signer, balances, rpc: rpcFromConnection(new Connection(config.rpcUrl, 'confirmed')), ops: new FileOpsStore(config.stateDir) }
  const dir = config.stateDir
  const store = new FileStore(dir)
  const lock = acquireLock(dir)
  const scheduler = lock.acquired ? new Scheduler({ store, trade, maxDailySol: config.maxDailySol }) : null
  return { signer, store, scheduler, lockOwner: lock.ownerPid, trade, release: () => lock.release() }
}

export function rpcBalances(rpcUrl: string): BalancesFn {
  const SOL = 'So11111111111111111111111111111111111111112'
  return async (wallet) => {
    const conn = new Connection(rpcUrl, 'confirmed')
    const owner = new PublicKey(wallet)
    const out: Record<string, number> = {}
    const [lamports, spl, t22] = await Promise.all([
      conn.getBalance(owner),
      conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
      conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }).catch(() => ({ value: [] })),
    ])
    out[SOL] = lamports / 1e9
    for (const { account } of [...spl.value, ...t22.value]) {
      const info = account.data.parsed?.info
      const ui = Number(info?.tokenAmount?.uiAmount ?? 0)
      if (info && ui > 0) out[info.mint] = (out[info.mint] ?? 0) + ui
    }
    return out
  }
}
