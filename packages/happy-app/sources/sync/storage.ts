import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import { Session, Machine, GitStatus } from "./storageTypes";
import { createReducer, reducer, ReducerState } from "./reducer/reducer";
import { Message } from "./typesMessage";
import { NormalizedMessage } from "./typesRaw";
import { isMachineOnline } from '@/utils/machineUtils';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Profile } from "./profile";
import { UserProfile } from "./friendTypes";
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadProfile, saveProfile, loadSessionDrafts, saveSessionDrafts, loadSessionPermissionModes, saveSessionPermissionModes, loadSessionModelModes, saveSessionModelModes, loadDooTaskProfile, saveDooTaskProfile, loadDooTaskUserCache, saveDooTaskUserCache, clearDooTaskUserCache, loadDooTaskProjects, saveDooTaskProjects, clearDooTaskProjects, loadDooTaskPriorities, saveDooTaskPriorities, clearDooTaskPriorities, loadDooTaskColumns, saveDooTaskColumns, clearDooTaskColumns, loadRegisteredReposLocal, saveRegisteredReposLocal } from "./persistence";
import { DooTaskProfile, DooTaskProject, DooTaskItem, DooTaskFilters, DooTaskPager, DooTaskPriority, DooTaskColumn } from './dootask/types';
import { dootaskFetchProjects, dootaskFetchTasks, dootaskFetchUsersBasic, dootaskFetchPriorities, dootaskFetchProjectColumns } from './dootask/api';
import type { PermissionMode } from '@/components/PermissionModeSelector';
import React from "react";
import { sync } from "./sync";
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import { isMutableTool } from "@/components/tools/knownTools";
import { projectManager } from "./projectManager";
import { DecryptedArtifact } from "./artifactTypes";
import { FeedItem } from "./feedTypes";
import type { OpenClawMachine, OpenClawConnectionStatus } from "../openclaw/types";
import type { RegisteredRepo } from "@/utils/workspaceRepos";

// Debounce timer for realtimeMode changes
let realtimeModeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REALTIME_MODE_DEBOUNCE_MS = 150;

/**
 * Tracks session IDs that have been optimistically archived (active set to false locally).
 * While a session ID is in this set, incoming server updates (activity heartbeats, etc.)
 * will not overwrite the local `active: false` state, preventing the "disappear → reappear → disappear" flicker.
 */
const pendingArchiveSessionIds = new Set<string>();

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

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
    oldestSeq: number | null;
    hasMore: boolean;
    fetchVersion: number; // Monotonically increasing counter bumped on every fetch completion
}

// Machine type is now imported from storageTypes - represents persisted machine data

// Unified list item type for SessionsList component
export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: Session[] }
    | { type: 'project-group'; displayPath: string; machine: Machine }
    | { type: 'session'; session: Session; variant?: 'default' | 'no-path' };

// Legacy type for backward compatibility - to be removed
export type SessionListItem = string | Session;

