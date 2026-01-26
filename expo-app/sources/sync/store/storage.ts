import { create } from "zustand";
import { Session, Machine, GitStatus, PendingMessage, DiscardedPendingMessage } from "../storageTypes";
import { createReducer, reducer, ReducerState } from "../reducer/reducer";
import { Message } from "../typesMessage";
import { NormalizedMessage } from "../typesRaw";
import { isMachineOnline } from '@/utils/machineUtils';
import { applySettings, Settings } from "../settings";
import { LocalSettings, applyLocalSettings } from "../localSettings";
import { Purchases, customerInfoToPurchases } from "../purchases";
import { TodoState } from "../../-zen/model/ops";
import { Profile } from "../profile";
import { UserProfile, RelationshipUpdatedEvent } from "../friendTypes";
import { PERMISSION_MODES } from '@/constants/PermissionModes';
import type { PermissionMode } from '@/sync/permissionTypes';
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadPurchases, savePurchases, loadProfile, saveProfile, loadSessionDrafts, saveSessionDrafts, loadSessionPermissionModes, saveSessionPermissionModes, loadSessionPermissionModeUpdatedAts, saveSessionPermissionModeUpdatedAts, loadSessionModelModes, saveSessionModelModes, loadSessionLastViewed, saveSessionLastViewed } from "../persistence";
import type { CustomerInfo } from '../revenueCat/types';
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import { isMutableTool } from "@/components/tools/knownTools";
import { projectManager } from "../projectManager";
import { DecryptedArtifact } from "../artifactTypes";
import { FeedItem } from "../feedTypes";
import { nowServerMs } from "../time";
import { buildSessionListViewData, type SessionListViewItem } from '../sessionListViewData';
import { createArtifactsDomain } from './domains/artifacts';
import { createFeedDomain } from './domains/feed';
import { createFriendsDomain } from './domains/friends';
import { createRealtimeDomain, type NativeUpdateStatus, type RealtimeMode, type RealtimeStatus, type SocketStatus, type SyncError } from './domains/realtime';

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

// Known entitlement IDs
export type KnownEntitlements = 'pro';

type SessionModelMode = NonNullable<Session['modelMode']>;

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
}

interface SessionPending {
    messages: PendingMessage[];
    discarded: DiscardedPendingMessage[];
    isLoaded: boolean;
}

// Machine type is now imported from storageTypes - represents persisted machine data

export type { SessionListViewItem } from '../sessionListViewData';

// Legacy type for backward compatibility - to be removed
export type SessionListItem = string | Session;

