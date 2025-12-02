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
 * Create a clean environment without local node_modules/.bin in PATH
 * This ensures we find the global claude, not the local one
 * Used when spawning global 'claude' command
 */
export function getCleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    const cwd = process.cwd()
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    
    // Also check for PATH on Windows (case can vary)
    const actualPathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || pathKey
    
    if (env[actualPathKey]) {
        // Remove any path that contains the current working directory (local node_modules/.bin)
        const cleanPath = env[actualPathKey]!
            .split(pathSep)
            .filter(p => {
                const normalizedP = p.replace(/\\/g, '/').toLowerCase()
                const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
                return !normalizedP.startsWith(normalizedCwd)
            })
            .join(pathSep)
        env[actualPathKey] = cleanPath
    }
    
    return env
}

/**
 * Get default path to Claude Code executable
 * Always uses bundled version to ensure consistency across local and remote modes
 * 
 * Environment variable:
 * - HAPPY_CLAUDE_PATH: Force a specific path to claude executable (for testing)
 */
export function getDefaultClaudeCodePath(): string {
    const nodeModulesPath = join(__dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    
    // Allow explicit override via env var (for testing/debugging)
    if (process.env.HAPPY_CLAUDE_PATH) {
        logger.debug(`[Claude SDK] Using HAPPY_CLAUDE_PATH: ${process.env.HAPPY_CLAUDE_PATH}`)
        return process.env.HAPPY_CLAUDE_PATH
    }

    logger.debug(`[Claude SDK] Using bundled claude: ${nodeModulesPath}`)
    return nodeModulesPath
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
