/**
 * Query wrapper around official @anthropic-ai/claude-agent-sdk
 * Maps internal QueryOptions to official SDK Options
 */

import { query as sdkQuery, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'
import { accessSync, constants, realpathSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { QueryOptions, QueryPrompt, SDKMessage } from './types'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ensureLocalProxyBypass } from '../utils/proxyBypass'
import { resolveHappyEntrypoint } from './happyEntrypoint'

/**
 * Wraps the official SDK query() with our QueryOptions adapter
 */
export function query(params: { prompt: QueryPrompt; options?: QueryOptions }): Query {
    const opts = params.options
    const settings = resolveSettings(opts)

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
        pathToClaudeCodeExecutable: resolveExplicitClaudeExecutable(),
        cwd: opts?.cwd,
        additionalDirectories: opts?.additionalDirectories,
        resume: opts?.resume,
        continue: opts?.continue,
        model: opts?.model,
        fallbackModel: opts?.fallbackModel,
        maxTurns: opts?.maxTurns,
        promptSuggestions: opts?.promptSuggestions,
        permissionMode: opts?.permissionMode,
        allowedTools: opts?.allowedTools,
        disallowedTools: opts?.disallowedTools,
        tools: opts?.tools,
        mcpServers: opts?.mcpServers as Options['mcpServers'],
        systemPrompt,
        settings,
        strictMcpConfig: opts?.strictMcpConfig,
        sessionId: undefined,
        effort: opts?.effort,
        agents: opts?.agents,
        settingSources: opts?.settingSources,
        skills: opts?.skills,
        sandbox: opts?.sandbox,
        spawnClaudeCodeProcess: opts?.spawnClaudeCodeProcess,
        persistSession: opts?.persistSession,
        // Token-level partials (`stream_event`) let the app render text as it
        // is produced instead of after a whole content block completes.
        includePartialMessages: true,
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

function resolveSettings(opts: QueryOptions | undefined): string | undefined {
    const denyRules = opts?.permissionsDeny ?? []
    const emptyPluginServers = findEmptySyncedPluginServers().filter(name => !opts?.mcpServers?.[name])
    // SDK 는 settings 파일 경로와 sandbox 옵션의 동시 사용을 거부한다. 우리 규칙을
    // 경로로 넘기면 CLI 가 그 파일만 읽고 여기서 더한 것은 사라지므로, 합쳐야 할
    // 것이 하나라도 있으면 인라인한다.
    if (emptyPluginServers.length === 0 && (!opts?.settingsPath || (!opts.sandbox && denyRules.length === 0))) return opts?.settingsPath
    const rawSettings = opts?.settingsPath ? readFileSync(opts.settingsPath, 'utf8') : '{}'
    let parsedSettings: unknown
    try {
        parsedSettings = JSON.parse(rawSettings)
    } catch (error) {
        throw new Error('Claude hook settings must contain valid JSON before sandbox merge', { cause: error })
    }
    if (!parsedSettings || typeof parsedSettings !== 'object' || Array.isArray(parsedSettings)) {
        throw new Error('Claude hook settings must be a JSON object before sandbox merge')
    }
    if (emptyPluginServers.length > 0) {
        const settings = parsedSettings as { deniedMcpServers?: { serverName?: string }[] }
        const existing = settings.deniedMcpServers ?? []
        settings.deniedMcpServers = [
            ...existing,
            ...emptyPluginServers.filter(name => !existing.some(rule => rule.serverName === name))
                .map(serverName => ({ serverName })),
        ]
    }
    if (denyRules.length === 0) return JSON.stringify(parsedSettings)

    const settings = parsedSettings as { permissions?: { deny?: unknown } }
    const existingDeny = Array.isArray(settings.permissions?.deny)
        ? (settings.permissions?.deny as string[])
        : []
    return JSON.stringify({
        ...settings,
        permissions: {
            ...(settings.permissions ?? {}),
            deny: [...new Set([...existingDeny, ...denyRules])],
        },
    })
}

// Synced plugins are loaded by Claude itself, outside options.mcpServers. Apply
// session-only exclusions; editing the sync cache or persisting disable flags
// would keep a subsequently configured connector disabled.
function findEmptySyncedPluginServers(): string[] {
    const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'synced')
    const empty = new Set<string>()
    const configured = new Set<string>()
    const customPlugins = new Set<string>()
    const directories = (path: string): string[] => {
        try {
            return readdirSync(path, { withFileTypes: true })
                .filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
        } catch {
            return []
        }
    }
    for (const account of directories(root)) {
        for (const plugin of directories(account)) {
            try {
                const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'))
                if (typeof manifest.name !== 'string' || !manifest.name) continue
                // Custom paths/inline definitions can override the default file.
                if (manifest.mcpServers !== undefined) {
                    customPlugins.add(manifest.name)
                    continue
                }
                const config = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'))
                for (const [name, server] of Object.entries(config.mcpServers ?? config)) {
                    if (!server || typeof server !== 'object') continue
                    const entry = server as { type?: string; url?: unknown }
                    const serverName = `plugin:${manifest.name}:${name}`
                    if ((entry.type === 'http' || entry.type === 'sse') && typeof entry.url === 'string' && entry.url.trim() === '') {
                        empty.add(serverName)
                    } else {
                        configured.add(serverName)
                    }
                }
            } catch {
                // Missing, malformed, or concurrently refreshed files remain the
                // SDK's responsibility; never infer "unconfigured" from a read error.
            }
        }
    }
    // Multiple accounts can cache the same plugin. A usable definition in any
    // account must not be blocked by a stale blank copy in another account.
    return [...empty].filter(name => !configured.has(name)
        && ![...customPlugins].some(plugin => name.startsWith(`plugin:${plugin}:`)))
}

// Keep SDK's bundled default. An explicit override must never silently select
// another install, and validation must not execute a probe outside the sandbox.
function resolveExplicitClaudeExecutable(): string | undefined {
    const configured = process.env.HAPPY_CLAUDE_PATH
    if (configured === undefined) return undefined
    if (!configured || configured.includes('\0') || !isAbsolute(configured)) {
        throw new Error('HAPPY_CLAUDE_PATH must be an absolute Claude Code executable path')
    }
    try {
        const executable = realpathSync(configured)
        if (!statSync(executable).isFile()) throw new Error('not a file')
        const javascript = /\.[cm]?js$/.test(executable)
        accessSync(executable, constants.R_OK | (javascript ? 0 : constants.X_OK))
        return executable
    } catch {
        throw new Error('HAPPY_CLAUDE_PATH must point to a readable CLI entrypoint or executable file')
    }
}
