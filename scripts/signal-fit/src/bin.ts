#!/usr/bin/env bun

import { main } from './index'

process.on('SIGINT', () => {
  console.log('\nCancelled.')
  process.exit(130)
})

const exitCode = await main(process.argv.slice(2))
process.exit(exitCode)
