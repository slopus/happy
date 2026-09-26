#!/usr/bin/env node
// Bundle src/browserRuntime/runtimeMain.ts into one self-contained ESM file for
// the runtime container (node:22, no node_modules inside). Uses the esbuild
// that tsx already ships with, so no new dependency is added.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '../..')
const requireFromTsx = createRequire(createRequire(join(packageDir, 'package.json')).resolve('tsx/package.json'))
const esbuild = requireFromTsx('esbuild')

const outfile = resolve(process.argv[2] ?? join(here, '.abp', 'runtime.mjs'))
mkdirSync(dirname(outfile), { recursive: true })

await esbuild.build({
    entryPoints: [join(packageDir, 'src/browserRuntime/runtimeMain.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // ws probes these optional native addons with try/require.
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __abpCreateRequire } from 'node:module'; const require = __abpCreateRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
})
console.log(outfile)