interface StorageState {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    profile: Profile;
    sessions: Record<string, Session>;
    sessionsData: SessionListItem[] | null;  // Legacy - to be removed
    sessionListViewData: SessionListViewItem[] | null;
    sessionMessages: Record<string, SessionMessages>;
    sessionGitStatus: Record<string, GitStatus | null>;
    machines: Record<string, Machine>;
    openClawMachines: Record<string, OpenClawMachine>;  // OpenClaw machine configurations
    openClawDirectStatus: Record<string, OpenClawConnectionStatus>;  // Last known status for direct OpenClaw machines
    // Registered repositories per machine (loaded from UserKVStore)
    registeredRepos: Record<string, RegisteredRepo[]>;
    registeredReposVersions: Record<string, number>;  // KV versions for optimistic concurrency
    artifacts: Record<string, DecryptedArtifact>;  // New artifacts storage
    friends: Record<string, UserProfile>;  // All relationships (friends, pending, requested, etc.)
    users: Record<string, UserProfile | null>;  // Global user cache, null = 404/failed fetch
    feedItems: FeedItem[];  // Simple list of feed items
    feedHead: string | null;  // Newest cursor
    feedTail: string | null;  // Oldest cursor
    feedHasMore: boolean;
    feedLoaded: boolean;  // True after initial feed fetch
    friendsLoaded: boolean;  // True after initial friends fetch
    sharedSessions: Record<string, Session>;
    sharedSessionsLoaded: boolean;
    realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    realtimeMode: 'idle' | 'speaking' | 'thinking';
    microphoneMuted: boolean;
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    isDataReady: boolean;
    nativeUpdateStatus: { available: boolean; updateUrl?: string } | null;
    // DooTask integration
    dootaskProfile: DooTaskProfile | null;
    dootaskTasks: DooTaskItem[];
    dootaskProjects: DooTaskProject[];
    dootaskLoading: boolean;
    dootaskError: string | null;
    dootaskFilters: DooTaskFilters;
    dootaskPager: DooTaskPager;
    dootaskUserCache: Record<number, string>;
    dootaskUserAvatars: Record<number, string | null>;
    dootaskUserDisabledAt: Record<number, string | null>;
    dootaskTaskDetailCache: Record<number, { task: DooTaskItem; content: string | null }>;
    dootaskProjectsFetchedAt: number | null;
    dootaskUserCacheFetchedAt: number | null;
    dootaskLastProjectId: number | null;
    dootaskLastColumnId: number | null;
    dootaskPriorities: DooTaskPriority[];
    dootaskPrioritiesFetchedAt: number | null;
    dootaskColumns: Record<number, DooTaskColumn[]>;
    dootaskColumnsFetchedAt: Record<number, number>;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    applyOpenClawMachines: (machines: OpenClawMachine[], replace?: boolean) => void;
    removeOpenClawMachine: (machineId: string) => void;
    setOpenClawDirectStatus: (machineId: string, status: OpenClawConnectionStatus) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[], hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    setSessionPagination: (sessionId: string, oldestSeq: number | null, hasMore: boolean) => void;
    clearSessionMessages: (sessionId: string) => void;
    setSessionMessageSyncing: (sessionId: string, syncing: boolean) => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyProfile: (profile: Profile) => void;
    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setRealtimeMode: (mode: 'idle' | 'speaking' | 'thinking', immediate?: boolean) => void;
    clearRealtimeModeDebounce: () => void;
    setMicrophoneMuted: (muted: boolean) => void;
    setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    updateSessionActivity: (sessionId: string, active: boolean) => void;
    updateSessionPermissionMode: (sessionId: string, mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo') => void;
    updateSessionModelMode: (sessionId: string, mode: string) => void;
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
    getProjectGitStatusByKey: (machineId: string, path: string) => import('./storageTypes').GitStatus | null;
    getSessionProjectGitStatus: (sessionId: string) => import('./storageTypes').GitStatus | null;
    updateSessionProjectGitStatus: (sessionId: string, status: import('./storageTypes').GitStatus | null) => void;
    // Friend management methods
    applyFriends: (friends: UserProfile[]) => void;
    getFriend: (userId: string) => UserProfile | undefined;
    getAcceptedFriends: () => UserProfile[];
    // Shared sessions methods
    applySharedSessions: (sessions: Session[]) => void;
    addSharedSession: (session: Session) => void;
    updateSharedSessionAccessLevel: (sessionId: string, accessLevel: 'view' | 'edit' | 'admin') => void;
    removeSharedSession: (sessionId: string) => void;
    // User cache methods
    applyUsers: (users: Record<string, UserProfile | null>) => void;
    getUser: (userId: string) => UserProfile | null | undefined;
    assumeUsers: (userIds: string[]) => Promise<void>;
    // Feed methods
    applyFeedItems: (items: FeedItem[]) => void;
    clearFeed: () => void;
    // DooTask methods
    setDootaskProfile: (profile: DooTaskProfile | null) => void;
    fetchDootaskProjects: () => Promise<void>;
    fetchDootaskTasks: (opts?: { refresh?: boolean; loadMore?: boolean }) => Promise<void>;
    setDootaskFilter: (filters: Partial<DooTaskFilters>) => void;
    setDootaskLastSelection: (projectId: number, columnId: number) => void;
    refreshDootaskProjects: () => Promise<void>;
    fetchDootaskPriorities: () => Promise<void>;
    fetchDootaskColumns: (projectId: number) => Promise<void>;
    fetchDootaskUsers: (userIds: number[]) => Promise<Record<number, string>>;
    updateDootaskTask: (taskId: number, updates: Partial<DooTaskItem>) => void;
    clearDootaskData: () => void;
    // Registered repos methods
    setRegisteredRepos: (machineId: string, repos: RegisteredRepo[], version: number) => void;
}

// Helper function to build unified list view data from sessions and machines
function buildSessionListViewData(
    sessions: Record<string, Session>
): SessionListViewItem[] {
    // Separate active and inactive sessions
    const activeSessions: Session[] = [];
    const inactiveSessions: Session[] = [];

    Object.values(sessions).forEach(session => {
        if (isSessionActive(session)) {
            activeSessions.push(session);
        } else {
            inactiveSessions.push(session);
        }
    });

    // Sort sessions by updated date (newest first)
    activeSessions.sort((a, b) => b.updatedAt - a.updatedAt);
    inactiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);

    // Build unified list view data
    const listData: SessionListViewItem[] = [];

    // Add active sessions as a single item at the top (if any)
    if (activeSessions.length > 0) {
        listData.push({ type: 'active-sessions', sessions: activeSessions });
    }

    // Group inactive sessions by date
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: Session[] = [];
    let currentDateString: string | null = null;

    for (const session of inactiveSessions) {
        const sessionDate = new Date(session.updatedAt);
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
                    listData.push({ type: 'session', session: sess });
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
            listData.push({ type: 'session', session: sess });
        });
    }

    return listData;
}

function areSessionsShallowEqual(a: Session, b: Session): boolean {
    return (
        a.id === b.id &&
        a.seq === b.seq &&
        a.createdAt === b.createdAt &&
        a.updatedAt === b.updatedAt &&
        a.active === b.active &&
        a.activeAt === b.activeAt &&
        a.metadata === b.metadata &&
        a.metadataVersion === b.metadataVersion &&
        a.agentState === b.agentState &&
        a.agentStateVersion === b.agentStateVersion &&
        a.thinking === b.thinking &&
        a.thinkingAt === b.thinkingAt &&
        a.messageSyncing === b.messageSyncing &&
        a.presence === b.presence &&
        a.todos === b.todos &&
        a.draft === b.draft &&
        a.permissionMode === b.permissionMode &&
        a.modelMode === b.modelMode &&
        a.latestUsage === b.latestUsage
    );
}

