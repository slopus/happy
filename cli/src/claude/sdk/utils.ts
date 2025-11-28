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

/**
 * Get the directory path of the current module
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')

/**
 * Parse semver version string into comparable parts
 * Returns null if parsing fails
 */
function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!match) return null
    return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10)
    }
}

/**
 * Compare two semver versions
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a: string, b: string): number {
    const vA = parseVersion(a)
    const vB = parseVersion(b)
    
    if (!vA || !vB) return 0
    
    if (vA.major !== vB.major) return vA.major > vB.major ? 1 : -1
    if (vA.minor !== vB.minor) return vA.minor > vB.minor ? 1 : -1
    if (vA.patch !== vB.patch) return vA.patch > vB.patch ? 1 : -1
    return 0
}

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
 * Get version of bundled claude from node_modules
 * Tries multiple possible paths since __dirname varies between dev and dist
 */
function getBundledClaudeVersion(): string | null {
    // Try multiple possible paths to find the package.json
    const possiblePaths = [
        // From dist/claude/sdk/ (compiled)
        join(__dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
        // From src/claude/sdk/ (dev)
        join(__dirname, '..', '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
        // From cwd
        join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
    ]
    
    for (const packageJsonPath of possiblePaths) {
        try {
            if (existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
                if (packageJson.version) {
                    logger.debug(`[Claude SDK] Found bundled version ${packageJson.version} at ${packageJsonPath}`)
                    return packageJson.version
                }
            }
        } catch {
            // Try next path
        }
    }
    
    logger.debug(`[Claude SDK] Could not find bundled claude-code package.json`)
    return null
}

/**
 * Create a clean environment without local node_modules/.bin in PATH
 * This ensures we find the global claude, not the local one
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
    
    // Force global version if requested (and available)
    if (process.env.HAPPY_USE_GLOBAL_CLAUDE === '1') {
        if (globalPath) {
            logger.debug(`[Claude SDK] Forced global version: ${globalPath}`)
            return globalPath
        }
        logger.debug(`[Claude SDK] Global version requested but not found, falling back to bundled`)
        return nodeModulesPath
    }

    // No global claude found - use bundled
    if (!globalPath) {
        logger.debug(`[Claude SDK] No global claude found, using bundled: ${nodeModulesPath}`)
        return nodeModulesPath
    }

    // Compare versions and use the newer one
    const globalVersion = getGlobalClaudeVersion()
    const bundledVersion = getBundledClaudeVersion()
    
    logger.debug(`[Claude SDK] Global version: ${globalVersion || 'unknown'}, Bundled version: ${bundledVersion || 'unknown'}`)
    
    // If we can't determine versions, prefer global (user's choice to install it)
    if (!globalVersion || !bundledVersion) {
        logger.debug(`[Claude SDK] Cannot compare versions, using global: ${globalPath}`)
        return globalPath
    }
    
    const comparison = compareVersions(globalVersion, bundledVersion)
    
    if (comparison >= 0) {
        // Global is newer or equal
        logger.debug(`[Claude SDK] Using global claude (${globalVersion} >= ${bundledVersion}): ${globalPath}`)
        return globalPath
    } else {
        // Bundled is newer
        logger.debug(`[Claude SDK] Using bundled claude (${bundledVersion} > ${globalVersion}): ${nodeModulesPath}`)
        return nodeModulesPath
    }
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