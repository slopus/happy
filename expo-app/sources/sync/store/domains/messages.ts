import { PERMISSION_MODES } from '@/constants/PermissionModes';
import type { PermissionMode } from '@/sync/permissionTypes';
import { isMutableTool } from '@/components/tools/knownTools';

import { createReducer, reducer, type ReducerState } from '../../reducer/reducer';
import type { Message } from '../../typesMessage';
import type { NormalizedMessage } from '../../typesRaw';
import type { Session } from '../../storageTypes';

import { persistSessionPermissionData } from './sessions';
import type { SessionPending } from './pending';
import type { StoreGet, StoreSet } from './_shared';

export type SessionMessages = {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
};

export type MessagesDomain = {
    sessionMessages: Record<string, SessionMessages>;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[]; hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
};

type MessagesDomainDependencies = {
    sessions: Record<string, Session>;
    sessionPending: Record<string, SessionPending>;
};

export function createMessagesDomain<S extends MessagesDomain & MessagesDomainDependencies>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): MessagesDomain {
    return {
        sessionMessages: {},
        isMutableToolCall: (sessionId: string, callId: string) => {
            const sessionMessages = get().sessionMessages[sessionId];
            if (!sessionMessages) {
                return true;
            }
            const toolCall = sessionMessages.reducerState.toolIdToMessageId.get(callId);
            if (!toolCall) {
                return true;
            }
            const toolCallMessage = sessionMessages.messagesMap[toolCall];
            if (!toolCallMessage || toolCallMessage.kind !== 'tool-call') {
                return true;
            }
            return toolCallMessage.tool?.name ? isMutableTool(toolCallMessage.tool?.name) : true;
        },
        applyMessages: (sessionId: string, messages: NormalizedMessage[]) => {
            let changed = new Set<string>();
            let hasReadyEvent = false;
            set((state) => {
                // Resolve session messages state
                const existingSession = state.sessionMessages[sessionId] || {
                    messages: [],
                    messagesMap: {},
                    reducerState: createReducer(),
                    isLoaded: false
                };

                // Get the session's agentState if available
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                // Messages are already normalized, no need to process them again
                const normalizedMessages = messages;

                // Run reducer with agentState
                const reducerResult = reducer(existingSession.reducerState, normalizedMessages, agentState);
                const processedMessages = reducerResult.messages;
                for (let message of processedMessages) {
                    changed.add(message.id);
                }
                if (reducerResult.hasReadyEvent) {
                    hasReadyEvent = true;
                }

                // Merge messages
                const mergedMessagesMap = { ...existingSession.messagesMap };
                processedMessages.forEach(message => {
                    mergedMessagesMap[message.id] = message;
                });

                // Convert to array and sort by createdAt
                const messagesArray = Object.values(mergedMessagesMap)
                    .sort((a, b) => b.createdAt - a.createdAt);

                // Infer session permission mode from the most recent user message meta.
                // This makes permission mode "follow" the session across devices/machines without adding server fields.
                // Local user changes should win until the next user message is sent (tracked by permissionModeUpdatedAt).
                let inferredPermissionMode: PermissionMode | null = null;
                let inferredPermissionModeAt: number | null = null;
                for (const message of messagesArray) {
                    if (message.kind !== 'user-text') continue;
                    const rawMode = message.meta?.permissionMode;
                    if (!rawMode || !PERMISSION_MODES.includes(rawMode as any)) continue;
                    const mode = rawMode as PermissionMode;
                    inferredPermissionMode = mode;
                    inferredPermissionModeAt = message.createdAt;
                    break;
                }

                // Clear server-pending items once we see the corresponding user message in the transcript.
                // We key this off localId, which is preserved when a pending item is materialized into a SessionMessage.
                let updatedSessionPending = state.sessionPending;
                const pendingState = state.sessionPending[sessionId];
                if (pendingState && pendingState.messages.length > 0) {
                    const localIdsToClear = new Set<string>();
                    for (const m of processedMessages) {
                        if (m.kind === 'user-text' && m.localId) {
                            localIdsToClear.add(m.localId);
                        }
                    }
                    if (localIdsToClear.size > 0) {
                        const filtered = pendingState.messages.filter((p) => !p.localId || !localIdsToClear.has(p.localId));
                        if (filtered.length !== pendingState.messages.length) {
                            updatedSessionPending = {
                                ...state.sessionPending,
                                [sessionId]: {
                                    ...pendingState,
                                    messages: filtered
                                }
                            };
                        }
                    }
                }

                // Update session with todos and latestUsage
                // IMPORTANT: We extract latestUsage from the mutable reducerState and copy it to the Session object
                // This ensures latestUsage is available immediately on load, even before messages are fully loaded
                let updatedSessions = state.sessions;
                const needsUpdate = (reducerResult.todos !== undefined || existingSession.reducerState.latestUsage) && session;

                const canInferPermissionMode = Boolean(
                    session &&
                    inferredPermissionMode &&
                    inferredPermissionModeAt &&
                    // NOTE: inferredPermissionModeAt comes from message.createdAt (server timestamp for remote messages,
                    // and best-effort server-aligned timestamp for locally-created optimistic messages).
                    // permissionModeUpdatedAt is stamped using nowServerMs() for clock-safe ordering across devices.
                    inferredPermissionModeAt > (session.permissionModeUpdatedAt ?? 0)
                );

                const shouldWritePermissionMode =
                    canInferPermissionMode &&
                    (session!.permissionMode ?? 'default') !== inferredPermissionMode;

                if (needsUpdate || shouldWritePermissionMode) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            ...(reducerResult.todos !== undefined && { todos: reducerResult.todos }),
                            // Copy latestUsage from reducerState to make it immediately available
                            latestUsage: existingSession.reducerState.latestUsage ? {
                                ...existingSession.reducerState.latestUsage
                            } : session.latestUsage,
                            ...(shouldWritePermissionMode && {
                                permissionMode: inferredPermissionMode,
                                permissionModeUpdatedAt: inferredPermissionModeAt
                            })
                        }
                    };

                    // Persist permission modes (only non-default values to save space)
                    // Note: this includes modes inferred from session messages so they load instantly on app restart.
                    if (shouldWritePermissionMode) {
                        persistSessionPermissionData(updatedSessions);
                    }
                }

                return {
                    ...state,
                    sessions: updatedSessions,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            messages: messagesArray,
                            messagesMap: mergedMessagesMap,
                            reducerState: existingSession.reducerState, // Explicitly include the mutated reducer state
                            isLoaded: true
                        }
                    },
                    sessionPending: updatedSessionPending
                };
            });

            return { changed: Array.from(changed), hasReadyEvent };
        },
        applyMessagesLoaded: (sessionId: string) => set((state) => {
            const existingSession = state.sessionMessages[sessionId];

            if (!existingSession) {
                // First time loading - check for AgentState
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                // Create new reducer state
                const reducerState = createReducer();

                // Process AgentState if it exists
                let messages: Message[] = [];
                let messagesMap: Record<string, Message> = {};

                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const reducerResult = reducer(reducerState, [], agentState);
                    const processedMessages = reducerResult.messages;

                    processedMessages.forEach(message => {
                        messagesMap[message.id] = message;
                    });

                    messages = Object.values(messagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);
                }

                // Extract latestUsage from reducerState if available and update session
                let updatedSessions = state.sessions;
                if (session && reducerState.latestUsage) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            latestUsage: { ...reducerState.latestUsage }
                        }
                    };
                }

                return {
                    ...state,
                    sessions: updatedSessions,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            reducerState,
                            messages,
                            messagesMap,
                            isLoaded: true
                        } satisfies SessionMessages
                    }
                };
            }

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existingSession,
                        isLoaded: true
                    } satisfies SessionMessages
                }
            };
        }),
    };
}
