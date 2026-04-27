import { atom } from 'jotai'
import { v4 as uuid } from 'uuid'

export type ChatRole = 'user' | 'assistant'

export interface ChatToolCall {
    /** SDK content block index — stable across deltas within a turn. */
    index: number
    /** Anthropic tool_use id; matches the future tool_result.toolUseId. */
    id: string
    name: string
    /** Raw JSON args, accumulated as input_json_delta lands. May be a
     *  partial JSON fragment until the block ends. */
    inputJson: string
    /** Result text once the tool has run; undefined while pending. */
    result?: string
    isError?: boolean
}

export interface ChatMessage {
    id: string
    role: ChatRole
    /** Visible markdown body. */
    text: string
    /** Reasoning summary streamed for thinking-capable models. */
    thinking?: string
    /** Tool calls the assistant made during this turn, in the order they
     *  appeared. Each entry's `result` is filled in when the tool returns. */
    tools?: ChatToolCall[]
    /** Set when the message has finished streaming or produced an error. */
    finished?: boolean
    error?: string
}

export interface Chat {
    id: string
    title: string
    messages: ChatMessage[]
    /** Which model id was used for the most recent assistant turn (for display). */
    modelId?: string
    /** Caller-generated UUID that doubles as the agent SDK's session id.
     *  Persisted across turns so follow-ups resume the same session. */
    sessionId: string
    /** True once we've sent a `start` for this session in this process.
     *  Subsequent turns use `send`; restarts after process death use
     *  `start` with `resume: true`. */
    sessionStarted?: boolean
    status: 'idle' | 'streaming' | 'error'
    error?: string
    createdAt: number
    updatedAt: number
}

/* ─────────── store ─────────── */

export const chatsAtom = atom<Record<string, Chat>>({})
export const chatOrderAtom = atom<string[]>([])

/** All chats, newest-first. */
export const chatListAtom = atom((get) => {
    const chats = get(chatsAtom)
    const order = get(chatOrderAtom)
    return order.map((id) => chats[id]).filter((c): c is Chat => Boolean(c))
})

/** Replace the entire store from a persisted snapshot (boot path). Strips
 *  transient runtime fields so a chat that was streaming when the app died
 *  reopens as idle, not stuck mid-stream. */
export const hydrateChatsAtom = atom(
    null,
    (_get, set, snapshot: { chats: Record<string, Chat>; order: string[] }) => {
        const sanitized: Record<string, Chat> = {}
        for (const [id, c] of Object.entries(snapshot.chats)) {
            if (!c) continue
            sanitized[id] = {
                ...c,
                status: 'idle',
                error: undefined,
                messages: c.messages.map((m) => ({
                    ...m,
                    finished: m.finished ?? true,
                })),
            }
        }
        set(chatsAtom, sanitized)
        set(chatOrderAtom, snapshot.order.filter((id) => id in sanitized))
    },
)

/** A specific chat by id. */
export const chatByIdAtomFamily = (id: string) =>
    atom((get) => get(chatsAtom)[id])

/* ─────────── mutations ─────────── */

export const createChatAtom = atom(
    null,
    (_get, set, init: { title?: string; firstUserMessage?: string }) => {
        const id = uuid()
        const now = Date.now()
        const messages: ChatMessage[] = []
        if (init.firstUserMessage) {
            messages.push({ id: uuid(), role: 'user', text: init.firstUserMessage, finished: true })
        }
        const chat: Chat = {
            id,
            title: init.title ?? init.firstUserMessage?.slice(0, 60) ?? 'New chat',
            messages,
            sessionId: uuid(),
            status: 'idle',
            createdAt: now,
            updatedAt: now,
        }
        set(chatsAtom, (prev) => ({ ...prev, [id]: chat }))
        set(chatOrderAtom, (prev) => [id, ...prev])
        return chat
    }
)

export const appendMessageAtom = atom(
    null,
    (_get, set, args: { chatId: string; message: ChatMessage }) => {
        set(chatsAtom, (prev) => {
            const c = prev[args.chatId]
            if (!c) return prev
            return {
                ...prev,
                [args.chatId]: {
                    ...c,
                    messages: [...c.messages, args.message],
                    updatedAt: Date.now(),
                },
            }
        })
    }
)

export const updateMessageAtom = atom(
    null,
    (_get, set, args: { chatId: string; messageId: string; patch: Partial<ChatMessage> }) => {
        set(chatsAtom, (prev) => {
            const c = prev[args.chatId]
            if (!c) return prev
            const messages = c.messages.map((m) =>
                m.id === args.messageId ? { ...m, ...args.patch } : m
            )
            return { ...prev, [args.chatId]: { ...c, messages, updatedAt: Date.now() } }
        })
    }
)

export const updateChatAtom = atom(
    null,
    (_get, set, args: { chatId: string; patch: Partial<Chat> }) => {
        set(chatsAtom, (prev) => {
            const c = prev[args.chatId]
            if (!c) return prev
            return { ...prev, [args.chatId]: { ...c, ...args.patch, updatedAt: Date.now() } }
        })
    }
)

/** Drop a chat. The Agent SDK's session jsonl on disk is left alone — if
 *  we ever re-create a chat with the same sessionId it'd resume there. */
export const deleteChatAtom = atom(
    null,
    (_get, set, chatId: string) => {
        set(chatsAtom, (prev) => {
            if (!(chatId in prev)) return prev
            const next = { ...prev }
            delete next[chatId]
            return next
        })
        set(chatOrderAtom, (prev) => prev.filter((id) => id !== chatId))
    },
)
