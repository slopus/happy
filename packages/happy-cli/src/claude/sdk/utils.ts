/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { logger } from '@/ui/logger'
import { isBun } from '@/utils/runtime'

/**
 * Get the directory path of the current module
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')

/**
 * Get version of globally installed claude
 * Runs from home directory with clean PATH to avoid picking up local node_modules/.bin
 */
function getGlobalClaudeVersion(): string | null {
    try {
        const cleanEnv = getCleanEnv()
        const output = execSync('claude --version', { 
            encoding: 'utf8', 
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir(),
            env: cleanEnv
        }).trim()
        // Output format: "2.0.54 (Claude Code)" or similar
        const match = output.match(/(\d+\.\d+\.\d+)/)
        logger.debug(`[Claude SDK] Global claude --version output: ${output}`)
        return match ? match[1] : null
    } catch {
        return null
    }
}

/**
 * Create a clean environment without local node_modules/.bin in PATH
 * This ensures we find the global claude, not the local one
 * Also removes conflicting Bun environment variables when running in Bun
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
        logger.debug(`[Claude SDK] Cleaned PATH, removed local paths from: ${cwd}`)
    }

    // Remove Bun-specific environment variables that can interfere with Node.js processes
    if (isBun()) {
        Object.keys(env).forEach(key => {
            if (key.startsWith('BUN_')) {
                delete env[key]
            }
        })
        logger.debug('[Claude SDK] Removed Bun-specific environment variables for Node.js compatibility')
    }

    return env
}

/**
 * Try to find globally installed Claude CLI
 * Returns 'claude' if the command works globally (preferred method for reliability)
 * Falls back to which/where to get actual path on Unix systems
 * Runs from home directory with clean PATH to avoid picking up local node_modules/.bin
 */
function findGlobalClaudePath(): string | null {
    const homeDir = homedir()
    const cleanEnv = getCleanEnv()
    
    // PRIMARY: Check if 'claude' command works directly from home dir with clean PATH
    try {
        execSync('claude --version', { 
            encoding: 'utf8', 
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
            env: cleanEnv
        })
        logger.debug('[Claude SDK] Global claude command available (checked with clean PATH)')
        return 'claude'
    } catch {
        // claude command not available globally
    }

    // FALLBACK for Unix: try which to get actual path
    if (process.platform !== 'win32') {
        try {
            const result = execSync('which claude', { 
                encoding: 'utf8', 
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: homeDir,
                env: cleanEnv
            }).trim()
            if (result && existsSync(result)) {
                logger.debug(`[Claude SDK] Found global claude path via which: ${result}`)
                return result
            }
        } catch {
            // which didn't find it
        }
    }
    
    return null
}

/**
 * Get default path to Claude Code executable
 * Compares global and bundled versions, uses the newer one
 * 
 * Environment variables:
 * - HAPPY_CLAUDE_PATH: Force a specific path to claude executable
 * - HAPPY_USE_BUNDLED_CLAUDE=1: Force use of node_modules version (skip global search)
 * - HAPPY_USE_GLOBAL_CLAUDE=1: Force use of global version (if available)
 */
export function getDefaultClaudeCodePath(): string {
    const nodeModulesPath = join(__dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    
    // Allow explicit override via env var
    if (process.env.HAPPY_CLAUDE_PATH) {
        logger.debug(`[Claude SDK] Using HAPPY_CLAUDE_PATH: ${process.env.HAPPY_CLAUDE_PATH}`)
        return process.env.HAPPY_CLAUDE_PATH
    }

    // Force bundled version if requested
    if (process.env.HAPPY_USE_BUNDLED_CLAUDE === '1') {
        logger.debug(`[Claude SDK] Forced bundled version: ${nodeModulesPath}`)
        return nodeModulesPath
    }

    // Find global claude
    const globalPath = findGlobalClaudePath()
    


    // No global claude found - use bundled
    if (!globalPath) {
        logger.debug(`[Claude SDK] No global claude found, using bundled: ${nodeModulesPath}`)
        return nodeModulesPath
    }

    // Compare versions and use the newer one
    const globalVersion = getGlobalClaudeVersion()

    logger.debug(`[Claude SDK] Global version: ${globalVersion || 'unknown'}`)
    
    // If we can't determine versions, prefer global (user's choice to install it)
    if (!globalVersion) {
        logger.debug(`[Claude SDK] Cannot compare versions, using global: ${globalPath}`)
        return globalPath
    }
    
    return globalPath
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