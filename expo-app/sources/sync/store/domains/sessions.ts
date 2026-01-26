import type { GitStatus, Machine, Session } from '../../storageTypes';
import { createReducer, reducer } from '../../reducer/reducer';
import type { NormalizedMessage } from '../../typesRaw';
import { buildSessionListViewData, type SessionListViewItem } from '../../sessionListViewData';
import { nowServerMs } from '../../time';
import { loadSessionDrafts, loadSessionLastViewed, loadSessionModelModes, loadSessionPermissionModeUpdatedAts, loadSessionPermissionModes, saveSessionDrafts, saveSessionLastViewed, saveSessionModelModes, saveSessionPermissionModeUpdatedAts, saveSessionPermissionModes } from '../../persistence';
import { projectManager } from '../../projectManager';
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import type { PermissionMode } from '@/sync/permissionTypes';

import type { StoreGet, StoreSet } from './_shared';
import type { SessionMessages } from './messages';

type SessionModelMode = NonNullable<Session['modelMode']>;

export type SessionsDomain = {
    sessions: Record<string, Session>;
    sessionsData: (string | Session)[] | null;
    sessionListViewData: SessionListViewItem[] | null;
    sessionGitStatus: Record<string, GitStatus | null>;
    sessionLastViewed: Record<string, number>;
    isDataReady: boolean;

    getActiveSessions: () => Session[];
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    applyLoaded: () => void;
    applyReady: () => void;

    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionViewed: (sessionId: string) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => void;

    getProjects: () => import('../../projectManager').Project[];
    getProject: (projectId: string) => import('../../projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('../../projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];

    getProjectGitStatus: (projectId: string) => GitStatus | null;
    getSessionProjectGitStatus: (sessionId: string) => GitStatus | null;
    updateSessionProjectGitStatus: (sessionId: string, status: GitStatus | null) => void;

    deleteSession: (sessionId: string) => void;
};

type SessionsDomainDependencies = {
    machines: Record<string, Machine>;
    sessionMessages: Record<string, SessionMessages>;
    settings: { groupInactiveSessionsByProject: boolean };
};

function extractSessionPermissionData(sessions: Record<string, Session>): {
    modes: Record<string, PermissionMode>;
    updatedAts: Record<string, number>;
} {
    const modes: Record<string, PermissionMode> = {};
    const updatedAts: Record<string, number> = {};

    Object.entries(sessions).forEach(([id, sess]) => {
        if (sess.permissionMode && sess.permissionMode !== 'default') {
            modes[id] = sess.permissionMode;
        }
        if (typeof sess.permissionModeUpdatedAt === 'number') {
            updatedAts[id] = sess.permissionModeUpdatedAt;
        }
    });

    return { modes, updatedAts };
}

export function persistSessionPermissionData(sessions: Record<string, Session>): {
    modes: Record<string, PermissionMode>;
    updatedAts: Record<string, number>;
} | null {
    const { modes, updatedAts } = extractSessionPermissionData(sessions);

    try {
        saveSessionPermissionModes(modes);
        saveSessionPermissionModeUpdatedAts(updatedAts);
        return { modes, updatedAts };
    } catch (e) {
        console.error('Failed to persist session permission data:', e);
        return null;
    }
}

// UI-only "optimistic processing" marker.
// Cleared via timers so components don't need to poll time.
const OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS = 15_000;
const optimisticThinkingTimeoutBySessionId = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Centralized session online state resolver
 * Returns either "online" (string) or a timestamp (number) for last seen
 */
function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): "online" | number {
    // Session is online if the active flag is true
    return session.active ? "online" : session.activeAt;
}

/**
 * Checks if a session should be shown in the active sessions group
 */
function isSessionActive(session: { active: boolean; activeAt: number }): boolean {
    // Use the active flag directly, no timeout checks
    return session.active;
}

