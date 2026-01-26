import type { DiscardedPendingMessage, PendingMessage } from '../../storageTypes';

import type { StoreGet, StoreSet } from './_shared';

export type SessionPending = {
    messages: PendingMessage[];
    discarded: DiscardedPendingMessage[];
    isLoaded: boolean;
};

export type PendingDomain = {
    sessionPending: Record<string, SessionPending>;
    applyPendingLoaded: (sessionId: string) => void;
    applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => void;
    applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => void;
    upsertPendingMessage: (sessionId: string, message: PendingMessage) => void;
    removePendingMessage: (sessionId: string, pendingId: string) => void;
};

export function createPendingDomain<S extends PendingDomain>({
    set,
    get: _get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): PendingDomain {
    return {
        sessionPending: {},
        applyPendingLoaded: (sessionId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: existing?.messages ?? [],
                        discarded: existing?.discarded ?? [],
                        isLoaded: true
                    }
                }
            };
        }),
        applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => set((state) => ({
            ...state,
            sessionPending: {
                ...state.sessionPending,
                [sessionId]: {
                    messages,
                    discarded: state.sessionPending[sessionId]?.discarded ?? [],
                    isLoaded: true
                }
            }
        })),
        applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => set((state) => ({
            ...state,
            sessionPending: {
                ...state.sessionPending,
                [sessionId]: {
                    messages: state.sessionPending[sessionId]?.messages ?? [],
                    discarded: messages,
                    isLoaded: state.sessionPending[sessionId]?.isLoaded ?? false,
                },
            },
        })),
        upsertPendingMessage: (sessionId: string, message: PendingMessage) => set((state) => {
            const existing = state.sessionPending[sessionId] ?? { messages: [], discarded: [], isLoaded: false };
            const idx = existing.messages.findIndex((m) => m.id === message.id);
            const next = idx >= 0
                ? [...existing.messages.slice(0, idx), message, ...existing.messages.slice(idx + 1)]
                : [...existing.messages, message].sort((a, b) => a.createdAt - b.createdAt);
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: next,
                        discarded: existing.discarded,
                        isLoaded: existing.isLoaded
                    }
                }
            };
        }),
        removePendingMessage: (sessionId: string, pendingId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (!existing) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: existing.messages.filter((m) => m.id !== pendingId)
                    }
                }
            };
        }),
    };
}

