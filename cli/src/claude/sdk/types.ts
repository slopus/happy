/**
 * Type definitions for Claude Code SDK integration
 * Provides type-safe interfaces for all SDK communication
 */

import type { Readable } from 'node:stream'

/**
 * SDK message types
 */
export interface SDKMessage {
    type: string
    [key: string]: unknown
}

export interface SDKUserMessage extends SDKMessage {
    type: 'user'
    parent_tool_use_id?: string
    message: {
        role: 'user'
        content: string | Array<{
            type: string
            text?: string
            tool_use_id?: string
            content?: unknown
            [key: string]: unknown
        }>
    }
}

export interface SDKAssistantMessage extends SDKMessage {
    type: 'assistant'
    parent_tool_use_id?: string
    message: {
        role: 'assistant'
        content: Array<{
            type: string
            text?: string
            id?: string
            name?: string
            input?: unknown
            [key: string]: unknown
        }>
    }
}

export interface SDKSystemMessage extends SDKMessage {
    type: 'system'
    subtype: string
    session_id?: string
    model?: string
    cwd?: string
    tools?: string[]
}

export interface SDKResultMessage extends SDKMessage {
    type: 'result'
    subtype: 'success' | 'error_max_turns' | 'error_during_execution'
    result?: string
    num_turns: number
    usage?: {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    }
    total_cost_usd: number
    duration_ms: number
    duration_api_ms: number
    is_error: boolean
    session_id: string
}

export interface SDKControlResponse extends SDKMessage {
    type: 'control_response'
    response: {
        request_id: string
        subtype: 'success' | 'error'
        error?: string
    }
}

/**
 * Control request types
 */
export interface ControlRequest {
    subtype: string
}

export interface InterruptRequest extends ControlRequest {
    subtype: 'interrupt'
}

export interface SDKControlRequest {
    request_id: string
    type: 'control_request'
    request: ControlRequest
}

/**
 * Query options
 */
export interface QueryOptions {
    abort?: AbortSignal
    allowedTools?: string[]
    appendSystemPrompt?: string
    customSystemPrompt?: string
    cwd?: string
    disallowedTools?: string[]
    executable?: string
    executableArgs?: string[]
    maxTurns?: number
    mcpServers?: Record<string, unknown>
    pathToClaudeCodeExecutable?: string
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    permissionPromptToolName?: string
    continue?: boolean
    resume?: string
    model?: string
    fallbackModel?: string
    strictMcpConfig?: boolean
}

/**
 * Query prompt types
 */
export type QueryPrompt = string | AsyncIterable<SDKMessage>

/**
 * Control response handlers
 */
export type ControlResponseHandler = (response: SDKControlResponse['response']) => void

/**
 * Error types
 */
export class AbortError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AbortError'
    }
}