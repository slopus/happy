/**
 * Browser Runtime process entry (Agent Browser): runs `runRuntime` and turns a
 * start-up failure into a one-line fatal message and exit status 1. See
 * runtimeProcess.ts for modes and environment.
 */
import { BrowserRuntimeError } from './contracts'
import { runRuntime } from './runtimeProcess'

void runRuntime().catch((error) => {
    // Messages here are ours (config/lock errors); unexpected errors are reduced to their name.
    const detail = error instanceof BrowserRuntimeError ? `${error.code} ${error.message}`
        : error instanceof Error && error.message.startsWith('ABP') ? error.message
            : error instanceof Error ? error.name : 'unknown'
    process.stderr.write(`[abp-runtime] fatal ${detail}\n`)
    process.exit(1)
})