export function createSessionsDomain<S extends SessionsDomain & SessionsDomainDependencies>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): SessionsDomain {
    let sessionDrafts = loadSessionDrafts();
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    let sessionPermissionModeUpdatedAts = loadSessionPermissionModeUpdatedAts();
    let sessionLastViewed = loadSessionLastViewed();

    return {
        sessions: {},
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionGitStatus: {},
        sessionLastViewed,
        isDataReady: false,
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
	        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => set((state) => {
            // Load drafts and permission modes if sessions are empty (initial load)
            const savedDrafts = Object.keys(state.sessions).length === 0 ? sessionDrafts : {};
            const savedPermissionModes = Object.keys(state.sessions).length === 0 ? sessionPermissionModes : {};
            const savedModelModes = Object.keys(state.sessions).length === 0 ? sessionModelModes : {};
            const savedPermissionModeUpdatedAts = Object.keys(state.sessions).length === 0 ? sessionPermissionModeUpdatedAts : {};

            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Preserve existing draft and permission mode if they exist, or load from saved data
                const existingDraft = state.sessions[session.id]?.draft;
                const savedDraft = savedDrafts[session.id];
                const existingPermissionMode = state.sessions[session.id]?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                const existingModelMode = state.sessions[session.id]?.modelMode;
                const savedModelMode = savedModelModes[session.id];
                const existingPermissionModeUpdatedAt = state.sessions[session.id]?.permissionModeUpdatedAt;
                const savedPermissionModeUpdatedAt = savedPermissionModeUpdatedAts[session.id];
                const existingOptimisticThinkingAt = state.sessions[session.id]?.optimisticThinkingAt ?? null;

                // CLI may publish a session permission mode in encrypted metadata for local-only starts.
                // This is a fallback signal for when there are no app-sent user messages carrying meta.permissionMode yet.
                const metadataPermissionMode = session.metadata?.permissionMode ?? null;
                const metadataPermissionModeUpdatedAt = session.metadata?.permissionModeUpdatedAt ?? null;

                let mergedPermissionMode =
                    existingPermissionMode ||
                    savedPermissionMode ||
                    session.permissionMode ||
                    'default';

                let mergedPermissionModeUpdatedAt =
                    existingPermissionModeUpdatedAt ??
                    savedPermissionModeUpdatedAt ??
                    null;

                if (metadataPermissionMode && typeof metadataPermissionModeUpdatedAt === 'number') {
                    const localUpdatedAt = mergedPermissionModeUpdatedAt ?? 0;
                    if (metadataPermissionModeUpdatedAt > localUpdatedAt) {
                        mergedPermissionMode = metadataPermissionMode;
                        mergedPermissionModeUpdatedAt = metadataPermissionModeUpdatedAt;
                    }
                }

                mergedSessions[session.id] = {
                    ...session,
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    optimisticThinkingAt: session.thinking === true ? null : existingOptimisticThinkingAt,
                    permissionMode: mergedPermissionMode,
                    // Preserve local coordination timestamp (not synced to server)
                    permissionModeUpdatedAt: mergedPermissionModeUpdatedAt,
                    modelMode: existingModelMode || savedModelMode || session.modelMode || 'default',
                };
            });

            // Build active set from all sessions (including existing ones)
            const activeSet = new Set<string>();
            Object.values(mergedSessions).forEach(session => {
                if (isSessionActive(session)) {
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

            // Sort both arrays by creation date for stable ordering
            activeSessions.sort((a, b) => b.createdAt - a.createdAt);
            inactiveSessions.sort((a, b) => b.createdAt - a.createdAt);

            // Build flat list data for FlashList
            const listData: (string | Session)[] = [];

            if (activeSessions.length > 0) {
                listData.push('online');
                listData.push(...activeSessions);
            }

            // Legacy sessionsData - to be removed
            // Machines are now integrated into sessionListViewData

            if (inactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...inactiveSessions);
            }

            // Process AgentState updates for sessions that already have messages loaded
            const updatedSessionMessages = { ...state.sessionMessages };

            sessions.forEach(session => {
                const oldSession = state.sessions[session.id];
                const newSession = mergedSessions[session.id];

                // Check if sessionMessages exists AND agentStateVersion is newer
                const existingSessionMessages = updatedSessionMessages[session.id];
                if (existingSessionMessages && newSession.agentState &&
                    (!oldSession || newSession.agentStateVersion > (oldSession.agentStateVersion || 0))) {

                    // Check for NEW permission requests before processing
                    const currentRealtimeSessionId = getCurrentRealtimeSessionId();
                    const voiceSession = getVoiceSession();

                    if (currentRealtimeSessionId === session.id && voiceSession) {
                        const oldRequests = oldSession?.agentState?.requests || {};
                        const newRequests = newSession.agentState?.requests || {};

                        // Find NEW permission requests only
                        for (const [requestId, request] of Object.entries(newRequests)) {
                            if (!oldRequests[requestId]) {
                                // This is a NEW permission request
                                const toolName = request.tool;
                                voiceSession.sendTextMessage(
                                    `Claude is requesting permission to use the ${toolName} tool`
                                );
                            }
                        }
                    }

                    // Process new AgentState through reducer
                    const reducerResult = reducer(existingSessionMessages.reducerState, [], newSession.agentState);
                    const processedMessages = reducerResult.messages;

                    // Always update the session messages, even if no new messages were created
                    // This ensures the reducer state is updated with the new AgentState
                    const mergedMessagesMap = { ...existingSessionMessages.messagesMap };
                    processedMessages.forEach(message => {
                        mergedMessagesMap[message.id] = message;
                    });

                    const messagesArray = Object.values(mergedMessagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);

                    updatedSessionMessages[session.id] = {
                        messages: messagesArray,
                        messagesMap: mergedMessagesMap,
                        reducerState: existingSessionMessages.reducerState, // The reducer modifies state in-place, so this has the updates
                        isLoaded: existingSessionMessages.isLoaded
                    };

                    // IMPORTANT: Copy latestUsage from reducerState to Session for immediate availability
                    if (existingSessionMessages.reducerState.latestUsage) {
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            latestUsage: { ...existingSessionMessages.reducerState.latestUsage }
                        };
                    }
                }
            });

            // Build new unified list view data
            const sessionListViewData = buildSessionListViewData(
                mergedSessions,
                state.machines,
                { groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject }
            );

            // Update project manager with current sessions and machines
            const machineMetadataMap = new Map<string, any>();
            Object.values(state.machines).forEach(machine => {
                if (machine.metadata) {
                    machineMetadataMap.set(machine.id, machine.metadata);
                }
            });
            projectManager.updateSessions(Object.values(mergedSessions), machineMetadataMap);

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData,  // Legacy - to be removed
                sessionListViewData,
                sessionMessages: updatedSessionMessages
            };
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsData: []
            };
            return result;
        }),
        applyReady: () => set((state) => ({
            ...state,
            isDataReady: true
        })),
        applyGitStatus: (sessionId: string, status: GitStatus | null) => set((state) => {
            // Update project git status as well
            projectManager.updateSessionProjectGitStatus(sessionId, status);

            return {
                ...state,
                sessionGitStatus: {
                    ...state.sessionGitStatus,
                    [sessionId]: status
                }
            };
        }),
        updateSessionDraft: (sessionId: string, draft: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Don't store empty strings, convert to null
            const normalizedDraft = draft?.trim() ? draft : null;

            // Collect all drafts for persistence
            const allDrafts: Record<string, string> = {};
            Object.entries(state.sessions).forEach(([id, sess]) => {
                if (id === sessionId) {
                    if (normalizedDraft) {
                        allDrafts[id] = normalizedDraft;
                    }
                } else if (sess.draft) {
                    allDrafts[id] = sess.draft;
                }
            });

            // Persist drafts
            saveSessionDrafts(allDrafts);

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    draft: normalizedDraft
                }
            };

            // Rebuild sessionListViewData to update the UI immediately
            const sessionListViewData = buildSessionListViewData(
                updatedSessions,
                state.machines,
                { groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject }
            );

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData
            };
        }),
        markSessionOptimisticThinking: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const nextSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    optimisticThinkingAt: Date.now(),
                },
            };
            const sessionListViewData = buildSessionListViewData(
                nextSessions,
                state.machines,
                { groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject }
            );

            const existingTimeout = optimisticThinkingTimeoutBySessionId.get(sessionId);
            if (existingTimeout) {
                clearTimeout(existingTimeout);
            }
            const timeout = setTimeout(() => {
                optimisticThinkingTimeoutBySessionId.delete(sessionId);
                set((s) => {
                    const current = s.sessions[sessionId];
                    if (!current) return s;
                    if (!current.optimisticThinkingAt) return s;

                    const next = {
                        ...s.sessions,
                        [sessionId]: {
                            ...current,
                            optimisticThinkingAt: null,
                        },
                    };
                    return {
                        ...s,
                        sessions: next,
                        sessionListViewData: buildSessionListViewData(
                            next,
                            s.machines,
                            { groupInactiveSessionsByProject: s.settings.groupInactiveSessionsByProject }
                        ),
                    };
                });
            }, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS);
            optimisticThinkingTimeoutBySessionId.set(sessionId, timeout);

            return {
                ...state,
                sessions: nextSessions,
                sessionListViewData,
            };
        }),
        clearSessionOptimisticThinking: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            if (!session.optimisticThinkingAt) return state;

            const existingTimeout = optimisticThinkingTimeoutBySessionId.get(sessionId);
            if (existingTimeout) {
                clearTimeout(existingTimeout);
                optimisticThinkingTimeoutBySessionId.delete(sessionId);
            }

            const nextSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    optimisticThinkingAt: null,
                },
            };

            return {
                ...state,
                sessions: nextSessions,
                sessionListViewData: buildSessionListViewData(
                    nextSessions,
                    state.machines,
                    { groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject }
                ),
            };
        }),
        markSessionViewed: (sessionId: string) => {
            const now = Date.now();
            sessionLastViewed[sessionId] = now;
            saveSessionLastViewed(sessionLastViewed);
            set((state) => ({
                ...state,
                sessionLastViewed: { ...sessionLastViewed }
            }));
        },
        updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const now = nowServerMs();

            // Update the session with the new permission mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    permissionMode: mode,
                    // Mark as locally updated so older message-based inference cannot override this selection.
                    // Newer user messages (from any device) will still take over.
                    permissionModeUpdatedAt: now
                }
            };

            const persisted = persistSessionPermissionData(updatedSessions);
            if (persisted) {
                sessionPermissionModes = persisted.modes;
                sessionPermissionModeUpdatedAts = persisted.updatedAts;
            }

            // No need to rebuild sessionListViewData since permission mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Update the session with the new model mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    modelMode: mode
                }
            };

            // Collect all model modes for persistence (only non-default values to save space)
            const allModes: Record<string, SessionModelMode> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.modelMode && sess.modelMode !== 'default') {
                    allModes[id] = sess.modelMode;
                }
            });

            saveSessionModelModes(allModes);

            // No need to rebuild sessionListViewData since model mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        // Project management methods
        getProjects: () => projectManager.getProjects(),
        getProject: (projectId: string) => projectManager.getProject(projectId),
        getProjectForSession: (sessionId: string) => projectManager.getProjectForSession(sessionId),
        getProjectSessions: (projectId: string) => projectManager.getProjectSessions(projectId),
        // Project git status methods
        getProjectGitStatus: (projectId: string) => projectManager.getProjectGitStatus(projectId),
        getSessionProjectGitStatus: (sessionId: string) => projectManager.getSessionProjectGitStatus(sessionId),
        updateSessionProjectGitStatus: (sessionId: string, status: GitStatus | null) => {
            projectManager.updateSessionProjectGitStatus(sessionId, status);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
        },
        deleteSession: (sessionId: string) => set((state) => {
	            const optimisticTimeout = optimisticThinkingTimeoutBySessionId.get(sessionId);
	            if (optimisticTimeout) {
	                clearTimeout(optimisticTimeout);
	                optimisticThinkingTimeoutBySessionId.delete(sessionId);
	            }

	            // Remove session from sessions
	            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;
            
            // Remove session messages if they exist
            const { [sessionId]: deletedMessages, ...remainingSessionMessages } = state.sessionMessages;
            
            // Remove session git status if it exists
            const { [sessionId]: deletedGitStatus, ...remainingGitStatus } = state.sessionGitStatus;
            
            // Clear drafts and permission modes from persistent storage
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);
            
            const modes = loadSessionPermissionModes();
            delete modes[sessionId];
            saveSessionPermissionModes(modes);
            sessionPermissionModes = modes;

            const updatedAts = loadSessionPermissionModeUpdatedAts();
            delete updatedAts[sessionId];
            saveSessionPermissionModeUpdatedAts(updatedAts);
            sessionPermissionModeUpdatedAts = updatedAts;

            const modelModes = loadSessionModelModes();
            delete modelModes[sessionId];
            saveSessionModelModes(modelModes);
            sessionModelModes = modelModes;

            delete sessionLastViewed[sessionId];
            saveSessionLastViewed(sessionLastViewed);
            
            // Rebuild sessionListViewData without the deleted session
            const sessionListViewData = buildSessionListViewData(
                remainingSessions,
                state.machines,
                { groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject }
            );
            
            return {
                ...state,
                sessions: remainingSessions,
                sessionMessages: remainingSessionMessages,
                sessionGitStatus: remainingGitStatus,
                sessionLastViewed: { ...sessionLastViewed },
                sessionListViewData
            };
        }),
    };
}
