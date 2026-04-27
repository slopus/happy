import { useStore } from 'jotai'
import { useCallback, useEffect, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import {
    appendMessageAtom,
    chatByIdAtomFamily,
    updateChatAtom,
    updateMessageAtom,
    type ChatMessage,
    type ChatToolCall,
} from './store'
import { pluginHost } from '@/plugins'
import type { EffortLevel } from '@/app/state'
import { openAgentSession, type AgentSession } from '@/plugins/agent-bridge'
import type { AgentEffort, AgentEvent } from '../../shared/agent-protocol'

/* ─────────────────────────────────────────────────────────────────────────
 * Chat runner
 *
 * One worker-hosted Agent SDK session per chat. The chat's stable
 * `sessionId` is also the SDK's session id, so:
 *   - first turn: start with resume:false
 *   - subsequent turns this process:  send()
 *   - first turn after a process restart: start with resume:true
 *
 * Each SDK assistant message becomes its own chat row. State (currentMsgId,
 * per-message buffers) lives for the lifetime of the hook, NOT per-turn —
 * the Agent SDK session has a single event listener that needs to keep
 * working as the user sends follow-ups.
 * ──────────────────────────────────────────────────────────────────────── */

export interface RunArgs {
    chatId: string
    /** New user prompt to send. */
    prompt: string
    modelId: string
    effort?: EffortLevel
    systemPrompt?: string
}

const EFFORT_MAP: Record<EffortLevel, AgentEffort> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
}

interface MsgBuf {
    text: string
    thinking: string
    tools: ChatToolCall[]
    /** True once any stream delta has filled this buffer. The
     *  authoritative full assistant SDKMessage is then ignored — the
     *  streamed content already has everything (and matching them by
     *  index can cause text duplication). On replay (no deltas), we
     *  fall back to the full message. */
    streamed: boolean
}

interface RunState {
    chatId: string
    currentMsgId: string
    bufsByMsg: Map<string, MsgBuf>
    messageOrder: string[]
}

function newBuf(): MsgBuf {
    return { text: '', thinking: '', tools: [], streamed: false }
}

export function useChatRunner() {
    const store = useStore()
    const sessionRef = useRef<AgentSession | null>(null)
    const stateRef = useRef<RunState | null>(null)

    useEffect(() => {
        return () => {
            sessionRef.current?.stop()
            sessionRef.current = null
        }
    }, [])

    const interrupt = useCallback(() => {
        sessionRef.current?.interrupt()
    }, [])

    const run = useCallback(
        (args: RunArgs): void => {
            const chat = store.get(chatByIdAtomFamily(args.chatId))
            if (!chat) return

            const provider = pluginHost.inferenceFor(args.modelId)
            const apiKey = provider?.cap.getApiKey() ?? null

            // Append a fresh assistant placeholder for this turn. The
            // worker-emitted `assistant_turn_started` may add additional
            // rows below it as the agent alternates text/tool/text within
            // one user→answer cycle.
            const placeholderId = uuid()
            const placeholder: ChatMessage = { id: placeholderId, role: 'assistant', text: '' }
            store.set(appendMessageAtom, { chatId: args.chatId, message: placeholder })
            store.set(updateChatAtom, {
                chatId: args.chatId,
                patch: { status: 'streaming', error: undefined, modelId: args.modelId },
            })

            // Reuse the existing run-state across turns so the live listener
            // keeps writing to the right rows. First turn creates it.
            if (!stateRef.current) {
                stateRef.current = {
                    chatId: args.chatId,
                    currentMsgId: placeholderId,
                    bufsByMsg: new Map([[placeholderId, newBuf()]]),
                    messageOrder: [placeholderId],
                }
            } else {
                stateRef.current.currentMsgId = placeholderId
                stateRef.current.bufsByMsg.set(placeholderId, newBuf())
                stateRef.current.messageOrder.push(placeholderId)
            }
            const state = stateRef.current
            const onEvent = (ev: AgentEvent) => handleEvent(ev, state, store)

            if (sessionRef.current) {
                sessionRef.current.send(args.prompt)
                return
            }

            sessionRef.current = openAgentSession({
                sessionId: chat.sessionId,
                prompt: args.prompt,
                resume: chat.sessionStarted === true,
                options: {
                    ...(apiKey ? { apiKey } : {}),
                    model: args.modelId,
                    ...(args.effort ? { effort: EFFORT_MAP[args.effort] } : {}),
                    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
                },
                onEvent,
                onClosed: () => {
                    sessionRef.current = null
                },
            })
            store.set(updateChatAtom, { chatId: args.chatId, patch: { sessionStarted: true } })
        },
        [store],
    )

    return { run, interrupt }
}

/* ─────────── event reducer ─────────── */

function bufFor(state: RunState, msgId: string): MsgBuf {
    let b = state.bufsByMsg.get(msgId)
    if (!b) {
        b = newBuf()
        state.bufsByMsg.set(msgId, b)
    }
    return b
}

