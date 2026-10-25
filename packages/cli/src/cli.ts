// PRD P16 — the `potswap` command line over @potswap_io/sdk. `run()` is pure enough to test:
// every side effect (fetch, RPC, balances, stdout) is injectable.
import { parseArgs } from 'node:util'
import { runAdmin, type AdminFlags } from './admin.js'
import { Connection } from '@solana/web3.js'
import {
  ApiError, PotswapApi, buildQuote, executeSwap, executeTransfer, rpcFromConnection, rpcBalances, loadConfig, loadSigner, createWallet,
  FileStore, MemoryStore, acquireLock, Scheduler, findStrategy, runsOf, nextRunAfter, levelLabel, signObservation, aggregate, OBSERVATION_KINDS, type ObservationKind,
  executeLend, executeLpDeposit, executeLpWithdraw, lpPools, lpPosition, normalizeMarkets, normalizePositions, type LendOutcome, type LpOutcome,
  SOL_MINT, USDC_MINT, JITOSOL_MINT, MSOL_MINT, NO_WALLET,
  type Config, type Signer, type BalancesFn, type FetchFn, type Rpc, type StrategyStore, type DcaStrategy, type RebalanceStrategy, type OpsStore, FileOpsStore,
} from '@potswap_io/sdk'

export const VERSION = '0.5.0'

export interface Io { out(line: string): void; err(line: string): void }
export interface Deps {
  config?: Config
  env?: NodeJS.ProcessEnv
  fetchFn?: FetchFn
  signer?: Signer | null
  balances?: BalancesFn
  rpc?: Rpc
  store?: StrategyStore
  ops?: OpsStore
  io?: Io
  now?: () => number
  getSlot?: () => Promise<number>
  sleep?: (ms: number) => Promise<void>
}

