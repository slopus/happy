import * as React from 'react';
import { create } from 'zustand';
import { randomUUID } from 'expo-crypto';

/**
 * A chat that is on screen before it exists on a machine.
 *
 * Starting a session is a round trip to a computer that can take seconds. The
 * tab strip's `+` does not spend them watching a spinner: the tab and the
 * screen arrive on the press, and the machine's answer catches up underneath.
 *
 * Memory-only and deliberately not persisted — an app that was restarted has
 * no start in flight to rejoin.
 */
export interface PendingChat {
    /** Stands in for a session id, the route's `id` included. */
    id: string;
    /** The chat it was started beside: its checkout, and the settings it copies. */
    anchorSessionId: string;
    /** The real session, once the machine answers. */
    sessionId: string | null;
    /**
     * The chats already in the checkout when this one was asked for.
     *
     * A session reaches the list before the request that created it comes back
     * with its name — the server announces it over the socket, which is a
     * shorter trip than the daemon's reply. Without a record of what was there
     * first, that arrival is drawn as a second tab beside the stand-in for the
     * very same chat. Identity rather than timestamps, because the two ends
     * keep their own clocks.
     */
    knownSessionIds: readonly string[];
    /**
     * `failed` means the start already reported itself and the tab is on its
     * way out. The record outlives the failure so the screen standing on it
     * still knows which chat to return to.
     */
    status: 'starting' | 'failed';
    /**
     * What has been typed into the stand-in's composer.
     *
     * Held here rather than in the screen because the screen is not the only
     * place it has to survive: switching to a sibling tab and back unmounts it,
     * and the handover to the real chat has to work whether or not anybody is
     * still looking at the stand-in.
     */
    draft: string;
    /**
     * Messages sent before the machine answered, in the order they were sent.
     *
     * Separate from the draft because they are no longer being written: send
     * has already been pressed on them, and only a chat to deliver them to is
     * missing. Keeping them in the draft is what let a second send overwrite
     * the first, and a return to the tab re-type a message already on its way.
     */
    queued: readonly string[];
    createdAt: number;
}

const PREFIX = 'pending-chat:';

/** Tells a stand-in apart from a real session id, which is a plain opaque key. */
export function isPendingChatId(id: string): boolean {
    return id.startsWith(PREFIX);
}

interface PendingChatsState {
    chats: Record<string, PendingChat>;
}

const usePendingChatsStore = create<PendingChatsState>()(() => ({ chats: {} }));

/**
 * A chat that can be opened immediately, running where `anchorSessionId` runs.
 *
 * A record outlives its own screen on purpose, and it outlives the chat's
 * arrival too: the route stays on the stand-in for as long as the screen
 * stands there, and the record is what maps that id to the chat it became.
 * The screen retires it on the way out; the sweep here is only for the records
 * of starts that failed, which no screen is left standing on.
 */
export function openPendingChat(
    anchorSessionId: string,
    knownSessionIds: readonly string[],
): PendingChat {
    const chat: PendingChat = {
        id: `${PREFIX}${randomUUID()}`,
        anchorSessionId,
        sessionId: null,
        knownSessionIds: [...knownSessionIds],
        status: 'starting',
        draft: '',
        queued: [],
        createdAt: Date.now(),
    };
    usePendingChatsStore.setState((state) => {
        const chats: Record<string, PendingChat> = { [chat.id]: chat };
        for (const existing of Object.values(state.chats)) {
            if (existing.status !== 'failed') {
                chats[existing.id] = existing;
            }
        }
        return { chats };
    });
    return chat;
}

/**
 * Keystrokes in the stand-in's composer.
 *
 * Ignored once the chat has a session: from that moment the real composer owns
 * the text, and a late keystroke from the screen on its way out would otherwise
 * be handed over a second time on top of it.
 */
export function setPendingChatDraft(id: string, draft: string): void {
    usePendingChatsStore.setState((state) => {
        const chat = state.chats[id];
        if (!chat || chat.sessionId || chat.draft === draft) return state;
        return { chats: { ...state.chats, [id]: { ...chat, draft } } };
    });
}

/**
 * Send, pressed on a chat that does not exist yet. Nothing is transmitted here
 * — the message leaves the composer exactly as it would anywhere else and waits
 * in line, and the handover is what eventually delivers it.
 */
export function submitPendingChat(id: string, message: string): void {
    usePendingChatsStore.setState((state) => {
        const chat = state.chats[id];
        if (!chat || chat.sessionId || !message.trim()) return state;
        return {
            chats: {
                ...state.chats,
                [id]: { ...chat, draft: '', queued: [...chat.queued, message] },
            },
        };
    });
}

/** The machine answered: from here on the chat goes by its real session id. */
export function settlePendingChat(id: string, sessionId: string): void {
    usePendingChatsStore.setState((state) => {
        const chat = state.chats[id];
        if (!chat || chat.sessionId) return state;
        return { chats: { ...state.chats, [id]: { ...chat, sessionId } } };
    });
}

/** The start gave up. It has already said why; this only retires the tab. */
export function failPendingChat(id: string): void {
    usePendingChatsStore.setState((state) => {
        const chat = state.chats[id];
        if (!chat || chat.sessionId) return state;
        return { chats: { ...state.chats, [id]: { ...chat, status: 'failed' } } };
    });
}

export function dismissPendingChat(id: string): void {
    usePendingChatsStore.setState((state) => {
        if (!state.chats[id]) return state;
        const chats = { ...state.chats };
        delete chats[id];
        return { chats };
    });
}

export function getPendingChat(id: string): PendingChat | null {
    return usePendingChatsStore.getState().chats[id] ?? null;
}

export function usePendingChat(id: string): PendingChat | null {
    return usePendingChatsStore((state) => state.chats[id] ?? null);
}

/**
 * Every chat being opened beside any of `siblingIds`, oldest first — settled
 * ones included, because a chat that has just been named is not yet a tab: the
 * list has to carry it first. Which of these the strip actually draws is
 * `resolveWorktreeTabs`' decision.
 */
export function usePendingChatsBeside(siblingIds: readonly string[]): PendingChat[] {
    const chats = usePendingChatsStore((state) => state.chats);
    return React.useMemo(() => (
        Object.values(chats)
            .filter((chat) => (
                chat.status === 'starting'
                && siblingIds.includes(chat.anchorSessionId)
            ))
            .sort((a, b) => a.createdAt - b.createdAt)
    ), [chats, siblingIds]);
}

/** Every record, for callers that do their own matching against a checkout. */
export function usePendingChatRecords(): Record<string, PendingChat> {
    return usePendingChatsStore((state) => state.chats);
}

/** Test seam: the store is module state. */
export function resetPendingChats(): void {
    usePendingChatsStore.setState({ chats: {} });
}
