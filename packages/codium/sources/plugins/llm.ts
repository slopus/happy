/* ─────────────────────────────────────────────────────────────────────────
 * LLM-inference message + stream types
 *
 * Mirrors utopia's provider-agnostic shape so that the Anthropic provider
 * we copy from utopia can be wired in unchanged.
 * ──────────────────────────────────────────────────────────────────────── */

export type Vendor = Record<string, unknown>

export interface TextBlock {
    type: 'text'
    text: string
    vendor?: Vendor
}
export interface ImageBlock {
    type: 'image'
    /** base64 payload */
    data: string
    mimeType: string
    vendor?: Vendor
}
export interface ThinkingBlock {
    type: 'thinking'
    text: string
    vendor?: Vendor
}
export interface ToolCallBlock {
    type: 'tool_call'
    id: string
    name: string
    arguments: Record<string, unknown>
    vendor?: Vendor
}

export type UserContent = TextBlock | ImageBlock
export type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock
export type ToolContent = TextBlock | ImageBlock

export interface UserMessage {
    role: 'user'
    content: UserContent[]
}
export interface AssistantMessage {
    role: 'assistant'
    content: AssistantContent[]
}
export interface ToolMessage {
    role: 'tool'
    toolCallId: string
    content: ToolContent[]
    isError?: boolean
}
export type Message = UserMessage | AssistantMessage | ToolMessage

export interface Tool {
    name: string
    description: string
    inputSchema: {
        type: 'object'
        properties?: Record<string, unknown>
        required?: string[]
        [key: string]: unknown
    }
}

export interface InferenceContext {
    systemPrompt?: string
    messages: Message[]
    tools?: Tool[]
}

export type StopReason = 'stop' | 'length' | 'tool_use'
export type ErrorReason = 'error' | 'aborted'

export type StreamEvent =
    | { type: 'text_delta';      index: number; delta: string }
    | { type: 'text_end';        index: number; text: string }
    | { type: 'thinking_delta';  index: number; delta: string }
    | { type: 'thinking_end';    index: number; text: string }
    | { type: 'tool_call_delta'; index: number; delta: string }
    | { type: 'tool_call_end';   index: number; toolCall: ToolCallBlock }
    | { type: 'done';            reason: StopReason; message: AssistantMessage }
    | { type: 'error';           reason: ErrorReason; message: AssistantMessage; error?: string }

export type StreamGenerator = AsyncIterable<StreamEvent>

/** Effort level shared across providers (each maps it to vendor-specific keys). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

export interface InferenceParameters {
    /** Reasoning effort, mapped per provider. */
    effort?: EffortLevel
    /** Max output tokens (provider-specific default if omitted). */
    maxTokens?: number
    /** AbortSignal that cancels the upstream request. */
    signal?: AbortSignal
}
