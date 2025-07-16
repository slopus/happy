import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import { DecryptedMessage, Session, Message } from "./storageTypes";
import { createReducer, reducer, ReducerState } from "./reducer";

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
}

interface StorageState {
    sessions: Record<string, Session>;
    sessionsLoaded: boolean;
    sessionsActive: Session[];
    sessionsInactive: Session[];
    sessionMessages: Record<string, SessionMessages>;
    applySessions: (sessions: Session[]) => void;
    applyLoaded: () => void;
    applyMessages: (sessionId: string, messages: DecryptedMessage[]) => void;
    applyMessagesLoaded: (sessionId: string) => void;
}

export const storage = create<StorageState>()((set) => {
    return {
        sessionsLoaded: false,
        sessions: {},
        sessionsActive: [],
        sessionsInactive: [],
        sessionMessages: {},
        applySessions: (sessions: Session[]) => set((state) => {            
            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions
            sessions.forEach(session => {
                mergedSessions[session.id] = session;
            });

            // Build active set from all sessions (including existing ones)
            const activeSet = new Set<string>();
            Object.values(mergedSessions).forEach(session => {
                if (session.active && session.activeAt > Date.now() - 10 * 60 * 1000) {
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

            return {
                ...state,
                sessions: mergedSessions,
                sessionsLoaded: true,
                sessionsActive: activeSessions,
                sessionsInactive: inactiveSessions
            };
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsLoaded: true,
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

            // Reduce messages
            const processedMessages = reducer(existingSession.reducerState, messages);
            for (let m of messages) {
                if (m.content?.role === 'user') {
                    processedMessages.push({
                        id: m.id,
                        createdAt: m.createdAt,
                        role: 'user',
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
        })
    }
});

export function useSessions() {
    return storage(useShallow((state) => ({
        active: state.sessionsActive,
        inactive: state.sessionsInactive,
        loaded: state.sessionsLoaded
    })));
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