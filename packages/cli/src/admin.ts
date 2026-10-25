// PRD P12.1 / P12.5 / P12.12 — the owner-run jobs: treasury sweep, claims worker, buy-and-burn.
// Dry-run by default: every command prints its plan and only acts with --execute. The signer is the owner's
// hot key (fee wallet owner for sweep / burn, the claims hot wallet for claims); never a user's key.
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { executeSwap, executeTransfer, matchClaims, splitAmounts, toRaw, fromRaw, explorer, validateTransaction, DEFAULT_ALLOWED_PROGRAMS, SOL_MINT, USDC_MINT, NO_WALLET, type PotswapApi, type Config, type Signer, type BalancesFn, type Rpc, type Claim } from '@potswap_io/sdk'

export interface AdminIo { out(l: string): void; err(l: string): void }
export interface AdminDeps { api: PotswapApi; config: Config; signer: Signer | null; balances: BalancesFn; rpc: Rpc; io: AdminIo; secret: string; now?: () => number; random?: () => number; sleep?: (ms: number) => Promise<void> }
export interface AdminFlags { execute?: boolean; json?: boolean; pool?: string; reward?: string; team?: string; 'pot-mint'?: string; budget?: string; sol?: string; mints?: string; 'max-delay-min'?: string }

const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export const ADMIN_USAGE = `potswap admin <job> [--execute] (dry-run without --execute; needs CRON_SECRET or --secret for the admin API)

  sweep  --pool <addr> --reward <addr> --team <addr> [--mints SOL,USDC,USDT]
         moves the fee balances held by this wallet per the season split (P12.1); the burn share stays for the burn job
  claims --pot-mint <mint> [--budget <sol>]
         fills open claim intents oldest-first at the current POT price: buy POT, send it to the claimant, record the fill (P12.5)
  burn   --pot-mint <mint> --sol <amount> [--max-delay-min <n>]
         buys POT with SOL and burns it, after a random delay (P12.12); records the burn`

/** Admin context: caps lifted (these are the owner's own funds), recipients restricted to the given destinations. */
const adminCtx = (d: AdminDeps, recipients: string[]) => ({ api: d.api, config: { ...d.config, maxTradeSol: Number.MAX_SAFE_INTEGER, allowedRecipients: new Set(recipients), allowedTokens: new Set<string>() }, signer: d.signer, balances: d.balances, rpc: d.rpc, prices: (m: string[]) => d.api.prices(m), decimalsOf: async (m: string) => (await d.api.token(m)).decimals })

