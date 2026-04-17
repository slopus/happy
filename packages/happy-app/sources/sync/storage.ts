import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import equal from 'fast-deep-equal'

function useDeepEqual<T>(selector: (state: StorageState) => T): (state: StorageState) => T {
    const prev = React.useRef<T>(undefined);
    return (state: StorageState) => {
        const next = selector(state);
        return equal(prev.current, next) ? prev.current! : (prev.current = next);
    };
}
import { Session, Machine, GitStatus } from "./storageTypes";
import type { GitStatusFiles } from "./gitStatusFiles";
import { createReducer, reducer, ReducerState } from "./reducer/reducer";
import { Message } from "./typesMessage";
import { NormalizedMessage } from "./typesRaw";
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionName, getSessionSubtitle, getSessionAvatarId, type SessionState } from '@/utils/sessionUtils';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Purchases, customerInfoToPurchases } from "./purchases";
import { Profile } from "./profile";
import { UserProfile, RelationshipUpdatedEvent } from "./friendTypes";
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadPurchases, savePurchases, loadProfile, saveProfile, loadSessionDrafts, saveSessionDrafts, loadSessionPermissionModes, saveSessionPermissionModes, loadSessionModelModes, saveSessionModelModes, loadSessionEffortLevels, saveSessionEffortLevels, loadStarredSessions, saveStarredSessions } from "./persistence";
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import type { CustomerInfo } from './revenueCat/types';
import React from "react";
import { sync } from "./sync";
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import { isMutableTool } from "@/components/tools/knownTools";
import { projectManager } from "./projectManager";
import { DecryptedArtifact } from "./artifactTypes";
import { FeedItem } from "./feedTypes";

// Debounce timer for realtimeMode changes
let realtimeModeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REALTIME_MODE_DEBOUNCE_MS = 150;

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

function isSandboxEnabled(metadata: Session['metadata'] | null | undefined): boolean {
    const sandbox = metadata?.sandbox;
    return !!sandbox && typeof sandbox === 'object' && (sandbox as { enabled?: unknown }).enabled === true;
}

// Known entitlement IDs
export type KnownEntitlements = 'pro';

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
}

// Machine type is now imported from storageTypes - represents persisted machine data

// Display-only row data — all primitives, cheap to deep-equal
export interface SessionRowData {
    id: string;
    name: string;
    subtitle: string;
    avatarId: string;
    flavor: string | null;
    state: SessionState;
    // Only present on inactive sessions — active sessions never show "last seen"
    // and activeAt updates on every heartbeat, causing needless deep-equal diffs
    activeAt?: number;
    createdAt?: number;
    hasDraft: boolean;
    starred: boolean;
    active: boolean;
    machineId: string | null;
    path: string | null;
    homeDir: string | null;
    completedTodosCount: number;
    totalTodosCount: number;
}

function buildSessionRowData(session: Session): SessionRowData {
    const isOnline = session.presence === "online";
    const hasPermissions = !!(session.agentState?.requests && Object.keys(session.agentState.requests).length > 0);

    let state: SessionState;
    if (!isOnline) {
        state = 'disconnected';
    } else if (hasPermissions) {
        state = 'permission_required';
    } else if (session.thinking) {
        state = 'thinking';
    } else {
        state = 'waiting';
    }

    return {
        id: session.id,
        name: getSessionName(session),
        subtitle: getSessionSubtitle(session),
        avatarId: getSessionAvatarId(session),
        flavor: session.metadata?.flavor ?? null,
        state,
        ...(!session.active && { activeAt: session.activeAt, createdAt: session.createdAt }),
        hasDraft: !!session.draft,
        starred: !!session.starred,
        active: session.active,
        machineId: session.metadata?.machineId ?? null,
        path: session.metadata?.path ?? null,
        homeDir: session.metadata?.homeDir ?? null,
        completedTodosCount: session.todos?.filter(todo => todo.status === 'completed').length ?? 0,
        totalTodosCount: session.todos?.length ?? 0,
    };
}

