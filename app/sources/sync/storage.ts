import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import { DecryptedMessage, Session, Message as Message } from "./storageTypes";
import { createReducer, reducer, ReducerState } from "./reducer";

// Session is considered online if it was active within this timeout
export const ONLINE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
}

export type SessionListItem = string | Session;

interface StorageState {
    sessions: Record<string, Session>;
    sessionsData: SessionListItem[] | null;
    sessionMessages: Record<string, SessionMessages>;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => void;
    applyLoaded: () => void;
    applyMessages: (sessionId: string, messages: DecryptedMessage[]) => void;
    applyMessagesLoaded: (sessionId: string) => void;
    recalculateOnline: () => void;
}

export const storage = create<StorageState>()((set) => {
    return {
        sessions: {},
        sessionsData: null,
        sessionMessages: {},
        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => set((state) => {
            const now = Date.now();
            const threshold = now - ONLINE_TIMEOUT_MS;
            
            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions with calculated presence
            sessions.forEach(session => {
                // Calculate presence based on active and activeAt
                const isOnline = session.active && session.activeAt > threshold;
                const presence: "online" | number = isOnline ? "online" : session.activeAt;
                
                mergedSessions[session.id] = {
                    ...session,
                    presence
                };
            });

            // Build active set from all sessions (including existing ones)
            const activeSet = new Set<string>();
            Object.values(mergedSessions).forEach(session => {
                if (session.presence === "online") {
                    activeSet.add(session.id);
                }
            });

            // Separate active and inactive sessions
            const activeSessions: Session[] = [];
            const inactiveSessions: Session[] = [];

            // Process all sessions from merged set
            Object.values(mergedSessions).forEach(session => {
                if (activeSet.has(session.id)) {
                    activeSessions.push(session);
                } else {
                    inactiveSessions.push(session);
                }
            });

            // Sort both arrays by lastMessage time or createdAt if no messages
            const getSortTime = (session: Session) => {
                if (session.lastMessage) {
                    return session.lastMessage.createdAt;
                }
                return session.createdAt;
            };

            activeSessions.sort((a, b) => getSortTime(b) - getSortTime(a));
            inactiveSessions.sort((a, b) => getSortTime(b) - getSortTime(a));

            // Build flat list data for FlashList
            const listData: SessionListItem[] = [];

            if (activeSessions.length > 0) {
                listData.push('online');
                listData.push(...activeSessions);
            }

            if (inactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...inactiveSessions);
            }

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData
            };
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsData: []
            };
            return result;
        }),
        applyMessages: (sessionId: string, messages: DecryptedMessage[]) => set((state) => {
            // Resolve session messages state
            const existingSession = state.sessionMessages[sessionId] || {
                messages: [],
                messagesMap: {},
                reducerState: createReducer(),
                isLoaded: false
            };

            // Build a set of existing local IDs for quick lookup
            const existingUserMessageLocalIds = new Set<string>();
            const existingAgentMessageIds = new Set<string>();
            Object.values(existingSession.messagesMap).forEach(msg => {
                if (msg.role === 'user' && msg.localId) {
                    existingUserMessageLocalIds.add(msg.localId);
                }
                if (msg.role === 'agent' && msg.id) {
                    existingAgentMessageIds.add(msg.id);
                }
            });

            // Reduce messages
            const newMessages = messages.filter(m => m.content?.role === 'agent' && !existingAgentMessageIds.has(m.id));
            const processedMessages = reducer(existingSession.reducerState, newMessages);

            // Add user messages to the mix
            for (let m of messages) {
                if (m.content?.role === 'user') {
                    if (m.localId && existingUserMessageLocalIds.has(m.localId)) {
                        continue;
                    }
                    processedMessages.push({
                        id: m.id,
                        createdAt: m.createdAt,
                        role: 'user',
                        localId: m.localId ?? null,
                        content: {
                            type: 'text',
                            text: m.content.content.text
                        }
                    });
                }
            }

            // Merge messages
            const mergedMessagesMap = { ...existingSession.messagesMap };
            processedMessages.forEach(message => {
                mergedMessagesMap[message.id] = message;
            });

            // Convert to array and sort by createdAt
            const messagesArray = Object.values(mergedMessagesMap)
                .sort((a, b) => b.createdAt - a.createdAt);

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existingSession,
                        messages: messagesArray,
                        messagesMap: mergedMessagesMap,
                        isLoaded: true
                    }
                }
            };
        }),
        applyMessagesLoaded: (sessionId: string) => set((state) => {
            const existingSession = state.sessionMessages[sessionId];
            let result;

            if (!existingSession) {
                result = {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            reducerState: createReducer(),
                            messages: [],
                            messagesMap: {},
                            isLoaded: true
                        }
                    }
                };
            } else {
                result = {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            isLoaded: true
                        }
                    }
                };
            }

            return result;
        }),
        recalculateOnline: () => set((state) => {
            const now = Date.now();
            const threshold = now - ONLINE_TIMEOUT_MS;

            // Update presence for all sessions
            const updatedSessions: Record<string, Session> = {};
            Object.entries(state.sessions).forEach(([id, session]) => {
                const isOnline = session.active && session.activeAt > threshold;
                updatedSessions[id] = {
                    ...session,
                    presence: isOnline ? "online" : session.activeAt
                };
            });

            // Build set of session IDs that should be active
            const shouldBeActiveSet = new Set<string>();
            Object.values(updatedSessions).forEach(session => {
                if (session.presence === "online") {
                    shouldBeActiveSet.add(session.id);
                }
            });

            // Build set of currently active session IDs
            const currentActiveSet = new Set<string>();
            if (state.sessionsData) {
                let inOnlineSection = false;
                for (const item of state.sessionsData) {
                    if (item === 'online') {
                        inOnlineSection = true;
                    } else if (item === 'offline') {
                        inOnlineSection = false;
                    } else if (typeof item !== 'string' && inOnlineSection) {
                        currentActiveSet.add(item.id);
                    }
                }
            }

            // Check if sets are equal
            if (shouldBeActiveSet.size === currentActiveSet.size &&
                [...shouldBeActiveSet].every(id => currentActiveSet.has(id))) {
                // No changes needed, return same state
                return state;
            }

            // Rebuild active and inactive lists
            const newActiveSessions: Session[] = [];
            const newInactiveSessions: Session[] = [];

            Object.values(updatedSessions).forEach(session => {
                if (shouldBeActiveSet.has(session.id)) {
                    newActiveSessions.push(session);
                } else {
                    newInactiveSessions.push(session);
                }
            });

            // Sort both arrays by lastMessage time or createdAt if no messages
            const getSortTime = (session: Session) => {
                if (session.lastMessage) {
                    return session.lastMessage.createdAt;
                }
                return session.createdAt;
            };

            newActiveSessions.sort((a, b) => getSortTime(b) - getSortTime(a));
            newInactiveSessions.sort((a, b) => getSortTime(b) - getSortTime(a));

            // Build flat list data for FlashList
            const listData: SessionListItem[] = [];

            if (newActiveSessions.length > 0) {
                listData.push('online');
                listData.push(...newActiveSessions);
            }

            if (newInactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...newInactiveSessions);
            }

            return {
                ...state,
                sessions: updatedSessions,
                sessionsData: listData
            };
        })
    }
});

export function useSessions() {
    return storage(useShallow((state) => state.sessionsData));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: Message[] = [];

export function useSessionMessages(sessionId: string): { messages: Message[], isLoaded: boolean } {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return {
            messages: session?.messages ?? emptyArray,
            isLoaded: session?.isLoaded ?? false
        };
    }));
}

export function useMessage(sessionId: string, messageId: string): Message | null {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.messagesMap[messageId] ?? null;
    }));
}