interface StorageState {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    profile: Profile;
    sessions: Record<string, Session>;
    sessionsData: SessionListItem[] | null;  // Legacy - to be removed
    sessionListViewData: SessionListViewItem[] | null;
    sessionMessages: Record<string, SessionMessages>;
    sessionPending: Record<string, SessionPending>;
    sessionGitStatus: Record<string, GitStatus | null>;
    machines: Record<string, Machine>;
    artifacts: Record<string, DecryptedArtifact>;  // New artifacts storage
    friends: Record<string, UserProfile>;  // All relationships (friends, pending, requested, etc.)
    users: Record<string, UserProfile | null>;  // Global user cache, null = 404/failed fetch
    feedItems: FeedItem[];  // Simple list of feed items
    feedHead: string | null;  // Newest cursor
    feedTail: string | null;  // Oldest cursor
    feedHasMore: boolean;
    feedLoaded: boolean;  // True after initial feed fetch
    friendsLoaded: boolean;  // True after initial friends fetch
    realtimeStatus: RealtimeStatus;
    realtimeMode: RealtimeMode;
    socketStatus: SocketStatus;
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    socketLastError: string | null;
    socketLastErrorAt: number | null;
    syncError: SyncError;
    lastSyncAt: number | null;
    isDataReady: boolean;
    nativeUpdateStatus: NativeUpdateStatus;
    todoState: TodoState | null;
    todosLoaded: boolean;
    sessionLastViewed: Record<string, number>;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[], hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    applyPendingLoaded: (sessionId: string) => void;
    applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => void;
    applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => void;
    upsertPendingMessage: (sessionId: string, message: PendingMessage) => void;
    removePendingMessage: (sessionId: string, pendingId: string) => void;
    applySettings: (settings: Settings, version: number) => void;
    replaceSettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    applyProfile: (profile: Profile) => void;
    applyTodos: (todoState: TodoState) => void;
    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    applyNativeUpdateStatus: (status: NativeUpdateStatus) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    setRealtimeStatus: (status: RealtimeStatus) => void;
    setRealtimeMode: (mode: RealtimeMode, immediate?: boolean) => void;
    clearRealtimeModeDebounce: () => void;
    setSocketStatus: (status: SocketStatus) => void;
    setSocketError: (message: string | null) => void;
    setSyncError: (error: StorageState['syncError']) => void;
    clearSyncError: () => void;
    setLastSyncAt: (ts: number) => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionViewed: (sessionId: string) => void;
    updateSessionPermissionMode: (sessionId: string, mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo') => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => void;
    // Artifact methods
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
    deleteSession: (sessionId: string) => void;
    // Project management methods
    getProjects: () => import('../projectManager').Project[];
    getProject: (projectId: string) => import('../projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('../projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];
    // Project git status methods
    getProjectGitStatus: (projectId: string) => import('../storageTypes').GitStatus | null;
    getSessionProjectGitStatus: (sessionId: string) => import('../storageTypes').GitStatus | null;
    updateSessionProjectGitStatus: (sessionId: string, status: import('../storageTypes').GitStatus | null) => void;
    // Friend management methods
    applyFriends: (friends: UserProfile[]) => void;
    applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => void;
    getFriend: (userId: string) => UserProfile | undefined;
    getAcceptedFriends: () => UserProfile[];
    // User cache methods
    applyUsers: (users: Record<string, UserProfile | null>) => void;
    getUser: (userId: string) => UserProfile | null | undefined;
    assumeUsers: (userIds: string[]) => Promise<void>;
    // Feed methods
    applyFeedItems: (items: FeedItem[]) => void;
    clearFeed: () => void;
}

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let purchases = loadPurchases();
    let profile = loadProfile();
    let sessionDrafts = loadSessionDrafts();
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    let sessionPermissionModeUpdatedAts = loadSessionPermissionModeUpdatedAts();
    let sessionLastViewed = loadSessionLastViewed();

    const persistSessionPermissionData = (sessions: Record<string, Session>) => {
        const allModes: Record<string, PermissionMode> = {};
        const allUpdatedAts: Record<string, number> = {};

        Object.entries(sessions).forEach(([id, sess]) => {
            if (sess.permissionMode && sess.permissionMode !== 'default') {
                allModes[id] = sess.permissionMode;
            }
            if (typeof sess.permissionModeUpdatedAt === 'number') {
                allUpdatedAts[id] = sess.permissionModeUpdatedAt;
            }
        });

        try {
            saveSessionPermissionModes(allModes);
            saveSessionPermissionModeUpdatedAts(allUpdatedAts);
            sessionPermissionModes = allModes;
            sessionPermissionModeUpdatedAts = allUpdatedAts;
        } catch (e) {
            console.error('Failed to persist session permission data:', e);
        }
    };

    const realtimeDomain = createRealtimeDomain<StorageState>({ set, get });
    const artifactsDomain = createArtifactsDomain<StorageState>({ set, get });
    const friendsDomain = createFriendsDomain<StorageState>({ set, get });
    const feedDomain = createFeedDomain<StorageState>({ set, get });