// Unified list item type for SessionsList component
export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: SessionRowData[] }
    | { type: 'archive-toggle'; hidden: boolean }
    | { type: 'project-group'; displayPath: string; machine: Machine }
    | { type: 'session'; session: SessionRowData };

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
    sessionGitStatus: Record<string, GitStatus | null>;
    sessionGitStatusFiles: Record<string, GitStatusFiles | null>;
    sessionFileCache: Record<string, Record<string, { content: string | null; diff: string | null; isBinary: boolean; cachedAt: number }>>;
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
    realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    realtimeMode: 'idle' | 'agent-speaking' | 'user-speaking';
    voiceSessionGeneration: number;
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    isDataReady: boolean;
    nativeUpdateStatus: { available: boolean; updateUrl?: string } | null;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    deleteMachine: (machineId: string) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[], hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    applyProfile: (profile: Profile) => void;
    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    applyGitStatusFiles: (sessionId: string, files: GitStatusFiles | null) => void;
    applyFileCache: (sessionId: string, filePath: string, content: string | null, diff: string | null, isBinary: boolean) => void;
    applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setRealtimeMode: (mode: 'idle' | 'agent-speaking' | 'user-speaking', immediate?: boolean) => void;
    clearRealtimeModeDebounce: () => void;
    incrementVoiceSessionGeneration: () => void;
    setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    updateSessionPermissionMode: (sessionId: string, mode: string) => void;
    updateSessionModelMode: (sessionId: string, mode: string) => void;
    updateSessionEffortLevel: (sessionId: string, level: string) => void;
    toggleSessionStarred: (sessionId: string) => void;
    // Artifact methods
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
    deleteSession: (sessionId: string) => void;
    // Project management methods
    getProjects: () => import('./projectManager').Project[];
    getProject: (projectId: string) => import('./projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('./projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];
    // Project git status methods
    getProjectGitStatus: (projectId: string) => import('./storageTypes').GitStatus | null;
    getSessionProjectGitStatus: (sessionId: string) => import('./storageTypes').GitStatus | null;
    updateSessionProjectGitStatus: (sessionId: string, status: import('./storageTypes').GitStatus | null) => void;
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

