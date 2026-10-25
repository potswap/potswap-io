// PRD P15 — observation tools: publish, query, verify, consume. Reads are free; publishing needs a wallet (to sign).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Connection } from '@solana/web3.js'
import { z } from 'zod'
import { NO_WALLET, OBSERVATION_KINDS, aggregate, redact, redactValue, signConsumption, signObservation, verifyObservation, type Config, type TradeContext } from '@potswap_io/sdk'

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
const ok = (data: Record<string, unknown>, summary?: string): ToolResult => ({ content: [{ type: 'text', text: redact(summary ?? JSON.stringify(data, null, 2)) }], structuredContent: redactValue(data) })
const fail = (message: string, extra: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: 'text', text: redact(message) }], structuredContent: redactValue({ error: message, ...extra }), isError: true })
const MINT = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
const KIND = z.enum(OBSERVATION_KINDS)

export interface ObservationToolDeps { trade: TradeContext; config: Config; getSlot?: () => Promise<number> }

export function registerObservationTools(server: McpServer, deps: ObservationToolDeps) {
  const { trade, config } = deps
  const api = trade.api
  const getSlot = deps.getSlot ?? (() => new Connection(config.rpcUrl, 'confirmed').getSlot())

  server.registerTool('observe_publish', {
    title: 'Publish a signed observation',
    description: 'Signs a market observation (price, liquidity, volume24h, holders, risk, route) with the agent wallet, anchored to the current slot, and posts it to the open Potswap index. Free; no funds move. Other agents can verify and consume it; verified consumption earns the publisher Season 2 rewards.',
    inputSchema: { kind: KIND, mint: MINT, value: z.number().finite(), unit: z.string().min(1).max(16).optional(), source: z.string().min(1).max(64), ttlSec: z.number().int().min(10).max(86400).default(300), note: z.string().max(280).optional() },
  }, async (a) => {
    if (!trade.signer) return fail(NO_WALLET)
    try {
      const slot = await getSlot()
      const obs = signObservation(trade.signer, { ...a, slot })
      const r = await api.publishObservation(obs)
      return ok({ ...obs, ...r }, `Published ${a.kind} for ${a.mint.slice(0, 4)}… = ${a.value} ${obs.unit} (id ${obs.id}, slot ${slot}, ttl ${obs.ttlSec}s)${r.duplicate ? ' — already indexed' : ''}.`)
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('observe_query', {
    title: 'Query observations',
    description: 'Fresh observations from the open index, newest first, with a per-publisher median aggregate when mint and kind are given. Free, no wallet needed.',
    inputSchema: { mint: MINT.optional(), kind: KIND.optional(), publisher: MINT.optional(), limit: z.number().int().min(1).max(200).default(50), includeStale: z.boolean().default(false) },
  }, async (a) => {
    try {
      const r = await api.observations({ mint: a.mint, kind: a.kind, publisher: a.publisher, limit: a.limit, fresh: !a.includeStale })
      const agg = a.mint && a.kind ? aggregate(r.items, a.kind, a.mint, r.now ?? Date.now()) : undefined
      return ok({ ...r, ...(agg ? { aggregate: agg } : {}) }, agg
        ? `${agg.count} fresh ${a.kind} observation(s) from ${agg.publishers} publisher(s)${agg.median !== null ? ` · median ${agg.median} · spread ${agg.spreadPct?.toFixed(2)}%` : ''}`
        : `${r.items.length} observation(s)` + (r.items.length ? `\n` + r.items.slice(0, 10).map((o) => `${new Date(o.observedAt).toISOString()} ${o.kind} ${o.mint.slice(0, 4)}… = ${o.value} ${o.unit} by ${o.publisher.slice(0, 4)}… (${o.source})`).join('\n') : ''))
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })

  server.registerTool('observe_verify', {
    title: 'Verify an observation',
    description: 'Checks an observation locally: schema, id, Ed25519 signature by its publisher, freshness; for price observations also the deviation from the current Potswap price.',
    inputSchema: { observation: z.record(z.string(), z.unknown()) },
  }, async ({ observation }) => {
    const o = observation as { kind?: string; mint?: string }
    let referencePrice: number | null = null
    if (o.kind === 'price' && o.mint) referencePrice = (await api.prices([o.mint]).catch(() => ({} as Record<string, number>)))[o.mint] ?? null
    const v = verifyObservation(observation, { referencePrice })
    return ok({ ...v, referencePrice }, v.ok ? `Valid${v.fresh ? ', fresh' : ', expired'}${v.deviationPct !== undefined && v.deviationPct !== null ? ` · ${v.deviationPct >= 0 ? '+' : ''}${v.deviationPct.toFixed(2)}% vs current price` : ''}.` : `Invalid: ${v.reason}`)
  })

  server.registerTool('observe_consume', {
    title: 'Record that you used an observation',
    description: 'Signs a receipt with the agent wallet saying this observation informed a decision. Receipts weight the publisher\'s Season 2 rewards. Free.',
    inputSchema: { id: z.string().regex(/^[0-9a-f]{32}$/) },
  }, async ({ id }) => {
    if (!trade.signer) return fail(NO_WALLET)
    try {
      const r = await api.consumeObservation(signConsumption(trade.signer, id))
      return ok(r, `Receipt recorded for ${id} (publisher ${String(r.publisher).slice(0, 4)}…)${r.duplicate ? ' — already recorded' : ''}.`)
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
  })
}
