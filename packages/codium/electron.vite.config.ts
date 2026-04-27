import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

// electron-vite auto-externalizes `electron`, node builtins, and our
// package.json dependencies — but only when you use the `lib.entry`
// config form. Switching to `rollupOptions.input` (multi-entry, needed
// for the agent-worker bundle) bypasses that, so we re-list them here.
const PKG = JSON.parse(
    readFileSync(resolve(__dirname, 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string> }
const PKG_DEPS = Object.keys(PKG.dependencies ?? {})
const NODE_BUILTINS = builtinModules.flatMap((m) => [m, `node:${m}`])
const MAIN_EXTERNALS: (string | RegExp)[] = [
    'electron',
    /^electron\/.+/,
    ...NODE_BUILTINS,
    ...PKG_DEPS,
    new RegExp(`^(${PKG_DEPS.map(escapeRegex).join('|')})/.+`),
]
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            // Two entries: the main process and the agent worker.
            // The worker is launched by the main process via Node
            // worker_threads — so it runs in the main bundle's `out/main`
            // directory next to index.js, and externalized deps resolve
            // from the same node_modules.
            rollupOptions: {
                input: {
                    index: resolve(__dirname, 'sources/boot/main/index.ts'),
                    'agent-worker': resolve(
                        __dirname,
                        'sources/boot/main/agent-worker/worker.ts',
                    ),
                },
                external: MAIN_EXTERNALS,
                output: {
                    entryFileNames: '[name].js',
                    format: 'es',
                },
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: {
            lib: {
                entry: resolve(__dirname, 'sources/boot/preload/index.ts'),
            },
        },
    },
    renderer: {
        root: resolve(__dirname, 'sources'),
        resolve: {
            alias: {
                '@': resolve(__dirname, 'sources'),
            },
            dedupe: ['react', 'react-dom'],
        },
        plugins: [react(), tailwindcss()],
        build: {
            rollupOptions: {
                input: resolve(__dirname, 'sources/index.html'),
            },
        },
    },
})