    return {
        settings,
        settingsVersion: version,
        localSettings,
        purchases,
        profile,
        sessions: {},
        machines: {},
        ...artifactsDomain,
        ...friendsDomain,
        ...feedDomain,
        todoState: null,  // Initialize todo state
        todosLoaded: false,  // Initialize todos loaded state
        sessionLastViewed,
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionMessages: {},
        sessionPending: {},
        sessionGitStatus: {},
        ...realtimeDomain,
        isDataReady: false,
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
            const listData: SessionListItem[] = [];

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
            let result: StorageState;

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

                result = {
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
            } else {
                result = {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            isLoaded: true
                        } satisfies SessionMessages
                    }
                };
            }

            return result;
        }),
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
        applySettingsLocal: (delta: Partial<Settings>) => set((state) => {
            const newSettings = applySettings(state.settings, delta);
            saveSettings(newSettings, state.settingsVersion ?? 0);

            const shouldRebuildSessionListViewData =
                Object.prototype.hasOwnProperty.call(delta, 'groupInactiveSessionsByProject') &&
                delta.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject;

            if (shouldRebuildSessionListViewData) {
                const sessionListViewData = buildSessionListViewData(
                    state.sessions,
                    state.machines,
                    { groupInactiveSessionsByProject: newSettings.groupInactiveSessionsByProject }
                );
                return {
                    ...state,
                    settings: newSettings,
                    sessionListViewData
                };
            }
            return {
                ...state,
                settings: newSettings
            };
        }),
        applySettings: (settings: Settings, version: number) => set((state) => {
            if (state.settingsVersion == null || state.settingsVersion < version) {
                saveSettings(settings, version);

                const shouldRebuildSessionListViewData =
                    settings.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject;

                const sessionListViewData = shouldRebuildSessionListViewData
                    ? buildSessionListViewData(state.sessions, state.machines, { groupInactiveSessionsByProject: settings.groupInactiveSessionsByProject })
                    : state.sessionListViewData;

                return {
                    ...state,
                    settings,
                    settingsVersion: version,
                    sessionListViewData
                };
            } else {
                return state;
            }
        }),
        replaceSettings: (settings: Settings, version: number) => set((state) => {
            saveSettings(settings, version);

            const shouldRebuildSessionListViewData =
                settings.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject;

            const sessionListViewData = shouldRebuildSessionListViewData
                ? buildSessionListViewData(state.sessions, state.machines, { groupInactiveSessionsByProject: settings.groupInactiveSessionsByProject })
                : state.sessionListViewData;

            return {
                ...state,
                settings,
                settingsVersion: version,
                sessionListViewData
            };
        }),
        applyLocalSettings: (delta: Partial<LocalSettings>) => set((state) => {
            const updatedLocalSettings = applyLocalSettings(state.localSettings, delta);
            saveLocalSettings(updatedLocalSettings);
            return {
                ...state,
                localSettings: updatedLocalSettings
            };
        }),
        applyPurchases: (customerInfo: CustomerInfo) => set((state) => {
            // Transform CustomerInfo to our Purchases format
            const purchases = customerInfoToPurchases(customerInfo);

            // Always save and update - no need for version checks
            savePurchases(purchases);
            return {
                ...state,
                purchases
            };
        }),
        applyProfile: (profile: Profile) => set((state) => {
            // Always save and update profile
            saveProfile(profile);
            return {
                ...state,
                profile
            };
        }),
        applyTodos: (todoState: TodoState) => set((state) => {
            return {
                ...state,
                todoState,
                todosLoaded: true
            };
        }),
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

            persistSessionPermissionData(updatedSessions);

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
        applyMachines: (machines: Machine[], replace: boolean = false) => set((state) => {
            // Either replace all machines or merge updates
            let mergedMachines: Record<string, Machine>;

            if (replace) {
                // Replace entire machine state (used by fetchMachines)
                mergedMachines = {};
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            } else {
                // Merge individual updates (used by update-machine)
                mergedMachines = { ...state.machines };
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            }

            // Rebuild sessionListViewData to reflect machine changes
            const sessionListViewData = buildSessionListViewData(
                state.sessions,
                mergedMachines,
                { groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject }
            );

            return {
                ...state,
                machines: mergedMachines,
                sessionListViewData
            };
        }),
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
    }
});