function hasReferenceMapChanges<T>(prev: Record<string, T>, next: Record<string, T>): boolean {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    if (prevKeys.length !== nextKeys.length) {
        return true;
    }
    for (const key of prevKeys) {
        if (prev[key] !== next[key]) {
            return true;
        }
    }
    return false;
}

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let profile = loadProfile();
    let sessionDrafts = loadSessionDrafts();
    const _cachedProjects = loadDooTaskProjects();
    const _cachedUsers = loadDooTaskUserCache();
    const _cachedPriorities = loadDooTaskPriorities();
    const _cachedColumns = loadDooTaskColumns();
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    const cachedRepos = loadRegisteredReposLocal();
    return {
        settings,
        settingsVersion: version,
        localSettings,
        profile,
        sessions: {},
        machines: {},
        openClawMachines: {},  // Initialize OpenClaw machines
        openClawDirectStatus: {},  // Initialize direct OpenClaw machine status
        registeredRepos: cachedRepos.repos as Record<string, RegisteredRepo[]>,
        registeredReposVersions: cachedRepos.versions,
        artifacts: {},  // Initialize artifacts
        friends: {},  // Initialize relationships cache
        users: {},  // Initialize global user cache
        feedItems: [],  // Initialize feed items list
        feedHead: null,
        feedTail: null,
        feedHasMore: false,
        feedLoaded: false,  // Initialize as false
        friendsLoaded: false,  // Initialize as false
        sharedSessions: {},
        sharedSessionsLoaded: false,
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionMessages: {},
        sessionGitStatus: {},
        realtimeStatus: 'disconnected',
        realtimeMode: 'idle',
        microphoneMuted: false,
        socketStatus: 'disconnected',
        socketLastConnectedAt: null,
        socketLastDisconnectedAt: null,
        isDataReady: false,
        nativeUpdateStatus: null,
        // DooTask integration
        dootaskProfile: loadDooTaskProfile(),
        dootaskTasks: [],
        dootaskProjects: _cachedProjects.projects,
        dootaskLoading: false,
        dootaskError: null,
        dootaskFilters: { status: 'uncompleted' },
        dootaskPager: { page: 1, pagesize: 20, total: 0, hasMore: false },
        dootaskUserCache: _cachedUsers.cache,
        dootaskUserAvatars: _cachedUsers.avatars,
        dootaskUserDisabledAt: _cachedUsers.disabledAt,
        dootaskTaskDetailCache: {},
        dootaskProjectsFetchedAt: _cachedProjects.fetchedAt,
        dootaskUserCacheFetchedAt: _cachedUsers.fetchedAt,
        dootaskLastProjectId: null,
        dootaskLastColumnId: null,
        dootaskPriorities: _cachedPriorities.priorities as DooTaskPriority[],
        dootaskPrioritiesFetchedAt: _cachedPriorities.fetchedAt,
        dootaskColumns: _cachedColumns.columns as Record<number, DooTaskColumn[]>,
        dootaskColumnsFetchedAt: _cachedColumns.fetchedAt,
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

            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Get existing session for version comparison
                const existing = state.sessions[session.id];

                // Only update metadata/agentState if new version is higher or equal
                // This prevents out-of-order updates from overwriting newer data
                const useExistingMetadata = existing &&
                    existing.metadataVersion >= session.metadataVersion;
                const useExistingAgentState = existing &&
                    existing.agentStateVersion >= session.agentStateVersion;

                // Preserve existing draft and permission mode if they exist, or load from saved data
                const existingDraft = existing?.draft;
                const savedDraft = savedDrafts[session.id];
                const existingPermissionMode = existing?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                const existingModelMode = existing?.modelMode;
                const savedModelMode = savedModelModes[session.id];
                const existingMessageSyncing = existing?.messageSyncing;

                // If this session has a pending optimistic archive, preserve local active: false
                // to prevent stale server heartbeats from reverting the archive.
                // Clear the flag once the server confirms active: false.
                const isPendingArchive = pendingArchiveSessionIds.has(session.id);
                if (isPendingArchive && !session.active) {
                    pendingArchiveSessionIds.delete(session.id);
                }
                const resolvedActive = (isPendingArchive && existing && !existing.active && session.active)
                    ? false
                    : session.active;
                const isPreservingArchive = resolvedActive !== session.active;
                const resolvedPresence = isPreservingArchive
                    ? resolveSessionOnlineState({ active: false, activeAt: existing!.activeAt })
                    : presence;

                const mergedSession: Session = {
                    ...session,
                    // Preserve optimistic archive state
                    active: resolvedActive,
                    activeAt: isPreservingArchive ? existing!.activeAt : session.activeAt,
                    // Use existing metadata/agentState if their versions are higher
                    metadata: useExistingMetadata ? existing.metadata : session.metadata,
                    metadataVersion: useExistingMetadata ? existing.metadataVersion : session.metadataVersion,
                    agentState: useExistingAgentState ? existing.agentState : session.agentState,
                    agentStateVersion: useExistingAgentState ? existing.agentStateVersion : session.agentStateVersion,
                    presence: resolvedPresence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    permissionMode: existingPermissionMode || savedPermissionMode || session.permissionMode || 'default',
                    modelMode: existingModelMode || savedModelMode || session.modelMode || 'default',
                    messageSyncing: existingMessageSyncing ?? session.messageSyncing
                };

                // Keep object identity stable when nothing changed to avoid no-op render loops.
                mergedSessions[session.id] = existing && areSessionsShallowEqual(existing, mergedSession)
                    ? existing
                    : mergedSession;
            });

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
                        isLoaded: existingSessionMessages.isLoaded,
                        oldestSeq: existingSessionMessages.oldestSeq,
                        hasMore: existingSessionMessages.hasMore,
                        fetchVersion: existingSessionMessages.fetchVersion,
                    };

                    // IMPORTANT: Copy latestUsage from reducerState to Session for immediate availability
                    if (existingSessionMessages.reducerState.latestUsage) {
                        const nextSessionWithUsage: Session = {
                            ...newSession,
                            latestUsage: { ...existingSessionMessages.reducerState.latestUsage }
                        };
                        mergedSessions[session.id] = areSessionsShallowEqual(newSession, nextSessionWithUsage)
                            ? newSession
                            : nextSessionWithUsage;
                    }
                }
            });
            const hasSessionChanges = hasReferenceMapChanges(state.sessions, mergedSessions);
            const hasSessionMessageChanges = hasReferenceMapChanges(state.sessionMessages, updatedSessionMessages);

            if (!hasSessionChanges && !hasSessionMessageChanges) {
                return state;
            }

            // Legacy sessionsData - to be removed
            // Machines are now integrated into sessionListViewData
            let listData: SessionListItem[] | null = state.sessionsData;
            let sessionListViewData: SessionListViewItem[] | null = state.sessionListViewData;
            if (hasSessionChanges) {
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
                const nextListData: SessionListItem[] = [];

                if (activeSessions.length > 0) {
                    nextListData.push('online');
                    nextListData.push(...activeSessions);
                }

                if (inactiveSessions.length > 0) {
                    nextListData.push('offline');
                    nextListData.push(...inactiveSessions);
                }

                listData = nextListData;
                sessionListViewData = buildSessionListViewData(mergedSessions);
            }

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
                sessions: hasSessionChanges ? mergedSessions : state.sessions,
                sessionsData: hasSessionChanges ? listData : state.sessionsData,  // Legacy - to be removed
                sessionListViewData: hasSessionChanges ? sessionListViewData : state.sessionListViewData,
                sessionMessages: hasSessionMessageChanges ? updatedSessionMessages : state.sessionMessages
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
                    isLoaded: false,
                    oldestSeq: null,
                    hasMore: true,
                    fetchVersion: 0,
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
                    // Dedup: if a server message arrives with a localId, remove any
                    // optimistic message that was stored with id === localId
                    const localId = 'localId' in message ? message.localId : null;
                    if (localId && message.id !== localId && mergedMessagesMap[localId]) {
                        delete mergedMessagesMap[localId];
                    }
                    mergedMessagesMap[message.id] = message;
                });

                // Convert to array and sort by createdAt
                const messagesArray = Object.values(mergedMessagesMap)
                    .sort((a, b) => b.createdAt - a.createdAt);

                // Update session with todos and latestUsage
                // IMPORTANT: We extract latestUsage from the mutable reducerState and copy it to the Session object
                // This ensures latestUsage is available immediately on load, even before messages are fully loaded
                let updatedSessions = state.sessions;
                const needsUpdate = (reducerResult.todos !== undefined || existingSession.reducerState.latestUsage) && session;

                if (needsUpdate) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            ...(reducerResult.todos !== undefined && { todos: reducerResult.todos }),
                            // Copy latestUsage from reducerState to make it immediately available
                            latestUsage: existingSession.reducerState.latestUsage ? {
                                ...existingSession.reducerState.latestUsage
                            } : session.latestUsage
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
                            isLoaded: true,
                            oldestSeq: null,
                            hasMore: true,
                            fetchVersion: 1,
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
                            isLoaded: true,
                            fetchVersion: (existingSession.fetchVersion ?? 0) + 1,
                        } satisfies SessionMessages
                    }
                };
            }

            return result;
        }),
        setSessionPagination: (sessionId: string, oldestSeq: number | null, hasMore: boolean) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) return state;

            // Only move oldestSeq backward (smaller), never forward.
            // This prevents re-fetching latest messages from resetting the cursor
            // when older messages are already cached in the store.
            let finalOldestSeq = oldestSeq;
            let finalHasMore = hasMore;
            if (existing.oldestSeq !== null && oldestSeq !== null && oldestSeq > existing.oldestSeq) {
                finalOldestSeq = existing.oldestSeq;
                finalHasMore = existing.hasMore;
            }

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: { ...existing, oldestSeq: finalOldestSeq, hasMore: finalHasMore },
                },
            };
        }),
        clearSessionMessages: (sessionId: string) => set((state) => {
            const { [sessionId]: _, ...remainingSessionMessages } = state.sessionMessages;
            return {
                ...state,
                sessionMessages: remainingSessionMessages
            };
        }),
        setSessionMessageSyncing: (sessionId: string, syncing: boolean) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) {
                return state;
            }
            const updatedSession: Session = {
                ...session,
                messageSyncing: syncing
            };
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: updatedSession
            };
            const sessionListViewData = buildSessionListViewData(updatedSessions);

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData
            };
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
        applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => set((state) => ({
            ...state,
            nativeUpdateStatus: status
        })),
        setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => ({
            ...state,
            realtimeStatus: status
        })),
        setRealtimeMode: (mode: 'idle' | 'speaking' | 'thinking', immediate?: boolean) => {
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
        setMicrophoneMuted: (muted: boolean) => set((state) => ({
            ...state,
            microphoneMuted: muted
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

            // Rebuild sessionListViewData to update the UI immediately
            const sessionListViewData = buildSessionListViewData(
                updatedSessions
            );

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData
            };
        }),
        updateSessionActivity: (sessionId: string, active: boolean) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Track optimistic archive to prevent stale server updates from reverting it
            if (!active) {
                pendingArchiveSessionIds.add(sessionId);
            } else {
                pendingArchiveSessionIds.delete(sessionId);
            }

            const nextActiveAt = active ? session.activeAt : Math.max(Date.now(), session.activeAt);
            const updatedSession: Session = {
                ...session,
                active,
                activeAt: nextActiveAt,
                presence: resolveSessionOnlineState({ active, activeAt: nextActiveAt }),
            };

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: updatedSession
            };

            const sessionListViewData = buildSessionListViewData(updatedSessions);

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData
            };
        }),
        updateSessionPermissionMode: (sessionId: string, mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo') => {
            const session = get().sessions[sessionId];
            if (!session) return;
            const flavor = session.metadata?.flavor;
            if (flavor === 'claude' || flavor === 'gemini') {
                void sync.changePermissionMode(sessionId, mode);
            }
            set((state) => {
                const existing = state.sessions[sessionId];
                if (!existing) return state;

                // Update the session with the new permission mode
                const updatedSessions = {
                    ...state.sessions,
                    [sessionId]: {
                        ...existing,
                        permissionMode: mode
                    }
                };

                // Collect all permission modes for persistence
                const allModes: Record<string, PermissionMode> = {};
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
            });
        },
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

            // Persist model modes (only non-default values to save space)
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
        // Project management methods
        getProjects: () => projectManager.getProjects(),
        getProject: (projectId: string) => projectManager.getProject(projectId),
        getProjectForSession: (sessionId: string) => projectManager.getProjectForSession(sessionId),
        getProjectSessions: (projectId: string) => projectManager.getProjectSessions(projectId),
        // Project git status methods
        getProjectGitStatus: (projectId: string) => projectManager.getProjectGitStatus(projectId),
        getProjectGitStatusByKey: (machineId: string, path: string) => projectManager.getProjectGitStatusByKey({ machineId, path }),
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
        // OpenClaw machine methods
        applyOpenClawMachines: (machines: OpenClawMachine[], replace: boolean = false) => set((state) => {
            let mergedMachines: Record<string, OpenClawMachine>;

            if (replace) {
                mergedMachines = {};
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            } else {
                mergedMachines = { ...state.openClawMachines };
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            }

            console.log(`🤖 Storage.applyOpenClawMachines: Total OpenClaw machines after merge: ${Object.keys(mergedMachines).length}`);

            return {
                ...state,
                openClawMachines: mergedMachines
            };
        }),
        removeOpenClawMachine: (machineId: string) => set((state) => {
            const { [machineId]: removed, ...remaining } = state.openClawMachines;
            const { [machineId]: removedStatus, ...remainingStatus } = state.openClawDirectStatus;
            console.log(`🤖 Storage.removeOpenClawMachine: Removed machine ${machineId}`);
            return {
                ...state,
                openClawMachines: remaining,
                openClawDirectStatus: remainingStatus,
            };
        }),
        setOpenClawDirectStatus: (machineId: string, status: OpenClawConnectionStatus) => set((state) => ({
            ...state,
            openClawDirectStatus: { ...state.openClawDirectStatus, [machineId]: status },
        })),
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
            
            // Clear drafts and permission modes from persistent storage
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);
            
            const modes = loadSessionPermissionModes();
            delete modes[sessionId];
            saveSessionPermissionModes(modes);

            const modelModes = loadSessionModelModes();
            delete modelModes[sessionId];
            saveSessionModelModes(modelModes);
            
            // Rebuild sessionListViewData without the deleted session
            const sessionListViewData = buildSessionListViewData(remainingSessions);
            
            return {
                ...state,
                sessions: remainingSessions,
                sessionMessages: remainingSessionMessages,
                sessionGitStatus: remainingGitStatus,
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
        getFriend: (userId: string) => {
            return get().friends[userId];
        },
        getAcceptedFriends: () => {
            const friends = get().friends;
            return Object.values(friends).filter(friend => friend.status === 'friend');
        },
        // Shared sessions methods
        applySharedSessions: (sessions) => set((state) => ({
            ...state,
            sharedSessions: Object.fromEntries(sessions.map(s => [s.id, s])),
            sharedSessionsLoaded: true
        })),
        addSharedSession: (session) => set((state) => ({
            ...state,
            sharedSessions: { ...state.sharedSessions, [session.id]: session }
        })),
        updateSharedSessionAccessLevel: (sessionId, accessLevel) => set((state) => {
            const session = state.sharedSessions[sessionId];
            if (!session) return state;
            return {
                ...state,
                sharedSessions: {
                    ...state.sharedSessions,
                    [sessionId]: { ...session, accessLevel }
                }
            };
        }),
        removeSharedSession: (sessionId) => set((state) => {
            const { [sessionId]: _, ...rest } = state.sharedSessions;
            return { ...state, sharedSessions: rest };
        }),
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
        // DooTask methods
        setDootaskProfile: (profile) => {
            saveDooTaskProfile(profile);
            clearDooTaskUserCache();
            clearDooTaskProjects();
            clearDooTaskPriorities();
            clearDooTaskColumns();
            set((state) => ({
                ...state,
                dootaskProfile: profile,
                dootaskError: null,
                // Clear all data on login to avoid stale data from previous account
                dootaskTasks: [],
                dootaskLoading: false,
                dootaskPager: { page: 1, pagesize: 20, total: 0, hasMore: false },
                dootaskProjects: [],
                dootaskProjectsFetchedAt: null,
                dootaskUserCache: {},
                dootaskUserAvatars: {},
                dootaskUserDisabledAt: {},
                dootaskUserCacheFetchedAt: null,
                dootaskTaskDetailCache: {},
                dootaskPriorities: [],
                dootaskPrioritiesFetchedAt: null,
                dootaskColumns: {},
                dootaskColumnsFetchedAt: {},
            }));
        },

        fetchDootaskProjects: async () => {
            const { dootaskProfile } = get();
            if (!dootaskProfile) return;
            const profileKey = `${dootaskProfile.serverUrl}|${dootaskProfile.userId}|${dootaskProfile.token}`;
            try {
                const res = await dootaskFetchProjects(dootaskProfile.serverUrl, dootaskProfile.token);
                const cur = get().dootaskProfile;
                if (!cur || `${cur.serverUrl}|${cur.userId}|${cur.token}` !== profileKey) return; // account switched
                if (res.ret === 1) {
                    const projects = (res.data?.data || res.data || []).map((p: any) => ({
                        id: p.id, name: p.name
                    }));
                    const now = Date.now();
                    saveDooTaskProjects(projects, now);
                    set((state) => ({ ...state, dootaskProjects: projects, dootaskProjectsFetchedAt: now }));
                }
            } catch {
                // silent — projects are supplementary
            }
        },

        refreshDootaskProjects: async () => {
            set((state) => ({ ...state, dootaskProjectsFetchedAt: null }));
            await get().fetchDootaskProjects();
        },

        fetchDootaskPriorities: async () => {
            const { dootaskProfile } = get();
            if (!dootaskProfile) return;
            const profileKey = `${dootaskProfile.serverUrl}|${dootaskProfile.userId}|${dootaskProfile.token}`;
            try {
                const res = await dootaskFetchPriorities(dootaskProfile.serverUrl, dootaskProfile.token);
                const cur = get().dootaskProfile;
                if (!cur || `${cur.serverUrl}|${cur.userId}|${cur.token}` !== profileKey) return;
                if (res.ret === 1) {
                    const priorities: DooTaskPriority[] = (res.data || []).map((p: any) => ({
                        priority: p.priority,
                        name: p.name,
                        color: p.color,
                        days: p.days ?? 0,
                        is_default: p.is_default,
                    }));
                    const now = Date.now();
                    saveDooTaskPriorities(priorities, now);
                    set((state) => ({ ...state, dootaskPriorities: priorities, dootaskPrioritiesFetchedAt: now }));
                }
            } catch {
                // silent
            }
        },

        fetchDootaskColumns: async (projectId: number) => {
            const { dootaskProfile } = get();
            if (!dootaskProfile) return;
            const profileKey = `${dootaskProfile.serverUrl}|${dootaskProfile.userId}|${dootaskProfile.token}`;
            try {
                const res = await dootaskFetchProjectColumns(dootaskProfile.serverUrl, dootaskProfile.token, projectId);
                const cur = get().dootaskProfile;
                if (!cur || `${cur.serverUrl}|${cur.userId}|${cur.token}` !== profileKey) return;
                if (res.ret === 1) {
                    const rawCols = res.data?.data || res.data || [];
                    const cols: DooTaskColumn[] = (Array.isArray(rawCols) ? rawCols : []).map((c: any) => ({
                        id: c.id,
                        name: c.name,
                        sort: c.sort ?? 0,
                    }));
                    const now = Date.now();
                    const updatedColumns = { ...get().dootaskColumns, [projectId]: cols };
                    const updatedFetchedAt = { ...get().dootaskColumnsFetchedAt, [projectId]: now };
                    saveDooTaskColumns(updatedColumns, updatedFetchedAt);
                    set((state) => ({ ...state, dootaskColumns: updatedColumns, dootaskColumnsFetchedAt: updatedFetchedAt }));
                }
            } catch {
                // silent
            }
        },

        fetchDootaskTasks: async (opts) => {
            const { dootaskProfile, dootaskFilters, dootaskPager, dootaskTasks } = get();
            if (!dootaskProfile) return;
            const loadMore = opts?.loadMore ?? false;
            const page = loadMore ? dootaskPager.page + 1 : 1;
            const profileKey = `${dootaskProfile.serverUrl}|${dootaskProfile.userId}|${dootaskProfile.token}`;

            set((state) => ({ ...state, dootaskLoading: true, dootaskError: null }));
            try {
                const keys: Record<string, string> = {};
                const search = dootaskFilters.search?.trim();
                if (dootaskFilters.status && dootaskFilters.status !== 'all') {
                    keys['status'] = dootaskFilters.status;
                }
                if (search) {
                    keys['name'] = search;
                }
                const ownerParam = dootaskFilters.role === 'owner' ? 1 : dootaskFilters.role === 'assist' ? 0 : undefined;
                const res = await dootaskFetchTasks(dootaskProfile.serverUrl, dootaskProfile.token, {
                    page,
                    pagesize: dootaskPager.pagesize,
                    project_id: dootaskFilters.projectId,
                    parent_id: -1,
                    keys: Object.keys(keys).length > 0 ? keys : undefined,
                    time: dootaskFilters.time,
                    owner: ownerParam,
                    with_extend: 'project_name,column_name',
                });

                const cur = get().dootaskProfile;
                if (!cur || `${cur.serverUrl}|${cur.userId}|${cur.token}` !== profileKey) return; // account switched

                if (res.ret === -1 || /身份已失效|请登录后继续/.test(res.msg)) {
                    set((state) => ({ ...state, dootaskLoading: false, dootaskError: 'token_expired' }));
                    return;
                }

                if (res.ret === 1) {
                    const newTasks: DooTaskItem[] = res.data.data || [];
                    const merged = loadMore ? [...dootaskTasks, ...newTasks] : newTasks;
                    set((state) => ({
                        ...state,
                        dootaskTasks: merged,
                        dootaskLoading: false,
                        dootaskPager: {
                            ...state.dootaskPager,
                            page: res.data.current_page,
                            total: res.data.total,
                            hasMore: res.data.current_page < res.data.last_page,
                        },
                    }));
                } else {
                    set((state) => ({ ...state, dootaskLoading: false, dootaskError: res.msg }));
                }
            } catch (e) {
                const cur = get().dootaskProfile;
                if (!cur || `${cur.serverUrl}|${cur.userId}|${cur.token}` !== profileKey) return;
                set((state) => ({
                    ...state,
                    dootaskLoading: false,
                    dootaskError: e instanceof Error ? e.message : 'Failed to load tasks',
                }));
            }
        },

        setDootaskFilter: (filters) => {
            set((state) => ({
                ...state,
                dootaskFilters: { ...state.dootaskFilters, ...filters },
            }));
        },

        setDootaskLastSelection: (projectId: number, columnId: number) => {
            set((state) => ({
                ...state,
                dootaskLastProjectId: projectId,
                dootaskLastColumnId: columnId,
            }));
        },

        fetchDootaskUsers: async (userIds) => {
            const { dootaskProfile, dootaskUserCache, dootaskUserCacheFetchedAt } = get();
            if (!dootaskProfile || userIds.length === 0) return dootaskUserCache;

            // If cache expired (>10 min), re-fetch all requested IDs; otherwise only missing ones
            // Also re-fetch users whose avatar or disabledAt status is missing from cache (e.g. after upgrade)
            const expired = !dootaskUserCacheFetchedAt || Date.now() - dootaskUserCacheFetchedAt >= 600_000;
            const avatarCache = get().dootaskUserAvatars;
            const disabledAtCache = get().dootaskUserDisabledAt;
            const missingIds = expired
                ? userIds
                : userIds.filter((id) => !(id in dootaskUserCache) || !(id in avatarCache) || !(id in disabledAtCache));
            if (missingIds.length === 0) return dootaskUserCache;

            const profileKey = `${dootaskProfile.serverUrl}|${dootaskProfile.userId}|${dootaskProfile.token}`;
            try {
                const res = await dootaskFetchUsersBasic(dootaskProfile.serverUrl, dootaskProfile.token, missingIds);
                const cur = get().dootaskProfile;
                if (!cur || `${cur.serverUrl}|${cur.userId}|${cur.token}` !== profileKey) return get().dootaskUserCache; // account switched
                if (res.ret === 1 && Array.isArray(res.data)) {
                    const newEntries: Record<number, string> = {};
                    const newAvatars: Record<number, string | null> = {};
                    const newDisabledAt: Record<number, string | null> = {};
                    for (const u of res.data) {
                        if (u.userid) {
                            newEntries[u.userid] = u.nickname || '';
                            newAvatars[u.userid] = u.userimg || null;
                            newDisabledAt[u.userid] = u.disable_at || null;
                        }
                    }
                    // When expired, strip requested IDs from old cache before merging
                    // so IDs not returned by API don't retain stale values
                    const oldCache = get().dootaskUserCache;
                    const base = expired
                        ? Object.fromEntries(Object.entries(oldCache).filter(([id]) => !missingIds.includes(Number(id))))
                        : oldCache;
                    const merged = { ...base, ...newEntries };
                    const mergedAvatars = { ...get().dootaskUserAvatars, ...newAvatars };
                    const mergedDisabledAt = { ...get().dootaskUserDisabledAt, ...newDisabledAt };
                    const now = Date.now();
                    saveDooTaskUserCache(merged, mergedAvatars, mergedDisabledAt, now);
                    set((state) => ({ ...state, dootaskUserCache: merged, dootaskUserAvatars: mergedAvatars, dootaskUserDisabledAt: mergedDisabledAt, dootaskUserCacheFetchedAt: now }));
                    return merged;
                }
            } catch { /* silent */ }
            return get().dootaskUserCache;
        },

        updateDootaskTask: (taskId, updates) => set((state) => {
            const idx = state.dootaskTasks.findIndex((t) => t.id === taskId);
            if (idx === -1) return state;
            const updated = [...state.dootaskTasks];
            updated[idx] = { ...updated[idx], ...updates };
            return { ...state, dootaskTasks: updated };
        }),

        clearDootaskData: () => {
            saveDooTaskProfile(null);
            clearDooTaskUserCache();
            clearDooTaskProjects();
            clearDooTaskPriorities();
            clearDooTaskColumns();
            set((state) => ({
                ...state,
                dootaskProfile: null,
                dootaskTasks: [],
                dootaskProjects: [],
                dootaskLoading: false,
                dootaskError: null,
                dootaskFilters: { status: 'uncompleted' },
                dootaskPager: { page: 1, pagesize: 20, total: 0, hasMore: false },
                dootaskUserCache: {},
                dootaskUserAvatars: {},
                dootaskUserDisabledAt: {},
                dootaskTaskDetailCache: {},
                dootaskProjectsFetchedAt: null,
                dootaskUserCacheFetchedAt: null,
                dootaskLastProjectId: null,
                dootaskLastColumnId: null,
                dootaskPriorities: [],
                dootaskPrioritiesFetchedAt: null,
                dootaskColumns: {},
                dootaskColumnsFetchedAt: {},
            }));
        },

        // Registered repos
        setRegisteredRepos: (machineId: string, repos: RegisteredRepo[], version: number) => set((state) => {
            const updatedRepos = { ...state.registeredRepos, [machineId]: repos };
            const updatedVersions = { ...state.registeredReposVersions, [machineId]: version };
            saveRegisteredReposLocal(updatedRepos, updatedVersions);
            return { registeredRepos: updatedRepos, registeredReposVersions: updatedVersions };
        }),
    }
});

