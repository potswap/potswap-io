#!/usr/bin/env node
import { run } from './cli.js'

run(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1 })
