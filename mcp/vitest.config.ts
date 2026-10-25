import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Tests run against the SDK sources so no build step is needed.
export default defineConfig({ resolve: { alias: { '@potswap_io/sdk': fileURLToPath(new URL('../packages/sdk/src/index.ts', import.meta.url)) } } })