// Helper function to build unified list view data from sessions and machines
function buildSessionListViewData(
    sessions: Record<string, Session>
): SessionListViewItem[] {
    // Partition: starred sessions go to a dedicated "Starred" section regardless
    // of active/inactive status so users can find pinned conversations in one place.
    const starredSessions: Session[] = [];
    const activeSessions: Session[] = [];
    const unstarredInactive: Session[] = [];

    Object.values(sessions).forEach(session => {
        if (session.starred) {
            starredSessions.push(session);
        } else if (isSessionActive(session)) {
            activeSessions.push(session);
        } else {
            unstarredInactive.push(session);
        }
    });

    // Sort each bucket by creation date (newest first)
    starredSessions.sort((a, b) => b.createdAt - a.createdAt);
    activeSessions.sort((a, b) => b.createdAt - a.createdAt);
    unstarredInactive.sort((a, b) => b.createdAt - a.createdAt);

    // Build unified list view data
    const listData: SessionListViewItem[] = [];

    // Starred section at the very top
    if (starredSessions.length > 0) {
        listData.push({ type: 'header', title: 'Starred' });
        starredSessions.forEach(sess => {
            listData.push({ type: 'session', session: buildSessionRowData(sess) });
        });
    }

    // Add remaining active sessions as a single item (if any)
    if (activeSessions.length > 0) {
        listData.push({ type: 'active-sessions', sessions: activeSessions.map(buildSessionRowData) });
    }

    // Group remaining inactive sessions by date
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: Session[] = [];
    let currentDateString: string | null = null;

    for (const session of unstarredInactive) {
        const sessionDate = new Date(session.createdAt);
        const dateString = sessionDate.toDateString();

        if (currentDateString !== dateString) {
            // Process previous group
            if (currentDateGroup.length > 0 && currentDateString) {
                const groupDate = new Date(currentDateString);
                const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

                let headerTitle: string;
                if (sessionDateOnly.getTime() === today.getTime()) {
                    headerTitle = 'Today';
                } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
                    headerTitle = 'Yesterday';
                } else {
                    const diffTime = today.getTime() - sessionDateOnly.getTime();
                    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                    headerTitle = `${diffDays} days ago`;
                }

                listData.push({ type: 'header', title: headerTitle });
                currentDateGroup.forEach(sess => {
                    listData.push({ type: 'session', session: buildSessionRowData(sess) });
                });
            }

            // Start new group
            currentDateString = dateString;
            currentDateGroup = [session];
        } else {
            currentDateGroup.push(session);
        }
    }

    // Process final group
    if (currentDateGroup.length > 0 && currentDateString) {
        const groupDate = new Date(currentDateString);
        const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

        let headerTitle: string;
        if (sessionDateOnly.getTime() === today.getTime()) {
            headerTitle = 'Today';
        } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
            headerTitle = 'Yesterday';
        } else {
            const diffTime = today.getTime() - sessionDateOnly.getTime();
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            headerTitle = `${diffDays} days ago`;
        }

        listData.push({ type: 'header', title: headerTitle });
        currentDateGroup.forEach(sess => {
            listData.push({ type: 'session', session: buildSessionRowData(sess) });
        });
    }

    return listData;
}

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let purchases = loadPurchases();
    let profile = loadProfile();
    let sessionDrafts = loadSessionDrafts();
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    let sessionEffortLevels = loadSessionEffortLevels();
    let starredSessions = loadStarredSessions();
    return {
        settings,
        settingsVersion: version,
        localSettings,
        purchases,
        profile,
        sessions: {},
        machines: {},
        artifacts: {},  // Initialize artifacts
        friends: {},  // Initialize relationships cache
        users: {},  // Initialize global user cache
        feedItems: [],  // Initialize feed items list
        feedHead: null,
        feedTail: null,
        feedHasMore: false,
        feedLoaded: false,  // Initialize as false
        friendsLoaded: false,  // Initialize as false
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionMessages: {},
        sessionGitStatus: {},
        sessionGitStatusFiles: {},
        sessionFileCache: {},
        realtimeStatus: 'disconnected',
        realtimeMode: 'idle',
        voiceSessionGeneration: 0,
        socketStatus: 'disconnected',
        socketLastConnectedAt: null,
        socketLastDisconnectedAt: null,
        isDataReady: false,
        nativeUpdateStatus: null,
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
            // Load drafts, permission modes, model/effort modes, and starred state if sessions are empty (initial load)
            const isInitialLoad = Object.keys(state.sessions).length === 0;
            const savedDrafts = isInitialLoad ? sessionDrafts : {};
            const savedPermissionModes = isInitialLoad ? sessionPermissionModes : {};
            const savedModelModes = isInitialLoad ? sessionModelModes : {};
            const savedEffortLevels = isInitialLoad ? sessionEffortLevels : {};

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
                const defaultPermissionMode: PermissionModeKey = isSandboxEnabled(session.metadata) ? 'bypassPermissions' : 'default';
                const resolvedPermissionMode: PermissionModeKey =
                    (existingPermissionMode && existingPermissionMode !== 'default' ? existingPermissionMode : undefined) ||
                    (savedPermissionMode && savedPermissionMode !== 'default' ? savedPermissionMode : undefined) ||
                    (session.permissionMode && session.permissionMode !== 'default' ? session.permissionMode : undefined) ||
                    defaultPermissionMode;

                // Restore model mode / effort level from MMKV on first load — server
                // does not sync these, and they used to reset on every app restart (#1028).
                const existingModelMode = state.sessions[session.id]?.modelMode;
                const resolvedModelMode = existingModelMode ?? savedModelModes[session.id] ?? session.modelMode ?? null;
                const existingEffortLevel = state.sessions[session.id]?.effortLevel;
                const resolvedEffortLevel = existingEffortLevel ?? savedEffortLevels[session.id] ?? session.effortLevel ?? null;
                const existingStarred = state.sessions[session.id]?.starred;

                mergedSessions[session.id] = {
                    ...session,
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    permissionMode: resolvedPermissionMode,
                    modelMode: resolvedModelMode,
                    effortLevel: resolvedEffortLevel,
                    starred: existingStarred ?? starredSessions.has(session.id),
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

            // console.log(`📊 Storage: applySessions called with ${sessions.length} sessions, active: ${activeSessions.length}, inactive: ${inactiveSessions.length}`);

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

                    // console.log('[REALTIME DEBUG] Permission check:', {
                    //     currentRealtimeSessionId,
                    //     sessionId: session.id,
                    //     match: currentRealtimeSessionId === session.id,
                    //     hasVoiceSession: !!voiceSession,
                    //     oldRequests: Object.keys(oldSession?.agentState?.requests || {}),
                    //     newRequests: Object.keys(newSession.agentState?.requests || {})
                    // });

                    if (currentRealtimeSessionId === session.id && voiceSession) {
                        const oldRequests = oldSession?.agentState?.requests || {};
                        const newRequests = newSession.agentState?.requests || {};

                        // Find NEW permission requests only
                        for (const [requestId, request] of Object.entries(newRequests)) {
                            if (!oldRequests[requestId]) {
                                // This is a NEW permission request
                                const toolName = request.tool;
                                // console.log('[REALTIME DEBUG] Sending permission notification for:', toolName);
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
                mergedSessions
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

            // Track plan mode transitions through the batch in order.
            // Set true on EnterPlanMode, false on ExitPlanMode. The final value
            // tells us whether the batch ends with an unresolved plan entry.
            // This prevents history replays (which contain both Enter + Exit) from
            // re-triggering plan mode, while still catching real-time EnterPlanMode.
            let shouldEnterPlanMode = false;
            for (const msg of messages) {
                if (msg.role === 'agent') {
                    for (const c of msg.content) {
                        if (c.type === 'tool-call') {
                            if (c.name === 'EnterPlanMode' || c.name === 'enter_plan_mode') {
                                shouldEnterPlanMode = true;
                            } else if (c.name === 'ExitPlanMode' || c.name === 'exit_plan_mode') {
                                shouldEnterPlanMode = false;
                            }
                        }
                    }
                }
            }

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

                // Update session with todos and latestUsage
                // IMPORTANT: We extract latestUsage from the mutable reducerState and copy it to the Session object
                // This ensures latestUsage is available immediately on load, even before messages are fully loaded
                let updatedSessions = state.sessions;
                const needsUpdate = (reducerResult.todos !== undefined || existingSession.reducerState.latestUsage || shouldEnterPlanMode) && session;

                if (needsUpdate) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            ...(reducerResult.todos !== undefined && { todos: reducerResult.todos }),
                            // Copy latestUsage from reducerState to make it immediately available
                            latestUsage: existingSession.reducerState.latestUsage ? {
                                ...existingSession.reducerState.latestUsage
                            } : session.latestUsage,
                            // Auto-switch to plan mode when EnterPlanMode tool call is detected
                            ...(shouldEnterPlanMode && { permissionMode: 'plan' })
                        }
                    };
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
                    }
                };
            });

            // Persist plan mode change
            if (shouldEnterPlanMode) {
                const allModes: Record<string, string> = {};
                const currentState = get();
                Object.entries(currentState.sessions).forEach(([id, sess]) => {
                    if (sess.permissionMode && sess.permissionMode !== 'default') {
                        allModes[id] = sess.permissionMode;
                    }
                });
                saveSessionPermissionModes(allModes);
            }

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
        applySettingsLocal: (settings: Partial<Settings>) => set((state) => {
            saveSettings(applySettings(state.settings, settings), state.settingsVersion ?? 0);
            return {
                ...state,
                settings: applySettings(state.settings, settings)
            };
        }),
        applySettings: (settings: Settings, version: number) => set((state) => {
            if (state.settingsVersion === null || state.settingsVersion < version) {
                saveSettings(settings, version);
                return {
                    ...state,
                    settings,
                    settingsVersion: version
                };
            } else {
                return state;
            }
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
        applyGitStatusFiles: (sessionId: string, files: GitStatusFiles | null) => set((state) => ({
            ...state,
            sessionGitStatusFiles: {
                ...state.sessionGitStatusFiles,
                [sessionId]: files
            }
        })),
        applyFileCache: (sessionId: string, filePath: string, content: string | null, diff: string | null, isBinary: boolean) => set((state) => ({
            ...state,
            sessionFileCache: {
                ...state.sessionFileCache,
                [sessionId]: {
                    ...(state.sessionFileCache[sessionId] || {}),
                    [filePath]: { content, diff, isBinary, cachedAt: Date.now() }
                }
            }
        })),
        applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => set((state) => ({
            ...state,
            nativeUpdateStatus: status
        })),
        setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => ({
            ...state,
            realtimeStatus: status
        })),
        setRealtimeMode: (mode: 'idle' | 'agent-speaking' | 'user-speaking', immediate?: boolean) => {
            if (immediate) {
                // Clear any pending debounce and set immediately
                if (realtimeModeDebounceTimer) {
                    clearTimeout(realtimeModeDebounceTimer);
                    realtimeModeDebounceTimer = null;
                }
                set((state) => ({ ...state, realtimeMode: mode }));
            } else {
                // Debounce mode changes to avoid flickering
                if (realtimeModeDebounceTimer) {
                    clearTimeout(realtimeModeDebounceTimer);
                }
                realtimeModeDebounceTimer = setTimeout(() => {
                    realtimeModeDebounceTimer = null;
                    set((state) => ({ ...state, realtimeMode: mode }));
                }, REALTIME_MODE_DEBOUNCE_MS);
            }
        },
        clearRealtimeModeDebounce: () => {
            if (realtimeModeDebounceTimer) {
                clearTimeout(realtimeModeDebounceTimer);
                realtimeModeDebounceTimer = null;
            }
        },
        incrementVoiceSessionGeneration: () => set((state) => ({
            ...state,
            voiceSessionGeneration: state.voiceSessionGeneration + 1
        })),
        setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => {
            const now = Date.now();
            const updates: Partial<StorageState> = {
                socketStatus: status
            };

            // Update timestamp based on status
            if (status === 'connected') {
                updates.socketLastConnectedAt = now;
            } else if (status === 'disconnected' || status === 'error') {
                updates.socketLastDisconnectedAt = now;
            }

            return {
                ...state,
                ...updates
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

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData: buildSessionListViewData(updatedSessions)
            };
        }),
        updateSessionPermissionMode: (sessionId: string, mode: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Update the session with the new permission mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    permissionMode: mode
                }
            };

            // Collect all permission modes for persistence
            const allModes: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.permissionMode && sess.permissionMode !== 'default') {
                    allModes[id] = sess.permissionMode;
                }
            });

            // Persist permission modes (only non-default values to save space)
            saveSessionPermissionModes(allModes);

            // No need to rebuild sessionListViewData since permission mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        updateSessionModelMode: (sessionId: string, mode: string) => set((state) => {
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

            // Persist model modes so the selection survives app restart (#1028).
            // Only non-default values are kept — matches the permissionMode pattern above.
            const allModes: Record<string, string> = {};
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
        updateSessionEffortLevel: (sessionId: string, level: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    effortLevel: level
                }
            };

            // Persist effort levels so the selection survives app restart (#1028).
            const allLevels: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.effortLevel) {
                    allLevels[id] = sess.effortLevel;
                }
            });
            saveSessionEffortLevels(allLevels);

            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        toggleSessionStarred: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const newStarred = !session.starred;

            // Persist starred set
            newStarred ? starredSessions.add(sessionId) : starredSessions.delete(sessionId);
            saveStarredSessions(starredSessions);

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    starred: newStarred,
                }
            };

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData: buildSessionListViewData(updatedSessions),
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
                state.sessions
            );

            return {
                ...state,
                machines: mergedMachines,
                sessionListViewData
            };
        }),
        deleteMachine: (machineId: string) => set((state) => {
            if (!state.machines[machineId]) {
                return state;
            }
            const { [machineId]: _removed, ...remaining } = state.machines;
            return {
                ...state,
                machines: remaining,
                sessionListViewData: buildSessionListViewData(state.sessions)
            };
        }),
        // Artifact methods
        applyArtifacts: (artifacts: DecryptedArtifact[]) => set((state) => {
            console.log(`🗂️ Storage.applyArtifacts: Applying ${artifacts.length} artifacts`);
            const mergedArtifacts = { ...state.artifacts };
            artifacts.forEach(artifact => {
                mergedArtifacts[artifact.id] = artifact;
            });
            console.log(`🗂️ Storage.applyArtifacts: Total artifacts after merge: ${Object.keys(mergedArtifacts).length}`);
            
            return {
                ...state,
                artifacts: mergedArtifacts
            };
        }),
        addArtifact: (artifact: DecryptedArtifact) => set((state) => {
            const updatedArtifacts = {
                ...state.artifacts,
                [artifact.id]: artifact
            };
            
            return {
                ...state,
                artifacts: updatedArtifacts
            };
        }),
        updateArtifact: (artifact: DecryptedArtifact) => set((state) => {
            const updatedArtifacts = {
                ...state.artifacts,
                [artifact.id]: artifact
            };
            
            return {
                ...state,
                artifacts: updatedArtifacts
            };
        }),
        deleteArtifact: (artifactId: string) => set((state) => {
            const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;
            
            return {
                ...state,
                artifacts: remainingArtifacts
            };
        }),
        deleteSession: (sessionId: string) => set((state) => {
            // Remove session from sessions
            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;
            
            // Remove session messages if they exist
            const { [sessionId]: deletedMessages, ...remainingSessionMessages } = state.sessionMessages;
            
            // Remove session git status if it exists
            const { [sessionId]: deletedGitStatus, ...remainingGitStatus } = state.sessionGitStatus;
            const { [sessionId]: _gitStatusFiles, ...remainingGitStatusFiles } = state.sessionGitStatusFiles;
            const { [sessionId]: _fileCache, ...remainingFileCache } = state.sessionFileCache;

            // Clear drafts, permission modes, model modes, effort levels from persistent storage
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);

            const modes = loadSessionPermissionModes();
            delete modes[sessionId];
            saveSessionPermissionModes(modes);

            const modelModes = loadSessionModelModes();
            delete modelModes[sessionId];
            saveSessionModelModes(modelModes);

            const effortLevels = loadSessionEffortLevels();
            delete effortLevels[sessionId];
            saveSessionEffortLevels(effortLevels);
            
            // Rebuild sessionListViewData without the deleted session
            const sessionListViewData = buildSessionListViewData(remainingSessions);
            
            return {
                ...state,
                sessions: remainingSessions,
                sessionMessages: remainingSessionMessages,
                sessionGitStatus: remainingGitStatus,
                sessionGitStatusFiles: remainingGitStatusFiles,
                sessionFileCache: remainingFileCache,
                sessionListViewData
            };
        }),
        // Friend management methods
        applyFriends: (friends: UserProfile[]) => set((state) => {
            const mergedFriends = { ...state.friends };
            friends.forEach(friend => {
                mergedFriends[friend.id] = friend;
            });
            return {
                ...state,
                friends: mergedFriends,
                friendsLoaded: true  // Mark as loaded after first fetch
            };
        }),
        applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => set((state) => {
            const { fromUserId, toUserId, status, action, fromUser, toUser } = event;
            const currentUserId = state.profile.id;
            
            // Update friends cache
            const updatedFriends = { ...state.friends };
            
            // Determine which user profile to update based on perspective
            const otherUserId = fromUserId === currentUserId ? toUserId : fromUserId;
            const otherUser = fromUserId === currentUserId ? toUser : fromUser;
            
            if (action === 'deleted' || status === 'none') {
                // Remove from friends if deleted or status is none
                delete updatedFriends[otherUserId];
            } else if (otherUser) {
                // Update or add the user profile with current status
                updatedFriends[otherUserId] = otherUser;
            }
            
            return {
                ...state,
                friends: updatedFriends
            };
        }),
        getFriend: (userId: string) => {
            return get().friends[userId];
        },
        getAcceptedFriends: () => {
            const friends = get().friends;
            return Object.values(friends).filter(friend => friend.status === 'friend');
        },
        // User cache methods
        applyUsers: (users: Record<string, UserProfile | null>) => set((state) => ({
            ...state,
            users: { ...state.users, ...users }
        })),
        getUser: (userId: string) => {
            return get().users[userId];  // Returns UserProfile | null | undefined
        },
        assumeUsers: async (userIds: string[]) => {
            // This will be implemented in sync.ts as it needs access to credentials
            // Just a placeholder here for the interface
            const { sync } = await import('./sync');
            return sync.assumeUsers(userIds);
        },
        // Feed methods
        applyFeedItems: (items: FeedItem[]) => set((state) => {
            // Always mark feed as loaded even if empty
            if (items.length === 0) {
                return {
                    ...state,
                    feedLoaded: true  // Mark as loaded even when empty
                };
            }

            // Create a map of existing items for quick lookup
            const existingMap = new Map<string, FeedItem>();
            state.feedItems.forEach(item => {
                existingMap.set(item.id, item);
            });

            // Process new items
            const updatedItems = [...state.feedItems];
            let head = state.feedHead;
            let tail = state.feedTail;

            items.forEach(newItem => {
                // Remove items with same repeatKey if it exists
                if (newItem.repeatKey) {
                    const indexToRemove = updatedItems.findIndex(item =>
                        item.repeatKey === newItem.repeatKey
                    );
                    if (indexToRemove !== -1) {
                        updatedItems.splice(indexToRemove, 1);
                    }
                }

                // Add new item if it doesn't exist
                if (!existingMap.has(newItem.id)) {
                    updatedItems.push(newItem);
                }

                // Update head/tail cursors
                if (!head || newItem.counter > parseInt(head.substring(2), 10)) {
                    head = newItem.cursor;
                }
                if (!tail || newItem.counter < parseInt(tail.substring(2), 10)) {
                    tail = newItem.cursor;
                }
            });

            // Sort by counter (desc - newest first)
            updatedItems.sort((a, b) => b.counter - a.counter);

            return {
                ...state,
                feedItems: updatedItems,
                feedHead: head,
                feedTail: tail,
                feedLoaded: true  // Mark as loaded after first fetch
            };
        }),
        clearFeed: () => set((state) => ({
            ...state,
            feedItems: [],
            feedHead: null,
            feedTail: null,
            feedHasMore: false,
            feedLoaded: false,  // Reset loading flag
            friendsLoaded: false  // Reset loading flag
        })),
    }
});

