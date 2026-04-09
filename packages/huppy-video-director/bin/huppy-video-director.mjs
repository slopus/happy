#!/usr/bin/env node

const { buildProgram } = await import('../dist/index.mjs')

await buildProgram().parseAsync(process.argv)
