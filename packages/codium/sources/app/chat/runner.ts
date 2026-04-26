import { useSetAtom } from 'jotai'
import { useCallback, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import {
    appendMessageAtom,
    updateChatAtom,
    updateMessageAtom,
    type ChatMessage,
} from './store'
import {
    pluginHost,
    type AssistantContent,
    type InferenceContext,
    type Message,
} from '@/plugins'
import type { EffortLevel } from '@/app/state'

/* ─────────────────────────────────────────────────────────────────────────
 * Chat runner
 *
 * Owns the state transitions during a single inference call:
 *  - inserts an empty assistant message into the chat
 *  - kicks off pluginHost.inferenceFor(modelId).cap.stream(…)
 *  - feeds text/thinking deltas into the assistant message
 *  - resolves on `done` / `error`, marking the message finished
 *
 * Returns an AbortController so callers can cancel mid-stream.
 * ──────────────────────────────────────────────────────────────────────── */

export interface RunArgs {
    chatId: string
    /** Existing chat history (already includes the user turn we're answering). */
    history: ChatMessage[]
    modelId: string
    effort?: EffortLevel
    systemPrompt?: string
}

function toInferenceMessages(history: ChatMessage[]): Message[] {
    const out: Message[] = []
    for (const m of history) {
        if (m.role === 'user') {
            if (m.text.length === 0) continue
            out.push({ role: 'user', content: [{ type: 'text', text: m.text }] })
        } else {
            const blocks: AssistantContent[] = []
            // Preserve thinking blocks (with their provider-specific vendor
            // payload) so e.g. Codex reasoning continuity isn't broken.
            if (m.thinking && m.thinking.length > 0) {
                blocks.push({
                    type: 'thinking',
                    text: m.thinking,
                    vendor: m.thinkingVendor,
                })
            }
            if (m.text.length > 0) {
                blocks.push({ type: 'text', text: m.text })
            }
            if (blocks.length > 0) {
                out.push({ role: 'assistant', content: blocks })
            }
        }
    }
    return out
}

export function useChatRunner() {
    const append = useSetAtom(appendMessageAtom)
    const updateMsg = useSetAtom(updateMessageAtom)
    const updateChat = useSetAtom(updateChatAtom)
    const activeRef = useRef<AbortController | null>(null)

    const cancel = useCallback(() => {
        activeRef.current?.abort()
        activeRef.current = null
    }, [])

    const run = useCallback(
        async (args: RunArgs): Promise<void> => {
            const inferenceProvider = pluginHost.inferenceFor(args.modelId)
            if (!inferenceProvider) {
                updateChat({
                    chatId: args.chatId,
                    patch: { status: 'error', error: `No plugin provides "${args.modelId}". Connect one in Plugins.` },
                })
                return
            }
            const { cap } = inferenceProvider

            // Insert an empty assistant placeholder we'll fill via deltas.
            const assistantId = uuid()
            const assistantMsg: ChatMessage = {
                id: assistantId,
                role: 'assistant',
                text: '',
            }
            append({ chatId: args.chatId, message: assistantMsg })
            updateChat({ chatId: args.chatId, patch: { status: 'streaming', error: undefined, modelId: args.modelId } })

            const ctrl = new AbortController()
            activeRef.current = ctrl

            const ctx: InferenceContext = {
                systemPrompt: args.systemPrompt,
                messages: toInferenceMessages(args.history),
            }

            try {
                let accumulatedText = ''
                let accumulatedThinking = ''
                for await (const ev of cap.stream(args.modelId, ctx, {
                    effort: args.effort,
                    signal: ctrl.signal,
                })) {
                    if (ev.type === 'text_delta') {
                        accumulatedText += ev.delta
                        updateMsg({ chatId: args.chatId, messageId: assistantId, patch: { text: accumulatedText } })
                    } else if (ev.type === 'thinking_delta') {
                        accumulatedThinking += ev.delta
                        updateMsg({ chatId: args.chatId, messageId: assistantId, patch: { thinking: accumulatedThinking } })
                    } else if (ev.type === 'done') {
                        // Pull the thinking block's vendor payload off the
                        // assembled message so we can round-trip it to the
                        // model on the next turn (Codex requires this).
                        const thinking = ev.message.content.find(
                            (b): b is Extract<AssistantContent, { type: 'thinking' }> =>
                                b.type === 'thinking',
                        )
                        updateMsg({
                            chatId: args.chatId,
                            messageId: assistantId,
                            patch: {
                                finished: true,
                                thinkingVendor: thinking?.vendor,
                            },
                        })
                        updateChat({ chatId: args.chatId, patch: { status: 'idle' } })
                    } else if (ev.type === 'error') {
                        const message = ev.error ?? 'Inference failed'
                        updateMsg({
                            chatId: args.chatId,
                            messageId: assistantId,
                            patch: { finished: true, error: message },
                        })
                        updateChat({ chatId: args.chatId, patch: { status: 'error', error: message } })
                    }
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                updateMsg({
                    chatId: args.chatId,
                    messageId: assistantId,
                    patch: { finished: true, error: message },
                })
                updateChat({ chatId: args.chatId, patch: { status: 'error', error: message } })
            } finally {
                activeRef.current = null
            }
        },
        [append, updateMsg, updateChat]
    )

    return { run, cancel }
}
