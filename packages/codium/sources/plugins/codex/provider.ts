/* ─────────────────────────────────────────────────────────────────────────
 * Codex provider — streams from `chatgpt.com/backend-api/codex/responses`.
 *
 * Mirrors @mariozechner/pi-ai's openai-codex-responses provider, slimmed
 * down to what the renderer needs: text deltas, thinking summary, tool
 * calls, done/error. No retries / no tool-call streaming for now.
 *
 * Auth model:
 *  - The credential is the user's ChatGPT session token (a JWT). It is
 *    NOT an API key — fetched from the chatgpt.com cookie or the
 *    `~/.codex/auth.json` `tokens.id_token` field if running alongside
 *    Codex desktop.
 *  - We extract `chatgpt_account_id` from the JWT's
 *    `https://api.openai.com/auth` claim and put it in the request as
 *    the `chatgpt-account-id` header.
 * ──────────────────────────────────────────────────────────────────────── */
import type {
    AssistantContent,
    AssistantMessage,
    InferenceContext,
    Message,
    StreamEvent,
} from '../llm'

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'

export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface CodexParameters {
    effort?: CodexEffort
    /** Stable id used for prompt cache + `session_id` header. */
    sessionId?: string
    signal?: AbortSignal
}

export interface CodexCredential {
    accessToken: string
    accountId: string
}

/** Convert our internal `Message[]` to the Responses API `input` shape. */
function convertMessages(messages: Message[]): unknown[] {
    const out: unknown[] = []
    for (const msg of messages) {
        if (msg.role === 'user') {
            out.push({
                type: 'message',
                role: 'user',
                content: msg.content.map((b) =>
                    b.type === 'text'
                        ? { type: 'input_text', text: b.text }
                        : { type: 'input_image', image_url: `data:${b.mimeType};base64,${b.data}` },
                ),
            })
        } else if (msg.role === 'assistant') {
            const content: unknown[] = []
            for (const b of msg.content) {
                if (b.type === 'text' && b.text.length > 0) {
                    content.push({ type: 'output_text', text: b.text })
                }
                if (b.type === 'thinking') {
                    content.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: b.text }] })
                }
                if (b.type === 'tool_call') {
                    out.push({
                        type: 'function_call',
                        call_id: b.id,
                        name: b.name,
                        arguments: JSON.stringify(b.arguments),
                    })
                }
            }
            if (content.length > 0) {
                out.push({ type: 'message', role: 'assistant', content })
            }
        } else {
            const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
            out.push({
                type: 'function_call_output',
                call_id: msg.toolCallId,
                output: text,
            })
        }
    }
    return out
}

function buildHeaders(token: string, accountId: string, sessionId?: string): Record<string, string> {
    const h: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'chatgpt-account-id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codium',
        'User-Agent': 'codium/0.1 (browser)',
        accept: 'text/event-stream',
        'content-type': 'application/json',
    }
    if (sessionId) h.session_id = sessionId
    return h
}

/**
 * Codex's Responses endpoint rejects requests without `instructions`
 * (returns `{"detail":"Instructions are required"}`). The CLI ships its own
 * agentic prompt; for plain chat we send a minimal one.
 */
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.'

function buildBody(modelId: string, ctx: InferenceContext, params: CodexParameters): unknown {
    const instructions = (ctx.systemPrompt ?? '').trim().length > 0
        ? ctx.systemPrompt
        : DEFAULT_INSTRUCTIONS
    const body: Record<string, unknown> = {
        model: modelId,
        store: false,
        stream: true,
        instructions,
        input: convertMessages(ctx.messages),
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: params.sessionId,
        tool_choice: 'auto',
        parallel_tool_calls: true,
    }
    if (params.effort) {
        body.reasoning = { effort: params.effort, summary: 'auto' }
    }
    return body
}

/** Yield each `data:` payload from a server-sent-event stream. */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\n\n')
        while (idx !== -1) {
            const chunk = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const dataLines = chunk
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim())
            if (dataLines.length > 0) {
                const data = dataLines.join('\n').trim()
                if (data && data !== '[DONE]') {
                    try { yield JSON.parse(data) } catch {}
                }
            }
            idx = buffer.indexOf('\n\n')
        }
    }
}

interface CodexEvent {
    type?: string
    delta?: string
    output_index?: number
    item?: { type?: string; text?: string }
    response?: { error?: { message?: string }; status?: string; output?: unknown[] }
    code?: string
    message?: string
}

/**
 * Run a streaming inference. Yields utopia-shaped StreamEvents.
 * Only handles text + reasoning summary deltas — tool calls flow through
 * `response.completed.output` and we don't yet stream them incrementally.
 */
