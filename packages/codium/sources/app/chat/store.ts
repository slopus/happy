import { atom } from 'jotai'
import { v4 as uuid } from 'uuid'

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
    id: string
    role: ChatRole
    /** Visible markdown body. */
    text: string
    /** Reasoning summary streamed for thinking-capable models. */
    thinking?: string
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
    status: 'idle' | 'streaming' | 'error'
    error?: string
    createdAt: number
    updatedAt: number
}

/* ─────────── store ─────────── */

const chatsAtom = atom<Record<string, Chat>>({})
const chatOrderAtom = atom<string[]>([])

/** All chats, newest-first. */
export const chatListAtom = atom((get) => {
    const chats = get(chatsAtom)
    const order = get(chatOrderAtom)
    return order.map((id) => chats[id]).filter((c): c is Chat => Boolean(c))
})

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