const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const SYMBOLS: Record<string, string> = { SOL: SOL_MINT, USDC: USDC_MINT, USDT: USDT_MINT, JITOSOL: JITOSOL_MINT, MSOL: MSOL_MINT }
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const USAGE = `potswap ${VERSION} — Solana swaps, wallet, strategies and POT rewards (same engine and limits as @potswap_io/mcp)

Usage: potswap <command> [options]

  quote <in> <out> <amount> [--slippage <bps>]        best route; no wallet needed
  swap <in> <out> <amount> [--slippage <bps>] [--route jupiter|direct|auto] [--op-id <id>] --confirm   execute (2.5% fee, earns POT)
  stake <amount> [--provider jito|marinade] --confirm   SOL → jitoSOL / mSOL
  unstake <amount> [--provider jito|marinade] --confirm
  balances [wallet]                                    SOL + tokens with USD
  positions [wallet]                                   holdings with average cost and PnL
  wallet create | show                                 state-dir wallet (0600); never prints the secret
  transfer <to> <amount> [--mint <mint>] --confirm     SOL or token transfer, no fee
  points [wallet]                                      points, reward balance, level, season
  launch                                               launch-pool meter, season, fee split
  strategies list | runs <id> | pause <id> | resume <id> | delete <id>
  daemon                                               run the strategy scheduler 24/7
  observe <mint...> [--kinds price,liquidity,holders] [--interval <sec>] [--once]   data bot: publish signed observations
  observations <mint> [--kind price]                   fresh observations and the per-publisher median
  lend markets | positions [wallet] | deposit <mint> <amount> --confirm | withdraw <mint> <amount|all> --confirm
  lp pools <mintA> <mintB> | position <poolId> | deposit <poolId> <mint> <amount> --confirm | withdraw <poolId> <lpAmount|pct%> --confirm
  admin sweep | claims | burn [--execute]            owner-run jobs (treasury split, claims worker, buy-and-burn); see potswap admin

Options: --json (machine output), --help, --version
Tokens: a mint address or SOL, USDC, USDT, JITOSOL, MSOL. Amounts are UI units (1 = 1 SOL).
Env: SOLANA_PRIVATE_KEY | SOLANA_KEYPAIR_PATH, POTSWAP_MAX_TRADE_SOL (1), POTSWAP_MAX_SLIPPAGE_BPS (300),
     POTSWAP_MAX_DAILY_SOL (5), POTSWAP_DRY_RUN, POTSWAP_ALLOWED_TOKENS, POTSWAP_ALLOWED_RECIPIENTS, POTSWAP_STATE_DIR, POTSWAP_API`

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const io: Io = deps.io ?? { out: (l) => console.log(l), err: (l) => console.error(l) }
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: { json: { type: 'boolean', default: false }, confirm: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false }, slippage: { type: 'string' }, mint: { type: 'string' }, provider: { type: 'string', default: 'jito' }, limit: { type: 'string' }, kinds: { type: 'string', default: 'price' }, kind: { type: 'string' }, interval: { type: 'string', default: '60' }, once: { type: 'boolean', default: false }, source: { type: 'string', default: 'potswap-cli' }, route: { type: 'string', default: 'jupiter' }, 'op-id': { type: 'string' }, execute: { type: 'boolean', default: false }, pool: { type: 'string' }, reward: { type: 'string' }, team: { type: 'string' }, 'pot-mint': { type: 'string' }, budget: { type: 'string' }, sol: { type: 'string' }, mints: { type: 'string' }, 'max-delay-min': { type: 'string' }, secret: { type: 'string' } },
    })
  } catch (e) { io.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`); return 2 }
  const o = parsed.values as { json?: boolean; confirm?: boolean; help?: boolean; version?: boolean; slippage?: string; mint?: string; provider?: string; limit?: string; kinds?: string; kind?: string; interval?: string; once?: boolean; source?: string; route?: string; 'op-id'?: string; execute?: boolean; pool?: string; reward?: string; team?: string; 'pot-mint'?: string; budget?: string; sol?: string; mints?: string; 'max-delay-min'?: string; secret?: string }
  const pos = parsed.positionals
  if (o.version) { io.out(VERSION); return 0 }
  const [cmd, ...args] = pos
  if (o.help || !cmd) { io.out(USAGE); return o.help ? 0 : 2 }

  const config = deps.config ?? loadConfig(deps.env ?? process.env)
  const api = new PotswapApi(config.apiBase, deps.fetchFn)
  const signer = deps.signer !== undefined ? deps.signer : loadSigner({ privateKey: config.privateKey, keypairPath: config.keypairPath, stateDir: config.stateDir })
  const balances = deps.balances ?? rpcBalances(config.rpcUrl)
  const rpcLazy = () => deps.rpc ?? rpcFromConnection(new Connection(config.rpcUrl, 'confirmed'))
  const ops = deps.ops ?? new FileOpsStore(config.stateDir)
  const json = (v: unknown) => io.out(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2))
  const walletOr = (w?: string) => (w && BASE58.test(w) ? w : signer?.publicKey ?? null)
  const fail = (msg: string, code = 1) => { io.err(msg); return code }
  const usage = (msg: string) => fail(`${msg}\n\n${USAGE}`, 2)
  const route = (o.route ?? 'jupiter') as 'jupiter' | 'direct' | 'auto'
  if (!['jupiter', 'direct', 'auto'].includes(route)) return usage('--route must be jupiter, direct or auto')

  const resolveMint = async (s?: string) => {
    if (!s) return null
    if (BASE58.test(s)) return s
    const sym = SYMBOLS[s.toUpperCase()]
    if (sym) return sym
    const hits = await api.searchTokens(s).catch(() => [])
    const hit = hits.find((t) => t.symbol.toLowerCase() === s.toLowerCase() && t.isVerified) ?? hits.find((t) => t.symbol.toLowerCase() === s.toLowerCase())
    return hit?.id ?? null
  }
  const slippage = o.slippage !== undefined ? Number(o.slippage) : undefined
  if (slippage !== undefined && !(slippage > 0)) return usage('--slippage must be a positive number of bps')

  try {
    switch (cmd) {
      case 'quote': case 'swap': {
        const [i, out, amt] = args
        if (!i || !out || !amt) return usage(`${cmd} needs <in> <out> <amount>`)
        const [inputMint, outputMint] = await Promise.all([resolveMint(i), resolveMint(out)])
        if (!inputMint || !outputMint) return fail(`Unknown token ${!inputMint ? i : out}. Use a mint address or SOL, USDC, USDT, JITOSOL, MSOL. No funds were debited.`)
        const amount = Number(amt)
        if (!(amount > 0)) return usage('amount must be a positive number in UI units')
        if (cmd === 'quote') {
          const q = await buildQuote(api, { inputMint, outputMint, amount, slippageBps: slippage })
          if (o.json) json(q); else io.out(`${q.inAmount} ${q.inputSymbol} → ${q.outAmount} ${q.outputSymbol} via ${q.router} · fee ${q.feeLabel ?? 'off'} (${q.feeBps} bps) · impact ${q.priceImpactPct}% · slippage ${q.slippageBps} bps`)
          return 0
        }
        return swapOut(await executeSwap({ api, config, signer, balances, rpc: route === 'jupiter' ? undefined : rpcLazy(), ops }, { inputMint, outputMint, amount, slippageBps: slippage, confirm: !!o.confirm, route, opId: o['op-id'] }), 'Swapped')
      }
      case 'stake': case 'unstake': {
        const amount = Number(args[0])
        if (!(amount > 0)) return usage(`${cmd} needs <amount>`)
        const lst = o.provider === 'marinade' ? MSOL_MINT : o.provider === 'jito' ? JITOSOL_MINT : null
        if (!lst) return usage('--provider must be jito or marinade')
        const [inputMint, outputMint] = cmd === 'stake' ? [SOL_MINT, lst] : [lst, SOL_MINT]
        return swapOut(await executeSwap({ api, config, signer, balances }, { inputMint, outputMint, amount, slippageBps: slippage, confirm: !!o.confirm }), cmd === 'stake' ? 'Staked' : 'Unstaked')
      }
      case 'balances': case 'positions': {
        const w = walletOr(args[0])
        if (!w) return fail(NO_WALLET)
        const bal = await balances(w)
        const mints = Object.keys(bal)
        const prices = mints.length ? await api.prices(mints).catch(() => ({} as Record<string, number>)) : {}
        const rows = mints.map((m) => ({ mint: m, amount: bal[m], usd: prices[m] ? bal[m] * prices[m] : undefined })).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
        if (o.json) json({ wallet: w, balances: rows }); else { io.out(`Wallet ${w}`); for (const r of rows) io.out(`  ${r.mint === SOL_MINT ? 'SOL' : r.mint}  ${r.amount}${r.usd !== undefined ? `  ($${r.usd.toFixed(2)})` : ''}`); if (!rows.length) io.out('  (empty)') }
        return 0
      }
      case 'wallet': {
        const sub = args[0]
        if (sub === 'create') {
          if (signer) return fail(`A wallet is already configured (${signer.publicKey}). Nothing was created.`)
          const { signer: s, file } = createWallet(config.stateDir)
          if (o.json) json({ publicKey: s.publicKey, file }); else io.out(`Wallet created: ${s.publicKey}\nSecret stored at ${file} (0600). Back it up; fund it with SOL and keep ≥ 0.01 SOL for fees.`)
          return 0
        }
        if (sub === 'show' || sub === undefined) {
          const data = { publicKey: signer?.publicKey ?? null, stateDir: config.stateDir, limits: { maxTradeSol: config.maxTradeSol, maxSlippageBps: config.maxSlippageBps, maxDailySol: config.maxDailySol, dryRun: config.dryRun }, allowedTokens: [...config.allowedTokens], allowedRecipients: [...config.allowedRecipients], api: config.apiBase }
          if (o.json) json(data); else io.out(`${signer ? `Wallet ${signer.publicKey}` : 'No wallet configured (run: potswap wallet create)'}\nstate: ${config.stateDir}\nlimits: maxTradeSol=${config.maxTradeSol} maxSlippageBps=${config.maxSlippageBps} maxDailySol=${config.maxDailySol}${config.dryRun ? ' DRY RUN' : ''}\nallowed tokens: ${data.allowedTokens.length ? data.allowedTokens.join(', ') : 'any'}\nallowed recipients: ${data.allowedRecipients.length ? data.allowedRecipients.join(', ') : 'any'}`)
          return 0
        }
        return usage('wallet create | show')
      }
      case 'transfer': {
        const [to, amt] = args
        const amount = Number(amt)
        if (!to || !(amount > 0)) return usage('transfer needs <to> <amount>')
        const mint = o.mint ? await resolveMint(o.mint) : undefined
        if (o.mint && !mint) return fail(`Unknown token ${o.mint}. No funds were debited.`)
        const rpc = rpcLazy()
        const r = await executeTransfer({ config, signer, rpc, balances, prices: (m) => api.prices(m), decimalsOf: async (m) => (await api.token(m)).decimals }, { to, mint: mint ?? undefined, amount, confirm: !!o.confirm })
        if (r.kind === 'ok') { if (o.json) json({ signature: r.signature, explorerUrl: r.explorerUrl }); else io.out(`${r.summary}\n${r.explorerUrl}`); return 0 }
        if (r.kind === 'quote-only') { io.out(`${r.summary}\nAdd --confirm to send.`); return 0 }
        if (r.kind === 'dry-run') { io.out(r.summary); return 0 }
        return fail(r.message)
      }
      case 'points': {
        const w = walletOr(args[0])
        if (!w) return fail(NO_WALLET)
        try {
          const p = await api.points(w)
          if (o.json) json(p); else io.out(`Wallet ${w}\npoints this epoch: $${Number(p.epochFeeUsd ?? 0).toFixed(2)} · all-time $${Number(p.allTimeFeeUsd ?? 0).toFixed(2)} · ${p.swapCount ?? 0} swaps\nreward balance: ${Number(p.rewardBalanceSol ?? 0).toFixed(6)} SOL${p.claimsOpen ? ' (claims open)' : ' (claims open at launch)'}\nlevel: ${levelLabel(p.level)} · season ${(p.season as { n?: number } | undefined)?.n ?? 0}\nPOT allocated: ${p.potAllocatedMicro ?? '0'} micro · claimable: ${p.potClaimableMicro ?? '0'} micro`)
          return 0
        } catch (e) {
          if (e instanceof ApiError && e.status === 503) { io.out(`Points engine not enabled yet for ${w}. Swaps still pay the fee; Season 0 counts every fee from the first ingest.`); return 0 }
          throw e
        }
      }
      case 'launch': {
        const l = await api.launchPool()
        const s = l.season as { n: number; dayIndex: number | null; end: string | null }
        const sp = l.splits as Record<string, number>
        if (o.json) json(l); else io.out(`Launch pool: ${l.balanceSol} / ${l.targetSol} SOL (${Math.round(Number(l.pct))}%)${l.enabled ? '' : ' — address not published yet'}${l.reached ? ' · target reached' : ''}\nSeason ${s.n}${s.dayIndex ? ` day ${s.dayIndex}/30` : ''}${s.end ? ` · ends ${s.end}` : ''}\nfee split: pool ${pct(sp.launchPool)} · reward balances ${pct(sp.rewardBalances)} · burn ${pct(sp.burn)} · team ${pct(sp.team)}\n${l.rules}`)
        return 0
      }
      case 'strategies': {
        const store = deps.store ?? new FileStore(config.stateDir)
        const [sub, id] = args
        const st = store.load()
        if (sub === 'list' || sub === undefined) {
          if (o.json) json({ stateFile: store.location, strategies: st.strategies }); else { io.out(`state: ${store.location}`); for (const s of st.strategies) io.out(`  ${s.id}  ${s.kind}  ${s.status}${s.pausedReason ? ` (${s.pausedReason})` : ''}  next=${s.nextRunAt ?? '—'}  runs=${s.totals.runs}  fees=$${s.totals.feeUsd.toFixed(2)}`); if (!st.strategies.length) io.out('  (none)') }
          return 0
        }
        if (!id) return usage(`strategies ${sub} needs <id>`)
        if (sub === 'runs') {
          if (!findStrategy(st, id)) return fail(`No strategy ${id}.`)
          const runs = runsOf(st, id, Number(o.limit) || 20)
          if (o.json) json({ id, runs }); else for (const r of runs) io.out(`${r.at} ${r.outcome}: ${r.action}${r.signature ? ` sig=${r.signature}` : ''}${r.message ? ` — ${r.message}` : ''}`)
          if (!runs.length && !o.json) io.out('No runs yet.')
          return 0
        }
        if (sub === 'delete') {
          const existed = store.update((x) => { const n = x.strategies.length; x.strategies = x.strategies.filter((s) => s.id !== id); return n !== x.strategies.length })
          if (!existed) return fail(`No strategy ${id}.`)
          io.out(`Deleted ${id}.`); return 0
        }
        if (sub === 'pause' || sub === 'resume') {
          let err: string | null = null
          const found = store.update((x) => {
            const s = findStrategy(x, id); if (!s) return false
            if (sub === 'pause') { s.status = 'paused'; s.pausedReason = 'paused by user'; s.nextRunAt = null }
            else { if (s.status === 'completed') { err = 'Completed strategies cannot be resumed; create a new one.'; return true } s.status = 'active'; s.pausedReason = undefined; s.consecutiveFailures = 0; s.nextRunAt = s.kind === 'tpsl' || s.kind === 'limit' ? null : nextRunAfter(s as DcaStrategy | RebalanceStrategy, (deps.now ?? Date.now)()) }
            return true
          })
          if (!found) return fail(`No strategy ${id}.`)
          if (err) return fail(err)
          io.out(`${sub === 'pause' ? 'Paused' : 'Resumed'} ${id}.`); return 0
        }
        return usage('strategies list | runs <id> | pause <id> | resume <id> | delete <id>')
      }
      case 'observations': {
        const mint = await resolveMint(args[0])
        if (!mint) return usage('observations needs <mint>')
        const kind = (o.kind ?? 'price') as ObservationKind
        if (!OBSERVATION_KINDS.includes(kind)) return usage(`--kind must be one of ${OBSERVATION_KINDS.join(', ')}`)
        const r = await api.observations({ mint, kind, limit: Number(o.limit) || 50 })
        const agg = aggregate(r.items, kind, mint, r.now ?? (deps.now ?? Date.now)())
        if (o.json) json({ ...r, aggregate: agg }); else { io.out(`${agg.count} fresh ${kind} observation(s) from ${agg.publishers} publisher(s)${agg.median !== null ? ` · median ${agg.median} · spread ${agg.spreadPct?.toFixed(2)}%` : ''}`); for (const x of r.items.slice(0, 20)) io.out(`  ${new Date(x.observedAt).toISOString()} ${x.value} ${x.unit} by ${x.publisher.slice(0, 6)}… (${x.source}, slot ${x.slot})`) }
        return 0
      }
      case 'observe': {
        if (!signer) return fail(NO_WALLET)
        const mints = (await Promise.all(args.map((a) => resolveMint(a)))).filter((m): m is string => !!m)
        if (!mints.length) return usage('observe needs at least one <mint>')
        const kinds = String(o.kinds).split(',').map((k) => k.trim()).filter(Boolean) as ObservationKind[]
        for (const k of kinds) if (!['price', 'liquidity', 'holders', 'volume24h'].includes(k)) return usage(`--kinds may include price, liquidity, holders, volume24h (got ${k})`)
        const interval = Math.max(10, Number(o.interval) || 60)
        const getSlot = deps.getSlot ?? (() => new Connection(config.rpcUrl, 'confirmed').getSlot())
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
        let stop = false
        const onSig = () => { stop = true }
        process.once('SIGINT', onSig); process.once('SIGTERM', onSig)
        let published = 0
        do {
          const slot = await getSlot()
          const prices = kinds.includes('price') ? await api.prices(mints).catch(() => ({} as Record<string, number>)) : {}
          for (const m of mints) {
            const tok = kinds.some((k) => k !== 'price') ? await api.token(m).catch(() => null) as (Record<string, unknown> | null) : null
            const values: Partial<Record<ObservationKind, number | undefined>> = { price: prices[m], liquidity: tok ? Number(tok.liquidity) || undefined : undefined, holders: tok ? Number(tok.holderCount) || undefined : undefined, volume24h: tok && tok.stats24h ? Number((tok.stats24h as { volume?: number }).volume) || undefined : undefined }
            for (const k of kinds) {
              const v = values[k]
              if (v === undefined) { io.err(`${m.slice(0, 6)}… ${k}: no data, skipped`); continue }
              try {
                const obs = signObservation(signer, { kind: k, mint: m, value: v, source: String(o.source), slot, now: (deps.now ?? Date.now)() })
                const r = await api.publishObservation(obs)
                published++
                io.out(`${new Date(obs.observedAt).toISOString()} ${k} ${m.slice(0, 6)}… = ${v} ${obs.unit} slot ${slot} → ${r.duplicate ? 'duplicate' : obs.id}`)
              } catch (e) { io.err(`${m.slice(0, 6)}… ${k}: ${e instanceof Error ? e.message : String(e)}`) }
            }
          }
          if (o.once) break
          await sleep(interval * 1000)
        } while (!stop)
        process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig)
        if (o.json) json({ published })
        return 0
      }
      case 'lend': {
        const [sub, m, amt] = args
        const defi = (r: LendOutcome | LpOutcome, verb: string) => {
          if (r.kind === 'no-wallet' || r.kind === 'refused' || r.kind === 'failed') return fail(r.message)
          if (r.kind === 'plan') { if (o.json) json({ confirmRequired: true, plan: r.plan }); else io.out(`${JSON.stringify(r.plan)}\nAdd --confirm to execute.`); return 0 }
          if (r.kind === 'dry-run') { if (o.json) json({ dryRun: true, plan: r.plan }); else io.out(`DRY RUN, nothing signed: ${JSON.stringify(r.plan)}`); return 0 }
          if (r.kind !== 'ok') return fail('Unexpected outcome. No funds were debited.')
          if (o.json) json(r.result); else io.out(`${verb}. ${String(r.result.explorerUrl)}${r.result.feeNote ? `\n${String(r.result.feeNote)}` : ''}`)
          return 0
        }
        if (sub === 'markets' || sub === undefined) { const ms = normalizeMarkets(await api.lendTokens()); if (o.json) json({ markets: ms }); else for (const x of ms) io.out(`${x.assetSymbol.padEnd(6)} ${x.supplyApyPct.toFixed(2)}% APY · ${x.totalAssets.toLocaleString(undefined, { maximumFractionDigits: 0 })} deposited · ${x.assetMint}`); return 0 }
        if (sub === 'positions') { const w = walletOr(m); if (!w) return fail(NO_WALLET); const ps = normalizePositions(await api.lendPositions([w])); if (o.json) json({ wallet: w, positions: ps }); else { for (const x of ps) io.out(`${x.assetSymbol}: ${x.underlying}${x.underlyingUsd !== undefined ? ` ($${x.underlyingUsd.toFixed(2)})` : ''}`); if (!ps.length) io.out('No lending positions.') } return 0 }
        if (sub === 'deposit' || sub === 'withdraw') {
          const mint = await resolveMint(m); if (!mint) return usage(`lend ${sub} needs <mint> <amount>`)
          const amount = sub === 'withdraw' && amt === 'all' ? 'all' as const : Number(amt)
          if (amount !== 'all' && !(amount > 0)) return usage(`lend ${sub} needs a positive amount${sub === 'withdraw' ? ' or all' : ''}`)
          return defi(await executeLend({ api, config, signer, balances, rpc: rpcLazy(), ops }, { action: sub, mint, amount, confirm: !!o.confirm }), sub === 'deposit' ? 'Deposited' : 'Withdrew')
        }
        return usage('lend markets | positions [wallet] | deposit <mint> <amount> | withdraw <mint> <amount|all>')
      }
      case 'lp': {
        const [sub, poolId, m, amt] = args
        const rpc = rpcLazy()
        if (!rpc.getAccountsData) return fail('Liquidity operations need an RPC connection.')
        const read = rpc.getAccountsData.bind(rpc)
        const defi = (r: LpOutcome, verb: string) => {
          if (r.kind === 'no-wallet' || r.kind === 'refused' || r.kind === 'failed') return fail(r.message)
          if (r.kind === 'plan') { if (o.json) json({ confirmRequired: true, plan: r.plan }); else io.out(`${JSON.stringify(r.plan)}\nAdd --confirm to execute.`); return 0 }
          if (r.kind === 'dry-run') { if (o.json) json({ dryRun: true, plan: r.plan }); else io.out(`DRY RUN, nothing signed: ${JSON.stringify(r.plan)}`); return 0 }
          if (r.kind !== 'ok') return fail('Unexpected outcome. No funds were debited.')
          if (o.json) json(r.result); else io.out(`${verb}. ${String(r.result.explorerUrl)}`)
          return 0
        }
        if (sub === 'pools') { const [a, b] = await Promise.all([resolveMint(poolId), resolveMint(m)]); if (!a || !b) return usage('lp pools <mintA> <mintB>'); const ps = await lpPools(api, read, a, b); if (o.json) json({ pools: ps }); else { for (const x of ps) io.out(`${x.poolId}  ${x.reserve0} / ${x.reserve1}  fee ${x.tradeFeeBps} bps${x.tvlUsd ? `  TVL $${x.tvlUsd.toFixed(0)}` : ''}`); if (!ps.length) io.out('No CPMM pool for this pair.') } return 0 }
        if (!poolId || !BASE58.test(poolId)) return usage('lp needs a <poolId>')
        if (sub === 'position') { const w = walletOr(m); if (!w) return fail(NO_WALLET); const pos = await lpPosition(read, await balances(w), poolId); if (!pos) return fail('Pool not found or not a Raydium CPMM pool.'); if (o.json) json({ wallet: w, ...pos, lpBalanceRaw: pos.lpBalanceRaw.toString() }); else io.out(`${pos.lpBalance} LP (${pos.sharePct.toFixed(4)}%) ≈ ${pos.amount0} ${pos.token0Mint.slice(0, 4)}… + ${pos.amount1} ${pos.token1Mint.slice(0, 4)}…`); return 0 }
        if (sub === 'deposit') { const mint = await resolveMint(m); const amount = Number(amt); if (!mint || !(amount > 0)) return usage('lp deposit <poolId> <mint> <amount>'); return defi(await executeLpDeposit({ api, config, signer, balances, rpc, ops }, { poolId, mint, amount, slippageBps: slippage, confirm: !!o.confirm }), 'Liquidity added') }
        if (sub === 'withdraw') { const v = String(m ?? ''); const pct = v.endsWith('%') ? Number(v.slice(0, -1)) : undefined; const lpAmount = pct === undefined ? Number(v) : undefined; if (!(pct! > 0) && !(lpAmount! > 0)) return usage('lp withdraw <poolId> <lpAmount|pct%>'); return defi(await executeLpWithdraw({ api, config, signer, balances, rpc, ops }, { poolId, lpAmount, pct, slippageBps: slippage, confirm: !!o.confirm }), 'Liquidity removed') }
        return usage('lp pools <mintA> <mintB> | position <poolId> | deposit <poolId> <mint> <amount> | withdraw <poolId> <lpAmount|pct%>')
      }
      case 'admin': {
        const secret = o.secret ?? (deps.env ?? process.env).CRON_SECRET ?? ''
        return runAdmin(args[0], o as AdminFlags, { api, config, signer, balances, rpc: rpcLazy(), io, secret })
      }
      case 'daemon': {
        const store = deps.store ?? new FileStore(config.stateDir)
        const lock = acquireLock(config.stateDir)
        if (!lock.acquired) return fail(`Another scheduler (pid ${lock.ownerPid}) already runs on ${store.location}.`, 2)
        const scheduler = new Scheduler({ store, trade: { api, config, signer, balances }, maxDailySol: config.maxDailySol })
        scheduler.start()
        io.err(`potswap daemon · state=${store.location} · maxTradeSol=${config.maxTradeSol} · maxDailySol=${config.maxDailySol}${config.dryRun ? ' · DRY RUN' : ''}${signer ? ` · wallet=${signer.publicKey}` : ' · no wallet (strategies cannot execute)'}`)
        await new Promise<void>((resolve) => { const stop = async () => { io.err('stopping after the in-flight leg…'); await scheduler.stop(); lock.release(); resolve() }; process.once('SIGINT', stop); process.once('SIGTERM', stop) })
        return 0
      }
      default:
        return usage(`Unknown command: ${cmd}`)
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }

  function swapOut(r: Awaited<ReturnType<typeof executeSwap>>, verb: string): number {
    switch (r.kind) {
      case 'no-wallet': return fail(r.message)
      case 'refused': io.err(r.message); if (o.json) json({ error: r.message, quote: r.quote }); return 1
      case 'quote-only': if (o.json) json({ confirmRequired: true, quote: r.quote }); else io.out(`${r.quote.inAmount} ${r.quote.inputSymbol} → ${r.quote.outAmount} ${r.quote.outputSymbol} via ${r.quote.router} · fee ${r.quote.feeLabel ?? 'off'}\nAdd --confirm to execute.`); return 0
      case 'dry-run': if (o.json) json({ dryRun: true, quote: r.quote }); else io.out(`DRY RUN, nothing signed: ${r.quote.inAmount} ${r.quote.inputSymbol} → ${r.quote.outAmount} ${r.quote.outputSymbol}`); return 0
      case 'failed': io.err(r.message); if (o.json) json({ error: r.message, signature: r.signature }); return 1
      case 'ok': if (o.json) json(r.result); else io.out(`${r.result.replayed ? 'Already done (replayed): ' : `${verb}: `}${r.result.inAmount} ${r.result.inputSymbol} → ${r.result.outAmount} ${r.result.outputSymbol} via ${r.result.router} · fee $${(r.result.feeUsd ?? 0).toFixed(4)} · +${(r.result.pointsAdded ?? 0).toFixed(4)} points\n${r.result.explorerUrl}`); return 0
    }
  }
}

const pct = (n: number | undefined) => `${Math.round((n ?? 0) * 100)}%`

// Keep MemoryStore referenced for consumers that embed the CLI in tests.
export { MemoryStore }