export async function* runStream(
    cred: CodexCredential,
    modelId: string,
    ctx: InferenceContext,
    params: CodexParameters,
): AsyncGenerator<StreamEvent, void, unknown> {
    const headers = buildHeaders(cred.accessToken, cred.accountId, params.sessionId)
    const body = JSON.stringify(buildBody(modelId, ctx, params))

    let response: Response
    try {
        response = await fetch(ENDPOINT, {
            method: 'POST',
            headers,
            body,
            signal: params.signal,
        })
    } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError'
        yield {
            type: 'error',
            reason: aborted ? 'aborted' : 'error',
            message: { role: 'assistant', content: [] },
            error: err instanceof Error ? err.message : String(err),
        }
        return
    }

    if (!response.ok) {
        const text = await response.text()
        yield {
            type: 'error',
            reason: 'error',
            message: { role: 'assistant', content: [] },
            error: parseFriendlyError(response.status, text),
        }
        return
    }
    if (!response.body) {
        yield {
            type: 'error', reason: 'error',
            message: { role: 'assistant', content: [] },
            error: 'No response body',
        }
        return
    }

    const out: AssistantMessage = { role: 'assistant', content: [] }
    // Map the server's output_index → our content array index
    const indexMap = new Map<number, number>()

    try {
        for await (const ev of parseSSE(response.body) as AsyncGenerator<CodexEvent>) {
            const type = ev.type
            if (!type) continue

            if (type === 'response.output_item.added') {
                const item = ev.item
                const outIdx = ev.output_index ?? out.content.length
                if (item?.type === 'message') {
                    const block: AssistantContent = { type: 'text', text: '' }
                    out.content.push(block)
                    indexMap.set(outIdx, out.content.length - 1)
                } else if (item?.type === 'reasoning') {
                    const block: AssistantContent = { type: 'thinking', text: '' }
                    out.content.push(block)
                    indexMap.set(outIdx, out.content.length - 1)
                }
                continue
            }
            if (type === 'response.output_text.delta' && typeof ev.delta === 'string') {
                const idx = indexMap.get(ev.output_index ?? -1)
                if (idx === undefined) continue
                const block = out.content[idx]
                if (block?.type === 'text') {
                    block.text += ev.delta
                    yield { type: 'text_delta', index: idx, delta: ev.delta }
                }
                continue
            }
            if (type === 'response.reasoning_summary_text.delta' && typeof ev.delta === 'string') {
                const idx = indexMap.get(ev.output_index ?? -1)
                if (idx === undefined) continue
                const block = out.content[idx]
                if (block?.type === 'thinking') {
                    block.text += ev.delta
                    yield { type: 'thinking_delta', index: idx, delta: ev.delta }
                }
                continue
            }
            if (type === 'response.output_text.done') {
                const idx = indexMap.get(ev.output_index ?? -1)
                if (idx === undefined) continue
                const block = out.content[idx]
                if (block?.type === 'text') {
                    yield { type: 'text_end', index: idx, text: block.text }
                }
                continue
            }
            if (type === 'response.reasoning_summary_text.done') {
                const idx = indexMap.get(ev.output_index ?? -1)
                if (idx === undefined) continue
                const block = out.content[idx]
                if (block?.type === 'thinking') {
                    yield { type: 'thinking_end', index: idx, text: block.text }
                }
                continue
            }
            if (type === 'response.failed' || type === 'error') {
                const message = ev.response?.error?.message ?? ev.message ?? 'Codex stream failed'
                yield {
                    type: 'error', reason: 'error', message: out, error: message,
                }
                return
            }
        }
    } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError'
        yield {
            type: 'error',
            reason: aborted ? 'aborted' : 'error',
            message: out,
            error: err instanceof Error ? err.message : String(err),
        }
        return
    }

    yield { type: 'done', reason: 'stop', message: out }
}

function parseFriendlyError(status: number, raw: string): string {
    try {
        const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string; plan_type?: string; resets_at?: number } }
        const e = parsed.error
        if (e) {
            if (status === 429 || /usage_limit|rate_limit/i.test(e.code ?? '')) {
                const plan = e.plan_type ? ` (${e.plan_type.toLowerCase()} plan)` : ''
                const mins = e.resets_at ? Math.max(0, Math.round((e.resets_at * 1000 - Date.now()) / 60000)) : null
                const when = mins != null ? ` Try again in ~${mins} min.` : ''
                return `You have hit your ChatGPT usage limit${plan}.${when}`.trim()
            }
            return e.message ?? raw
        }
    } catch {}
    if (status === 401) return 'Session token rejected. Sign back in to ChatGPT and paste a fresh token.'
    return raw || `Codex returned ${status}`
}

/** Validate the OAuth credential by sending an empty Responses request. The
 *  server replies 400 (bad input) on valid auth, 401/403 on expired auth. */
export async function validateCredential(
    cred: CodexCredential,
    signal?: AbortSignal,
): Promise<string | null> {
    if (!cred.accessToken || !cred.accountId) return 'Missing credential'
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: buildHeaders(cred.accessToken, cred.accountId),
            body: JSON.stringify({
                model: 'gpt-5.5',
                store: false,
                stream: false,
                instructions: DEFAULT_INSTRUCTIONS,
                input: [],
            }),
            signal,
        })
        if (res.status === 401 || res.status === 403) {
            return 'Authentication failed. Sign in again.'
        }
        if (res.status === 200 || res.status === 400) return null
        const text = await res.text()
        return parseFriendlyError(res.status, text)
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return 'Aborted'
        return err instanceof Error ? err.message : String(err)
    }
}
