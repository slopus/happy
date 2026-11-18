/**
 * Resolves the HAPPY_CLAUDE_PATH override for the Claude Code executable
 * spawned through the agent SDK.
 *
 * Why this exists
 * ---------------
 * Local/interactive mode resolves the system-installed `claude` binary and
 * already honors the HAPPY_CLAUDE_PATH env override (see
 * scripts/claude_version_utils.cjs). Remote mode instead spawns the CLI build
 * vendored inside `@anthropic-ai/claude-agent-sdk`, which can lag behind the
 * system install — a released Happy can reject model aliases the current
 * Claude Code accepts (e.g. `fable` / Claude 5, slopus/happy#1498), and there
 * was no way to point remote sessions at a newer binary short of patching
 * node_modules.
 *
 * Mitigation
 * ----------
 * Honor the same HAPPY_CLAUDE_PATH override in the SDK path by mapping it to
 * the SDK's `pathToClaudeCodeExecutable` option, so one env var governs which
 * `claude` both modes run. Unset — or pointing at a file that does not exist —
 * keeps the SDK's bundled executable, so existing setups are unaffected.
 */

import { existsSync } from 'node:fs'

import { logger } from '@/ui/logger'

export function resolveClaudeExecutableOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const override = env.HAPPY_CLAUDE_PATH
    if (!override || override.length === 0) {
        return undefined
    }
    if (!existsSync(override)) {
        logger.debug(`[ClaudeSdk] HAPPY_CLAUDE_PATH points to a missing file, using the SDK's bundled executable instead: ${override}`)
        return undefined
    }
    return override
}