export async function runAdmin(job: string | undefined, f: AdminFlags, d: AdminDeps): Promise<number> {
  const { io } = d
  const json = (v: unknown) => io.out(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2))
  if (!job) { io.out(ADMIN_USAGE); return 2 }
  if (!d.signer) { io.err(NO_WALLET); return 1 }
  if (!d.secret) { io.err('CRON_SECRET (or --secret) is required for the admin API. Nothing was done.'); return 2 }
  const now = d.now ?? Date.now
  try {
    switch (job) {
      case 'sweep': {
        const dest = { pool: f.pool, reward: f.reward, team: f.team }
        const cfg = await d.api.config()
        const season = (cfg as { season?: { n: number } }).season?.n ?? 0
        const mints = (f.mints ?? 'SOL,USDC,USDT').split(',').map((m) => m.trim()).map((m) => ({ SOL: SOL_MINT, USDC: USDC_MINT, USDT: USDT_MINT }[m.toUpperCase()] ?? m)).filter((m) => BASE58.test(m))
        const bal = await d.balances(d.signer.publicKey)
        const plan: Record<string, unknown>[] = []
        for (const mint of mints) {
          const have = (bal[mint] ?? 0) - (mint === SOL_MINT ? 0.05 : 0) // keep SOL for fees
          if (have <= 0) continue
          const s = splitAmounts(have, season)
          plan.push({ mint, net: have, season, launchPool: s.launchPool, rewardBalances: s.rewardBalances, burnRetained: s.burn, team: s.team })
        }
        const needed = ([['pool', 'launchPool'], ['reward', 'rewardBalances'], ['team', 'team']] as const).filter(([, k]) => plan.some((p) => (p[k] as number) > 0)).map(([k]) => k)
        const missing = needed.filter((k) => !dest[k] || !BASE58.test(dest[k]!))
        if (missing.length) { io.err(`Missing destination(s): ${missing.map((k) => `--${k}`).join(', ')}. Nothing was moved.`); return 2 }
        if (!f.execute) { if (f.json) json({ dryRun: true, plan }); else { for (const p of plan) io.out(`${p.mint}: ${p.net} → pool ${p.launchPool} · reward ${p.rewardBalances} · team ${p.team} · burn share kept ${p.burnRetained}`); io.out(plan.length ? 'Add --execute to move the funds.' : 'Nothing to sweep.') } return 0 }
        const results: Record<string, unknown>[] = []
        for (const p of plan) {
          for (const [k, key] of [['pool', 'launchPool'], ['reward', 'rewardBalances'], ['team', 'team']] as const) {
            const amount = p[key] as number
            if (amount <= 0) continue
            const r = await executeTransfer(adminCtx(d, [dest[k]!]), { to: dest[k]!, mint: p.mint === SOL_MINT ? undefined : (p.mint as string), amount: Math.floor(amount * 1e6) / 1e6, confirm: true })
            if (r.kind !== 'ok') { io.err(`${p.mint} → ${k}: ${'message' in r ? r.message : r.kind}`); results.push({ mint: p.mint, to: k, amount, error: 'message' in r ? r.message : r.kind }); continue }
            io.out(`${p.mint} → ${k}: ${amount} ${r.explorerUrl}`)
            results.push({ mint: p.mint, to: k, amount, signature: r.signature })
          }
        }
        await d.api.adminLedger(d.secret, { kind: 'treasury', micro: '0', note: JSON.stringify({ season, sweep: results }).slice(0, 500) })
        if (f.json) json({ executed: true, results })
        return results.some((r) => r.error) ? 1 : 0
      }
      case 'claims': {
        const potMint = f['pot-mint']
        if (!potMint || !BASE58.test(potMint)) { io.err('--pot-mint is required. Nothing was done.'); return 2 }
        const budget = Number(f.budget) || 1
        const raw = await d.api.adminClaims(d.secret)
        const claims: Claim[] = raw.map((c) => ({ ...c, potMicro: BigInt(c.potMicro), createdAt: new Date(c.createdAt), expiresAt: c.expiresAt ? new Date(c.expiresAt) : null }))
        const price = (await d.api.prices([potMint]).catch(() => ({} as Record<string, number>)))[potMint]
        const m = matchClaims(claims, price ?? 0, budget, now())
        if (!f.execute) { if (f.json) json({ dryRun: true, potPriceUsd: price ?? null, fills: m.fills, expired: m.expired }); else { io.out(`POT ${price !== undefined ? `$${price}` : 'price unavailable'} · ${claims.length} open · ${m.fills.length} fill(s) within ${budget} SOL · ${m.expired.length} expired`); for (const x of m.fills) io.out(`  fill ${x.claimId}: ${x.sol} SOL → ${x.wallet}`); io.out('Add --execute to run.') } return 0 }
        for (const id of m.expired) await d.api.adminClaimAction(d.secret, { action: 'expire', id })
        if (!price) { io.err('POT price unavailable; no fills executed.'); return m.expired.length ? 0 : 1 }
        const tok = await d.api.token(potMint)
        const done: Record<string, unknown>[] = []
        for (const x of m.fills) {
          const buy = await executeSwap(adminCtx(d, []), { inputMint: SOL_MINT, outputMint: potMint, amount: x.sol, confirm: true })
          if (buy.kind !== 'ok') { io.err(`claim ${x.claimId}: buy failed: ${'message' in buy ? buy.message : buy.kind}`); done.push({ id: x.claimId, error: 'buy failed' }); continue }
          // the POT just bought is in the wallet even if the balance read lags a slot
          const ctxT = { ...adminCtx(d, [x.wallet]), balances: async (w: string) => { const b = await d.balances(w); return { ...b, [potMint]: Math.max(b[potMint] ?? 0, buy.result.outAmount) } } }
          const send = await executeTransfer(ctxT, { to: x.wallet, mint: potMint, amount: buy.result.outAmount, decimals: tok.decimals, confirm: true })
          if (send.kind !== 'ok') { io.err(`claim ${x.claimId}: POT bought (${buy.result.signature}) but the transfer failed: ${'message' in send ? send.message : send.kind}. Resolve manually.`); done.push({ id: x.claimId, buySignature: buy.result.signature, error: 'transfer failed' }); continue }
          await d.api.adminClaimAction(d.secret, { action: 'fill', id: x.claimId, sol: x.sol, potMicro: toRaw(buy.result.outAmount, tok.decimals), signature: buy.result.signature })
          io.out(`claim ${x.claimId}: ${x.sol} SOL → ${buy.result.outAmount} POT → ${x.wallet} (${send.explorerUrl})`)
          done.push({ id: x.claimId, sol: x.sol, pot: buy.result.outAmount, buySignature: buy.result.signature, transferSignature: send.signature })
        }
        if (f.json) json({ executed: true, expired: m.expired, fills: done })
        return done.some((r) => r.error) ? 1 : 0
      }
      case 'burn': {
        const potMint = f['pot-mint']; const sol = Number(f.sol)
        if (!potMint || !BASE58.test(potMint) || !(sol > 0)) { io.err('--pot-mint and --sol are required. Nothing was done.'); return 2 }
        const maxDelay = Number(f['max-delay-min']) || 0
        if (!f.execute) { io.out(`Would buy POT with ${sol} SOL and burn it${maxDelay ? ` after a random delay of up to ${maxDelay} min` : ''}. Add --execute to run.`); return 0 }
        if (maxDelay > 0) { const ms = Math.floor((d.random ?? Math.random)() * maxDelay * 60_000); io.out(`waiting ${Math.round(ms / 1000)} s`); await (d.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms) }
        const buy = await executeSwap(adminCtx(d, []), { inputMint: SOL_MINT, outputMint: potMint, amount: sol, confirm: true })
        if (buy.kind !== 'ok') { io.err(`buy failed: ${'message' in buy ? buy.message : buy.kind}`); return 1 }
        const tok = await d.api.token(potMint)
        const owner = new PublicKey(d.signer.publicKey), mint = new PublicKey(potMint)
        const amountRaw = BigInt(toRaw(buy.result.outAmount, tok.decimals))
        const { blockhash, lastValidBlockHeight } = await d.rpc.getLatestBlockhash('confirmed')
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [createBurnCheckedInstruction(getAssociatedTokenAddressSync(mint, owner), mint, owner, amountRaw, tok.decimals)] }).compileToV0Message())
        const report = validateTransaction(tx, { signer: d.signer.publicKey, allowedPrograms: DEFAULT_ALLOWED_PROGRAMS })
        if (!report.ok) { io.err(`burn refused by the validator: ${report.reasons.join('; ')}`); return 1 }
        d.signer.sign(tx)
        const signature = await d.rpc.sendRawTransaction(tx.serialize())
        const conf = await d.rpc.confirmTransaction(signature, blockhash, lastValidBlockHeight)
        if (conf.err) { io.err(`burn failed on-chain: ${JSON.stringify(conf.err)} ${explorer(signature)}`); return 1 }
        await d.api.adminLedger(d.secret, { kind: 'burn', micro: amountRaw.toString(), note: JSON.stringify({ sol, buy: buy.result.signature, burn: signature }) })
        io.out(`Bought ${buy.result.outAmount} POT with ${sol} SOL (${buy.result.explorerUrl}) and burned it: ${explorer(signature)}`)
        if (f.json) json({ sol, pot: buy.result.outAmount, potMicro: amountRaw.toString(), buySignature: buy.result.signature, burnSignature: signature })
        return 0
      }
      default:
        io.err(`Unknown admin job: ${job}\n\n${ADMIN_USAGE}`); return 2
    }
  } catch (e) { io.err(e instanceof Error ? e.message : String(e)); return 1 }
}

export { fromRaw }
