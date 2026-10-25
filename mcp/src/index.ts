#!/usr/bin/env node
// Potswap MCP server over stdio, or `--daemon` to run strategies headlessly (PRD P11.11).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer, VERSION } from './server.js'
import { loadConfig } from '@potswap_io/sdk'
import { log } from '@potswap_io/sdk'
import { createRuntime } from '@potswap_io/sdk'

const config = loadConfig()
const daemon = process.argv.includes('--daemon')
const rt = createRuntime(config)

if (daemon) {
  if (!rt.scheduler) {
    log(`potswap-mcp v${VERSION}: another scheduler (pid ${rt.lockOwner}) already runs on ${rt.store.location}; exiting.`)
    process.exit(2)
  }
  rt.scheduler.start()
  log(`potswap-mcp v${VERSION} daemon · state=${rt.store.location} · maxTradeSol=${config.maxTradeSol} · maxDailySol=${config.maxDailySol}${config.dryRun ? ' · DRY RUN' : ''}${rt.signer ? ` · wallet=${rt.signer.publicKey}` : ' · no wallet (strategies cannot execute)'}`)
  const shutdown = async () => { log('stopping after the in-flight leg…'); await rt.scheduler!.stop(); rt.release(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
} else {
  const server = createServer({ config, signer: rt.signer, strategyStore: rt.store, scheduler: rt.scheduler ?? undefined })
  rt.scheduler?.start()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`potswap-mcp v${VERSION} ready · api=${config.apiBase} · maxTradeSol=${config.maxTradeSol} · maxSlippageBps=${config.maxSlippageBps}${config.dryRun ? ' · DRY RUN' : ''}${rt.signer ? '' : ' · no wallet (read-only)'}${rt.scheduler ? ' · scheduler on' : ` · scheduler owned by pid ${rt.lockOwner}`}`)
  process.on('exit', () => rt.release())
}
