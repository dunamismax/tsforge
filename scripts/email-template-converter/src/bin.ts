#!/usr/bin/env bun

import { main } from './index'

const exitCode = await main(process.argv.slice(2))
process.exit(exitCode)
