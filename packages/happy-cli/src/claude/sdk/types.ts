/**
 * Type definitions for Claude Code SDK integration
 * Re-exports from official @anthropic-ai/claude-agent-sdk with adapter types
 */

// Re-export message types from official SDK
export type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage,
    PermissionResult,
    CanUseTool,
    AgentDefinition,
    SettingSource,
} from '@anthropic-ai/claude-agent-sdk'

import type { AgentDefinition, Options, SandboxSettings, SettingSource } from '@anthropic-ai/claude-agent-sdk'

// Re-export AbortError class
export { AbortError } from '@anthropic-ai/claude-agent-sdk'

// Alias for backward compatibility
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
export type CanCallToolCallback = CanUseTool

/**
 * Adapter type for query options.
 * Maps to official SDK's Options type but preserves existing field names
 * used throughout the codebase. The query() wrapper handles the translation.
 */
export interface QueryOptions {
    abort?: AbortSignal
    allowedTools?: string[]
    appendSystemPrompt?: string
    customSystemPrompt?: string
    cwd?: string
    additionalDirectories?: string[]
    disallowedTools?: string[]
    maxTurns?: number
    /** Emit Claude's predicted next user prompt after completed turns. */
    promptSuggestions?: boolean
    /**
     * 내장 도구 허용 목록. 빈 배열은 **전부 끈다**(`sdk.d.ts`: "Disable all
     * built-in tools"). 이 자리가 없으면 관리 실행의 도구 경계가 SDK 까지
     * 도달하지 못한다.
     */
    tools?: string[]
    mcpServers?: Record<string, unknown>
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    continue?: boolean
    resume?: string
    model?: string
    fallbackModel?: string
    strictMcpConfig?: boolean
    canCallTool?: CanCallToolCallback
    /** Path to a settings JSON file to pass to Claude via --settings */
    settingsPath?: string
    /**
     * Effort level passed straight through to the Claude Agent SDK option
     * of the same name — controls how much thinking/reasoning Claude
     * applies on each turn ('low' | 'medium' | 'high' | 'xhigh' | 'max').
     * 'xhigh' is supported on the newest Opus generation (e.g. Opus 4.8);
     * the SDK silently downgrades it to 'high' on models without it.
     */
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    /**
     * Programmatically-defined custom subagents, keyed by name, forwarded to the
     * SDK's `agents` option. Used for per-session orchestrator/worker delegation:
     * a cheaper `worker` agent the (expensive) main model delegates mechanical
     * work to. See orchestrator/workerAgents.ts.
     */
    agents?: Record<string, AgentDefinition>
    /**
     * Which filesystem settings sources to load ('user' | 'project' | 'local').
     * Omit to keep the SDK default (all sources). See orchestrator/skillGovernance.ts
     * for the env-driven per-session/machine control that populates this.
     */
    settingSources?: SettingSource[]
    /**
     * Explicit skill allowlist for the main session ('all' or a name list).
     * Omit to keep the SDK default (CLI's own defaults, i.e. not restricted).
     * See orchestrator/skillGovernance.ts.
     */
    skills?: string[] | 'all'
    sandbox?: SandboxSettings
    /**
     * CLI 권한 규칙의 deny 목록. sandbox 가 Bash 실행 경계를 담당하는 동안
     * Read/Edit 같은 도구 경로를 막는 층이다 (sandbox/claudeSdkSandbox.ts).
     */
    permissionsDeny?: string[]
    spawnClaudeCodeProcess?: Options['spawnClaudeCodeProcess']
    /** False keeps a side query (e.g. off-turn titling) out of the session files and `--resume` list. */
    persistSession?: boolean
}

/**
 * Query prompt types
 */
import type { SDKMessage as _SDKMessage } from '@anthropic-ai/claude-agent-sdk'
export type QueryPrompt = string | AsyncIterable<_SDKMessage>
