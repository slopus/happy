/**
 * Query wrapper around official @anthropic-ai/claude-agent-sdk
 * Maps internal QueryOptions to official SDK Options
 */

import { query as sdkQuery, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'
import type { QueryOptions, QueryPrompt, SDKMessage } from './types'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ensureLocalProxyBypass } from '../utils/proxyBypass'
import { resolveHappyEntrypoint } from './happyEntrypoint'

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
        effort: opts?.effort,
    }

    // Map abort signal -> AbortController
    if (opts?.abort) {
        const controller = new AbortController()
        opts.abort.addEventListener('abort', () => controller.abort(), { once: true })
        sdkOptions.abortController = controller
    }

    // Build env: tag the spawned Claude with an entrypoint that is NOT in
    // Claude Code's `--resume` picker filter set ({sdk-cli, sdk-ts, sdk-py}),
    // so sessions Happy starts/continues remain visible to a plain
    // `claude --resume` picker. The agent SDK would otherwise default to
    // CLAUDE_CODE_ENTRYPOINT="sdk-ts" and the picker would hide every Happy
    // session. See slopus/happy#1202.
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string') env[key] = value
    }
    env.CLAUDE_CODE_ENTRYPOINT = resolveHappyEntrypoint(process.env.CLAUDE_CODE_ENTRYPOINT)
    if (opts?.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        ensureLocalProxyBypass(env)
    }
    sdkOptions.env = env

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