export function useSessions() {
    return storage(useShallow((state) => state.isDataReady ? state.sessionsData : null));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: unknown[] = [];

export function useSessionMessages(sessionId: string): { messages: Message[], isLoaded: boolean, hasMore: boolean, fetchVersion: number } {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return {
            messages: session?.messages ?? emptyArray,
            isLoaded: session?.isLoaded ?? false,
            hasMore: session?.hasMore ?? true,
            fetchVersion: session?.fetchVersion ?? 0,
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

export function useAllMachines(): Machine[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        return (Object.values(state.machines).sort((a, b) => b.createdAt - a.createdAt)).filter((v) => v.active);
    }));
}

export function useMachine(machineId: string): Machine | null {
    return storage(useShallow((state) => state.machines[machineId] ?? null));
}

export function useAllOpenClawMachines(): OpenClawMachine[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        return Object.values(state.openClawMachines).sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useOpenClawMachine(machineId: string): OpenClawMachine | null {
    return storage(useShallow((state) => state.openClawMachines[machineId] ?? null));
}

export function useOpenClawDirectStatus(machineId: string): OpenClawConnectionStatus | null {
    return storage((state) => state.openClawDirectStatus[machineId] ?? null);
}

export function useSessionListViewData(): SessionListViewItem[] | null {
    return storage((state) => state.isDataReady ? state.sessionListViewData : null);
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

export function useProjectGitStatusByKey(machineId: string | null, path: string | null) {
    return storage(useShallow((state) => (machineId && path) ? state.getProjectGitStatusByKey(machineId, path) : null));
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

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
    return storage(useShallow((state) => state.realtimeStatus));
}

export function useRealtimeMode(): 'idle' | 'speaking' | 'thinking' {
    return storage(useShallow((state) => state.realtimeMode));
}

export function useMicrophoneMuted(): boolean {
    return storage(useShallow((state) => state.microphoneMuted));
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

// Shared sessions hooks
export function useSharedSessions() {
    return storage(useShallow((state) => Object.values(state.sharedSessions)));
}

export function useSessionAccessLevel(sessionId: string) {
    return storage((state) => state.sharedSessions[sessionId]?.accessLevel);
}

export function useIsSessionOwner(sessionId: string) {
    return storage((state) => !!state.sessions[sessionId] && !state.sharedSessions[sessionId]);
}

// DooTask hooks
export function useDootaskProfile(): DooTaskProfile | null {
    return storage(useShallow((s) => s.dootaskProfile));
}

export function useDootaskTasks() {
    return storage(useShallow((s) => ({
        tasks: s.dootaskTasks,
        loading: s.dootaskLoading,
        error: s.dootaskError,
        pager: s.dootaskPager,
    })));
}

export function useDootaskProjects(): DooTaskProject[] {
    return storage(useShallow((s) => s.dootaskProjects));
}

export function useDootaskFilters(): DooTaskFilters {
    return storage(useShallow((s) => s.dootaskFilters));
}

export function useDootaskUserCache(): Record<number, string> {
    return storage(useShallow((s) => s.dootaskUserCache));
}

export function useDootaskUserAvatars(): Record<number, string | null> {
    return storage(useShallow((s) => s.dootaskUserAvatars));
}

export function useDootaskUserDisabledAt(): Record<number, string | null> {
    return storage(useShallow((s) => s.dootaskUserDisabledAt));
}

export function useDootaskPriorities(): DooTaskPriority[] {
    return storage(useShallow((s) => s.dootaskPriorities));
}

export function useDootaskColumns(projectId: number | null): DooTaskColumn[] {
    return storage(useShallow((s) => (projectId != null ? s.dootaskColumns[projectId] : undefined) ?? []));
}

export function useDootaskLastSelection() {
    return storage(useShallow((s) => ({
        projectId: s.dootaskLastProjectId,
        columnId: s.dootaskLastColumnId,
    })));
}

export function useDootaskTaskDetailCache(taskId: number) {
    return storage(useShallow((s) => s.dootaskTaskDetailCache[taskId] ?? null));
}
