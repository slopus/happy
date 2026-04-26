/* ─────────────────────────────────────────────────────────────────────────
 * Anthropic provider — copied from utopia (sources/providers/anthropic.ts)
 * with imports rebound to our local llm.ts types so the plugin can run in
 * the renderer.
 *
 * Functional changes vs. utopia:
 *  - `process.env` is unavailable in the renderer; we never read env vars.
 *  - We accept an `AbortSignal` via parameters and forward it to the SDK.
 *  - All other behavior (streaming, tool calls, thinking, OAuth detection,
 *    cache breakpoints) is unchanged.
 * ──────────────────────────────────────────────────────────────────────── */
import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk'
import type {
    CacheControlEphemeral,
    ContentBlockParam,
    ImageBlockParam,
    MessageCreateParamsStreaming,
    MessageParam,
    RawMessageStreamEvent,
    RedactedThinkingBlockParam,
    StopReason as AnthropicStopReason,
    TextBlockParam,
    ThinkingBlockParam,
    Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages.js'
import type {
    AssistantMessage,
    InferenceContext,
    Message,
    StopReason,
    StreamEvent,
    TextBlock,
    ThinkingBlock,
    Tool,
    ToolCallBlock,
    ToolMessage,
    UserContent,
} from '../llm'

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AnthropicCache = 'off' | 'short' | 'long'

export interface AnthropicThinkingVendor {
    signature?: string
    redacted?: boolean
}

const VENDOR_KEY = 'anthropic'

export interface AnthropicParameters {
    maxTokens?: number
    effort?: AnthropicEffort
    cache?: AnthropicCache
    signal?: AbortSignal
}

export interface AnthropicClientConfig {
    apiKey?: string
    baseURL?: string
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_MAX_TOKENS = 4096
const BETA_BASE = 'fine-grained-tool-streaming-2025-05-14'
const BETA_OAUTH = `claude-code-20250219,oauth-2025-04-20,${BETA_BASE}`
const CLAUDE_CODE_VERSION = '2.1.75'
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * Build a streaming inference call. The result is an AsyncIterable<StreamEvent>
 * compatible with our plugin host's `LLMInferenceCapability.stream` signature.
 */
export async function* runStream(
    config: AnthropicClientConfig,
    modelId: string,
    context: InferenceContext,
    parameters: AnthropicParameters = {},
): AsyncGenerator<StreamEvent, void, unknown> {
    const apiKey = config.apiKey ?? ''
    if (!apiKey) {
        throw new Error('Anthropic API key not provided.')
    }

    const oauth = isOAuthToken(apiKey)
    const baseURL = config.baseURL ?? DEFAULT_BASE_URL
    const client = oauth
        ? new Anthropic({
              apiKey: null,
              authToken: apiKey,
              baseURL,
              dangerouslyAllowBrowser: true,
              defaultHeaders: {
                  accept: 'application/json',
                  'anthropic-dangerous-direct-browser-access': 'true',
                  'anthropic-beta': BETA_OAUTH,
                  'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
                  'x-app': 'cli',
              },
          })
        : new Anthropic({
              apiKey,
              baseURL,
              dangerouslyAllowBrowser: true,
              defaultHeaders: { 'anthropic-beta': BETA_BASE },
          })

    const cacheControl = getCacheControl(parameters.cache ?? 'short')
    const params = buildParams(modelId, context, parameters, oauth, cacheControl)

    const output: AssistantMessage = { role: 'assistant', content: [] }
    const ourIndex = new Map<number, number>()
    const toolJson = new Map<number, string>()

    let stopReason: StopReason = 'stop'
    let errored = false

    try {
        const stream = client.messages.stream(params, { signal: parameters.signal })
        for await (const event of stream) {
            const mapped = handleEvent(event, output, ourIndex, toolJson)
            if (mapped.event !== null) yield mapped.event
            if (mapped.stopReason !== null) stopReason = mapped.stopReason
        }
    } catch (err) {
        errored = true
        const reason = err instanceof APIUserAbortError ? 'aborted' : 'error'
        const message = err instanceof Error ? err.message : String(err)
        yield { type: 'error', reason, message: output, error: message }
        return
    }

    if (!errored) yield { type: 'done', reason: stopReason, message: output }
}

type HandleResult = { event: StreamEvent | null; stopReason: StopReason | null }

function handleEvent(
    event: RawMessageStreamEvent,
    output: AssistantMessage,
    ourIndex: Map<number, number>,
    toolJson: Map<number, string>,
): HandleResult {
    if (event.type === 'content_block_start') {
        return handleBlockStart(event, output, ourIndex, toolJson)
    }
    if (event.type === 'content_block_delta') {
        return { event: handleBlockDelta(event, output, ourIndex, toolJson), stopReason: null }
    }
    if (event.type === 'content_block_stop') {
        return { event: handleBlockStop(event, output, ourIndex, toolJson), stopReason: null }
    }
    if (event.type === 'message_delta' && event.delta.stop_reason !== null) {
        return { event: null, stopReason: mapStopReason(event.delta.stop_reason) }
    }
    return { event: null, stopReason: null }
}

function handleBlockStart(
    event: Extract<RawMessageStreamEvent, { type: 'content_block_start' }>,
    output: AssistantMessage,
    ourIndex: Map<number, number>,
    toolJson: Map<number, string>,
): HandleResult {
    const cb = event.content_block
    if (cb.type === 'text') {
        const block: TextBlock = { type: 'text', text: '' }
        output.content.push(block)
        ourIndex.set(event.index, output.content.length - 1)
    } else if (cb.type === 'thinking') {
        const block: ThinkingBlock = {
            type: 'thinking',
            text: '',
            vendor: { [VENDOR_KEY]: { signature: '' } satisfies AnthropicThinkingVendor },
        }
        output.content.push(block)
        ourIndex.set(event.index, output.content.length - 1)
    } else if (cb.type === 'redacted_thinking') {
        const block: ThinkingBlock = {
            type: 'thinking',
            text: '',
            vendor: {
                [VENDOR_KEY]: {
                    signature: cb.data,
                    redacted: true,
                } satisfies AnthropicThinkingVendor,
            },
        }
        output.content.push(block)
        ourIndex.set(event.index, output.content.length - 1)
    } else if (cb.type === 'tool_use') {
        const block: ToolCallBlock = {
            type: 'tool_call',
            id: cb.id,
            name: cb.name,
            arguments: (cb.input as Record<string, unknown>) ?? {},
        }
        output.content.push(block)
        ourIndex.set(event.index, output.content.length - 1)
        toolJson.set(event.index, '')
    }
    return { event: null, stopReason: null }
}

function handleBlockDelta(
    event: Extract<RawMessageStreamEvent, { type: 'content_block_delta' }>,
    output: AssistantMessage,
    ourIndex: Map<number, number>,
    toolJson: Map<number, string>,
): StreamEvent | null {
    const index = ourIndex.get(event.index)
    if (index === undefined) return null
    const block = output.content[index]
    if (!block) return null

    if (event.delta.type === 'text_delta' && block.type === 'text') {
        block.text += event.delta.text
        return { type: 'text_delta', index, delta: event.delta.text }
    }
    if (event.delta.type === 'thinking_delta' && block.type === 'thinking') {
        block.text += event.delta.thinking
        return { type: 'thinking_delta', index, delta: event.delta.thinking }
    }
    if (event.delta.type === 'signature_delta' && block.type === 'thinking') {
        const v = readVendor(block) ?? {}
        v.signature = (v.signature ?? '') + event.delta.signature
        writeVendor(block, v)
        return null
    }
    if (event.delta.type === 'input_json_delta' && block.type === 'tool_call') {
        toolJson.set(event.index, (toolJson.get(event.index) ?? '') + event.delta.partial_json)
        return { type: 'tool_call_delta', index, delta: event.delta.partial_json }
    }
    return null
}

function handleBlockStop(
    event: Extract<RawMessageStreamEvent, { type: 'content_block_stop' }>,
    output: AssistantMessage,
    ourIndex: Map<number, number>,
    toolJson: Map<number, string>,
): StreamEvent | null {
    const index = ourIndex.get(event.index)
    if (index === undefined) return null
    const block = output.content[index]
    if (!block) return null

    if (block.type === 'text') return { type: 'text_end', index, text: block.text }
    if (block.type === 'thinking') return { type: 'thinking_end', index, text: block.text }
    if (block.type === 'tool_call') {
        const json = toolJson.get(event.index) ?? ''
        if (json.length > 0) {
            try { block.arguments = JSON.parse(json) as Record<string, unknown> } catch {}
        }
        toolJson.delete(event.index)
        return { type: 'tool_call_end', index, toolCall: block }
    }
    return null
}

function buildParams(
    modelId: string,
    context: InferenceContext,
    parameters: AnthropicParameters,
    oauth: boolean,
    cacheControl: CacheControlEphemeral | undefined,
): MessageCreateParamsStreaming {
    const params: MessageCreateParamsStreaming = {
        model: modelId,
        messages: convertMessages(context.messages, cacheControl),
        max_tokens: parameters.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
    }

    const system: TextBlockParam[] = []
    if (oauth) {
        const block: TextBlockParam = { type: 'text', text: CLAUDE_CODE_SYSTEM }
        if (cacheControl) block.cache_control = cacheControl
        system.push(block)
    }
    if (context.systemPrompt !== undefined && context.systemPrompt.length > 0) {
        const block: TextBlockParam = { type: 'text', text: context.systemPrompt }
        if (cacheControl) block.cache_control = cacheControl
        system.push(block)
    }
    if (system.length > 0) params.system = system

    if (context.tools && context.tools.length > 0) {
        params.tools = convertTools(context.tools, cacheControl)
    }

    if (parameters.effort !== undefined) {
        params.thinking = { type: 'adaptive', display: 'summarized' }
        params.output_config = { effort: parameters.effort }
    }

    return params
}

function convertTools(
    tools: Tool[],
    cacheControl: CacheControlEphemeral | undefined,
): AnthropicTool[] {
    return tools.map((tool, index) => {
        const result: AnthropicTool = {
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
        }
        if (cacheControl && index === tools.length - 1) {
            result.cache_control = cacheControl
        }
        return result
    })
}

export function isOAuthToken(key: string): boolean {
    return key.startsWith('sk-ant-oat')
}

function getCacheControl(cache: AnthropicCache): CacheControlEphemeral | undefined {
    if (cache === 'off') return undefined
    return cache === 'long' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

function convertMessages(
    messages: Message[],
    cacheControl: CacheControlEphemeral | undefined,
): MessageParam[] {
    const out: MessageParam[] = []
    let i = 0
    while (i < messages.length) {
        const msg = messages[i]!
        if (msg.role === 'user') {
            const content = msg.content.map(toUserBlock).filter(nonEmpty)
            if (content.length > 0) out.push({ role: 'user', content })
            i++
        } else if (msg.role === 'assistant') {
            const content = toAssistantBlocks(msg.content)
            if (content.length > 0) out.push({ role: 'assistant', content })
            i++
        } else {
            const toolBlocks: ContentBlockParam[] = []
            while (i < messages.length && messages[i]!.role === 'tool') {
                const t = messages[i] as ToolMessage
                toolBlocks.push({
                    type: 'tool_result',
                    tool_use_id: t.toolCallId,
                    content: t.content.map(toUserBlock).filter(nonEmpty),
                    is_error: t.isError,
                })
                i++
            }
            out.push({ role: 'user', content: toolBlocks })
        }
    }

    if (cacheControl && out.length > 0) {
        const last = out[out.length - 1]
        if (last?.role === 'user' && Array.isArray(last.content) && last.content.length > 0) {
            const tail = last.content[last.content.length - 1]
            if (tail && (tail.type === 'text' || tail.type === 'image' || tail.type === 'tool_result')) {
                tail.cache_control = cacheControl
            }
        }
    }

    return out
}

function toUserBlock(block: UserContent): TextBlockParam | ImageBlockParam {
    if (block.type === 'text') return { type: 'text', text: block.text }
    return {
        type: 'image',
        source: {
            type: 'base64',
            media_type: block.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: block.data,
        },
    }
}

function toAssistantBlocks(content: AssistantMessage['content']): ContentBlockParam[] {
    const out: ContentBlockParam[] = []
    for (const block of content) {
        if (block.type === 'text') {
            if (block.text.trim().length > 0) out.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking') {
            const vendor = readVendor(block)
            const signature = vendor?.signature
            if (!signature) continue
            if (vendor.redacted) {
                const redacted: RedactedThinkingBlockParam = {
                    type: 'redacted_thinking',
                    data: signature,
                }
                out.push(redacted)
            } else {
                const thinking: ThinkingBlockParam = {
                    type: 'thinking',
                    thinking: block.text,
                    signature,
                }
                out.push(thinking)
            }
        } else {
            out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments })
        }
    }
    return out
}

function readVendor(block: ThinkingBlock): AnthropicThinkingVendor | undefined {
    return block.vendor?.[VENDOR_KEY] as AnthropicThinkingVendor | undefined
}
function writeVendor(block: ThinkingBlock, value: AnthropicThinkingVendor): void {
    block.vendor = { ...block.vendor, [VENDOR_KEY]: value }
}

function nonEmpty(block: TextBlockParam | ImageBlockParam): boolean {
    if (block.type === 'text') return block.text.trim().length > 0
    return true
}

function mapStopReason(reason: AnthropicStopReason): StopReason {
    switch (reason) {
        case 'end_turn':
        case 'stop_sequence':
        case 'pause_turn':
        case 'refusal':
            return 'stop'
        case 'max_tokens':
            return 'length'
        case 'tool_use':
            return 'tool_use'
        default:
            return 'stop'
    }
}

/** Single-shot validation: send the smallest possible request to verify the
 *  key works. Returns null on success, an error message on failure. */
export async function validateApiKey(apiKey: string): Promise<string | null> {
    const oauth = isOAuthToken(apiKey)
    try {
        const client = oauth
            ? new Anthropic({
                  apiKey: null,
                  authToken: apiKey,
                  dangerouslyAllowBrowser: true,
                  defaultHeaders: {
                      'anthropic-dangerous-direct-browser-access': 'true',
                      'anthropic-beta': BETA_OAUTH,
                      'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
                      'x-app': 'cli',
                  },
              })
            : new Anthropic({
                  apiKey,
                  dangerouslyAllowBrowser: true,
                  defaultHeaders: { 'anthropic-beta': BETA_BASE },
              })
        await client.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 1,
            messages: [{ role: 'user', content: '.' }],
            ...(oauth ? { system: CLAUDE_CODE_SYSTEM } : {}),
        })
        return null
    } catch (err) {
        return err instanceof Error ? err.message : String(err)
    }
}
