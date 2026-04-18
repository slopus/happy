/**
 * Query wrapper around official @anthropic-ai/claude-agent-sdk
 * Maps internal QueryOptions to official SDK Options
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { query as sdkQuery, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'
import type { QueryOptions, QueryPrompt, SDKMessage } from './types'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ensureLocalProxyBypass } from '../utils/proxyBypass'

/**
 * Finds the globally installed claude binary path.
 * Checks HAPPY_CLAUDE_PATH env var first, then falls back to `which claude`.
 * This ensures the SDK uses the user's configured claude (e.g. a custom-patched
 * version with TLS proxy support) rather than the SDK's own bundled binary.
 */
function findGlobalClaudePath(): string | null {
    const envPath = process.env.HAPPY_CLAUDE_PATH
    if (envPath && existsSync(envPath)) {
        return envPath
    }
    try {
        return execSync('which claude', { encoding: 'utf8' }).trim() || null
    } catch {
        return null
    }
}

/**
 * Wraps the official SDK query() with our QueryOptions adapter
 */
export function query(params: { prompt: QueryPrompt; options?: QueryOptions }): Query {
    const opts = params.options

    // Build system prompt
    let systemPrompt: Options['systemPrompt'] = undefined
    if (opts?.customSystemPrompt) {
        systemPrompt = opts.customSystemPrompt
    } else if (opts?.appendSystemPrompt) {
        systemPrompt = {
            type: 'preset',
            preset: 'claude_code',
            append: opts.appendSystemPrompt
        }
    }

    // Map QueryOptions -> official Options
    const sdkOptions: Options = {
        cwd: opts?.cwd,
        resume: opts?.resume,
        continue: opts?.continue,
        model: opts?.model,
        fallbackModel: opts?.fallbackModel,
        maxTurns: opts?.maxTurns,
        permissionMode: opts?.permissionMode,
        allowedTools: opts?.allowedTools,
        disallowedTools: opts?.disallowedTools,
        mcpServers: opts?.mcpServers as Options['mcpServers'],
        systemPrompt,
        settings: opts?.settingsPath,
        strictMcpConfig: opts?.strictMcpConfig,
        sessionId: undefined,
        pathToClaudeCodeExecutable: findGlobalClaudePath() ?? undefined,
    }

    // Map abort signal -> AbortController
    if (opts?.abort) {
        const controller = new AbortController()
        opts.abort.addEventListener('abort', () => controller.abort(), { once: true })
        sdkOptions.abortController = controller
    }

    // Ensure local MCP servers bypass HTTP proxy
    if (opts?.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        const env = { ...process.env }
        ensureLocalProxyBypass(env)
        sdkOptions.env = env as Record<string, string>
    }

    // Map canCallTool -> canUseTool
    if (opts?.canCallTool) {
        const callback = opts.canCallTool
        sdkOptions.canUseTool = async (toolName, input, options) => {
            return callback(toolName, input, options)
        }
    }

    return sdkQuery({
        prompt: params.prompt as string | AsyncIterable<SDKUserMessage>,
        options: sdkOptions,
    })
}