export function useSessions() {
    return storage(useShallow((state) => state.isDataReady ? state.sessionsData : null));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: unknown[] = [];

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

export function useSessionUsage(sessionId: string) {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.reducerState?.latestUsage ?? null;
    }));
}

export function useSettings(): Settings {
    return storage(useShallow((state) => state.settings));
}

export function useSettingMutable<K extends keyof Settings>(name: K): [Settings[K], (value: Settings[K]) => void] {
    const setValue = React.useCallback((value: Settings[K]) => {
        sync.applySettings({ [name]: value });
    }, [name]);
    const value = useSetting(name);
    return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
    return storage(useShallow((state) => state.settings[name]));
}

export function useLocalSettings(): LocalSettings {
    return storage(useShallow((state) => state.localSettings));
}

export function useAllMachines(options?: { includeOffline?: boolean }): Machine[] {
    const includeOffline = options?.includeOffline ?? false;
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        const machines = Object.values(state.machines).sort((a, b) => b.createdAt - a.createdAt);
        return includeOffline ? machines : machines.filter((v) => v.active);
    }));
}

export function useMachine(machineId: string): Machine | null {
    return storage(useShallow((state) => state.machines[machineId] ?? null));
}

export function useSessionListViewData(): SessionListViewItem[] | null {
    return storage(useDeepEqual((state) => state.isDataReady ? state.sessionListViewData : null));
}

