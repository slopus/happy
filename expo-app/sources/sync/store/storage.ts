import { create } from "zustand";
import { Session, Machine, GitStatus, PendingMessage, DiscardedPendingMessage } from "../storageTypes";
import { createReducer, reducer, ReducerState } from "../reducer/reducer";
import { Message } from "../typesMessage";
import { NormalizedMessage } from "../typesRaw";
import { isMachineOnline } from '@/utils/machineUtils';
import type { Settings } from "../settings";
import type { LocalSettings } from "../localSettings";
import type { Purchases } from "../purchases";
import { TodoState } from "../../-zen/model/ops";
import type { Profile } from "../profile";
import { UserProfile, RelationshipUpdatedEvent } from "../friendTypes";
import { PERMISSION_MODES } from '@/constants/PermissionModes';
import type { PermissionMode } from '@/sync/permissionTypes';
import { loadSessionDrafts, saveSessionDrafts, loadSessionPermissionModes, saveSessionPermissionModes, loadSessionPermissionModeUpdatedAts, saveSessionPermissionModeUpdatedAts, loadSessionModelModes, saveSessionModelModes, loadSessionLastViewed, saveSessionLastViewed } from "../persistence";
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
import { createMachinesDomain } from './domains/machines';
import { createProfileDomain } from './domains/profile';
import { createRealtimeDomain, type NativeUpdateStatus, type RealtimeMode, type RealtimeStatus, type SocketStatus, type SyncError } from './domains/realtime';
import { createSettingsDomain } from './domains/settings';
import { createTodosDomain } from './domains/todos';
import { createSessionsDomain, persistSessionPermissionData } from './domains/sessions';

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
    const settingsDomain = createSettingsDomain<StorageState>({ set, get });
    const profileDomain = createProfileDomain<StorageState>({ set, get });
    const todosDomain = createTodosDomain<StorageState>({ set, get });
    const machinesDomain = createMachinesDomain<StorageState>({ set, get });
    const sessionsDomain = createSessionsDomain<StorageState>({ set, get });
    const realtimeDomain = createRealtimeDomain<StorageState>({ set, get });
    const artifactsDomain = createArtifactsDomain<StorageState>({ set, get });
    const friendsDomain = createFriendsDomain<StorageState>({ set, get });
    const feedDomain = createFeedDomain<StorageState>({ set, get });

    return {
        ...settingsDomain,
        ...profileDomain,
        ...sessionsDomain,
        ...machinesDomain,
        ...artifactsDomain,
        ...friendsDomain,
        ...feedDomain,
        ...todosDomain,
        sessionMessages: {},
        sessionPending: {},
        ...realtimeDomain,
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
    }
});
