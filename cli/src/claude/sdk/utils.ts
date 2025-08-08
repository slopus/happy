/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '@/ui/logger'

/**
 * Get the directory path of the current module
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')

/**
 * Get default path to Claude Code executable
 */
export function getDefaultClaudeCodePath(): string {
    return join(__dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
}

/**
 * Log debug message
 */
export function logDebug(message: string): void {
    if (process.env.DEBUG) {
        logger.debug(message)
        console.log(message)
    }
}

/**
 * Stream async messages to stdin
 */
export async function streamToStdin(
    stream: AsyncIterable<unknown>,
    stdin: NodeJS.WritableStream,
    abort?: AbortSignal
): Promise<void> {
    for await (const message of stream) {
        if (abort?.aborted) break
        stdin.write(JSON.stringify(message) + '\n')
    }
    stdin.end()
}