export function useAllSessions(): Session[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        return Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(name: K): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const setValue = React.useCallback((value: LocalSettings[K]) => {
        storage.getState().applyLocalSettings({ [name]: value });
    }, [name]);
    const value = useLocalSetting(name);
    return [value, setValue];
}

// Project management hooks
export function useProjects() {
    return storage(useShallow((state) => state.getProjects()));
}

export function useProject(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProject(projectId) : null));
}

export function useProjectForSession(sessionId: string | null) {
    return storage(useShallow((state) => sessionId ? state.getProjectForSession(sessionId) : null));
}

export function useProjectSessions(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProjectSessions(projectId) : []));
}

export function useProjectGitStatus(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProjectGitStatus(projectId) : null));
}

export function useSessionProjectGitStatus(sessionId: string | null) {
    return storage(useShallow((state) => sessionId ? state.getSessionProjectGitStatus(sessionId) : null));
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    return storage(useShallow((state) => state.localSettings[name]));
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Filter out draft artifacts from the main list
        return Object.values(state.artifacts)
            .filter(artifact => !artifact.draft)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useAllArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Return all artifacts including drafts
        return Object.values(state.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useDraftArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Return only draft artifacts
        return Object.values(state.artifacts)
            .filter(artifact => artifact.draft === true)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useArtifact(artifactId: string): DecryptedArtifact | null {
    return storage(useShallow((state) => state.artifacts[artifactId] ?? null));
}

export function useArtifactsCount(): number {
    return storage(useShallow((state) => {
        // Count only non-draft artifacts
        return Object.values(state.artifacts).filter(a => !a.draft).length;
    }));
}

export function useEntitlement(id: KnownEntitlements): boolean {
    return storage(useShallow((state) => state.purchases.entitlements[id] ?? false));
}

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
    return storage(useShallow((state) => state.realtimeStatus));
}

export function useRealtimeMode(): 'idle' | 'agent-speaking' | 'user-speaking' {
    return storage(useShallow((state) => state.realtimeMode));
}

export function useVoiceSessionGeneration(): number {
    return storage(useShallow((state) => state.voiceSessionGeneration));
}

export function useSocketStatus() {
    return storage(useShallow((state) => ({
        status: state.socketStatus,
        lastConnectedAt: state.socketLastConnectedAt,
        lastDisconnectedAt: state.socketLastDisconnectedAt
    })));
}

export function useSessionGitStatus(sessionId: string): GitStatus | null {
    return storage(useShallow((state) => state.sessionGitStatus[sessionId] ?? null));
}

export function useSessionGitStatusFiles(sessionId: string): GitStatusFiles | null {
    return storage(useShallow((state) => state.sessionGitStatusFiles[sessionId] ?? null));
}

export function useSessionFileCache(sessionId: string, filePath: string) {
    return storage(useShallow((state) => state.sessionFileCache[sessionId]?.[filePath] ?? null));
}

export function useIsDataReady(): boolean {
    return storage(useShallow((state) => state.isDataReady));
}

export function useProfile() {
    return storage(useShallow((state) => state.profile));
}

export function useFriends() {
    return storage(useShallow((state) => state.friends));
}

export function useFriendRequests() {
    return storage(useShallow((state) => {
        // Filter friends to get pending requests (where status is 'pending')
        return Object.values(state.friends).filter(friend => friend.status === 'pending');
    }));
}

export function useAcceptedFriends() {
    return storage(useShallow((state) => {
        return Object.values(state.friends).filter(friend => friend.status === 'friend');
    }));
}

export function useFeedItems() {
    return storage(useShallow((state) => state.feedItems));
}
export function useFeedLoaded() {
    return storage((state) => state.feedLoaded);
}
export function useFriendsLoaded() {
    return storage((state) => state.friendsLoaded);
}

export function useFriend(userId: string | undefined) {
    return storage(useShallow((state) => userId ? state.friends[userId] : undefined));
}

export function useUser(userId: string | undefined) {
    return storage(useShallow((state) => userId ? state.users[userId] : undefined));
}

export function useRequestedFriends() {
    return storage(useShallow((state) => {
        // Filter friends to get sent requests (where status is 'requested')
        return Object.values(state.friends).filter(friend => friend.status === 'requested');
    }));
}