function flush(state: RunState, store: ReturnType<typeof useStore>, msgId: string) {
    const buf = bufFor(state, msgId)
    store.set(updateMessageAtom, {
        chatId: state.chatId,
        messageId: msgId,
        patch: {
            text: buf.text,
            thinking: buf.thinking || undefined,
            tools: buf.tools.length > 0 ? [...buf.tools] : undefined,
        },
    })
}

/** Search created messages newest→oldest for a tool by id. Tool results
 *  may target a tool from an earlier chat row in this run. */
function findMsgWithTool(state: RunState, toolId: string): string | null {
    for (let i = state.messageOrder.length - 1; i >= 0; i--) {
        const msgId = state.messageOrder[i]
        const buf = state.bufsByMsg.get(msgId)
        if (buf?.tools.some((t) => t.id === toolId)) return msgId
    }
    return null
}

/** Begin a fresh assistant chat row, unless the current row is still empty. */
function ensureFreshMessage(state: RunState, store: ReturnType<typeof useStore>) {
    const cur = bufFor(state, state.currentMsgId)
    const empty = cur.text.length === 0 && cur.thinking.length === 0 && cur.tools.length === 0
    if (empty) return
    store.set(updateMessageAtom, {
        chatId: state.chatId,
        messageId: state.currentMsgId,
        patch: { finished: true },
    })
    const newId = uuid()
    store.set(appendMessageAtom, {
        chatId: state.chatId,
        message: { id: newId, role: 'assistant', text: '' },
    })
    state.currentMsgId = newId
    state.messageOrder.push(newId)
    state.bufsByMsg.set(newId, newBuf())
}

function handleEvent(ev: AgentEvent, state: RunState, store: ReturnType<typeof useStore>) {
    if (ev.type === 'session_init') return

    if (ev.type === 'assistant_turn_started') {
        ensureFreshMessage(state, store)
        return
    }

    if (ev.type === 'text_delta') {
        const buf = bufFor(state, state.currentMsgId)
        buf.text += ev.delta
        buf.streamed = true
        flush(state, store, state.currentMsgId)
        return
    }
    if (ev.type === 'thinking_delta') {
        const buf = bufFor(state, state.currentMsgId)
        buf.thinking += ev.delta
        buf.streamed = true
        flush(state, store, state.currentMsgId)
        return
    }

    if (ev.type === 'assistant_complete') {
        // Authoritative snapshot. Only apply when streaming didn't fire
        // (resume / replay) — otherwise the streamed content already has
        // everything and re-applying duplicates it. Tool inputs always get
        // the parsed authoritative version.
        const buf = bufFor(state, state.currentMsgId)
        if (!buf.streamed) {
            buf.text = ev.text
            buf.thinking = ev.thinking ?? ''
        }
        const prevById = new Map(buf.tools.map((t) => [t.id, t]))
        buf.tools = ev.toolUses.map((u, i) => {
            const prev = prevById.get(u.id)
            return {
                index: i,
                id: u.id,
                name: u.name,
                inputJson: JSON.stringify(u.input, null, 2),
                ...(prev?.result !== undefined ? { result: prev.result, isError: prev.isError } : {}),
            }
        })
        flush(state, store, state.currentMsgId)
        return
    }

    if (ev.type === 'tool_use_start') {
        const buf = bufFor(state, state.currentMsgId)
        buf.tools.push({ index: buf.tools.length, id: ev.id, name: ev.name, inputJson: '' })
        buf.streamed = true
        flush(state, store, state.currentMsgId)
        return
    }
    if (ev.type === 'tool_use_input_delta') {
        const msgId = findMsgWithTool(state, ev.toolId)
        if (!msgId) return
        const buf = bufFor(state, msgId)
        const t = buf.tools.find((x) => x.id === ev.toolId)
        if (!t) return
        t.inputJson += ev.delta
        flush(state, store, msgId)
        return
    }
    if (ev.type === 'tool_result') {
        const msgId = findMsgWithTool(state, ev.toolUseId)
        if (!msgId) return
        const buf = bufFor(state, msgId)
        const t = buf.tools.find((x) => x.id === ev.toolUseId)
        if (!t) return
        t.result = ev.output
        t.isError = ev.isError
        flush(state, store, msgId)
        return
    }

    if (ev.type === 'turn_done') {
        store.set(updateMessageAtom, {
            chatId: state.chatId,
            messageId: state.currentMsgId,
            patch: {
                finished: true,
                ...(ev.subtype === 'error' ? { error: ev.error ?? 'Turn errored' } : {}),
            },
        })
        store.set(updateChatAtom, {
            chatId: state.chatId,
            patch: ev.subtype === 'error'
                ? { status: 'error', error: ev.error ?? 'Turn errored' }
                : { status: 'idle' },
        })
        return
    }

    if (ev.type === 'error') {
        store.set(updateMessageAtom, {
            chatId: state.chatId,
            messageId: state.currentMsgId,
            patch: { finished: true, error: ev.message },
        })
        store.set(updateChatAtom, {
            chatId: state.chatId,
            patch: { status: 'error', error: ev.message },
        })
        return
    }
}
