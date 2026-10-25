import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({ resolve: { alias: { '@potswap_io/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)) } } })
