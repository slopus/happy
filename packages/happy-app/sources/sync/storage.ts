import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import equal from 'fast-deep-equal'
import { useDeepEqual } from './storeSelectors';
import { Session, Machine, GitStatus, SessionAgentModesPatch } from "./storageTypes";
import type { GitStatusFiles } from "./gitStatusFiles";
import type { ProjectFilesList } from "./projectFiles";
import { buildPathProjectGroups, buildProjectGroups, isProjectSession, type ProjectGroupData } from "./projectGroups";
import {
    selectAgentFormCommunication,
    selectPendingCommunications,
    type PendingAgentCommunication,
} from "./agentCommunications";
import { createReducer, reducer, ReducerState } from "./reducer/reducer";
import { Message } from "./typesMessage";
import { NormalizedMessage } from "./typesRaw";
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionName, getSessionSubtitle, getSessionAvatarId } from '@/utils/sessionUtils';
import { resolveSessionState, type SessionState } from './sessionState';
import { getSessionActivityAt } from '@/utils/sessionActivity';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Purchases, customerInfoToPurchases } from "./purchases";
import { Profile } from "./profile";
import { UserProfile, RelationshipUpdatedEvent } from "./friendTypes";
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadPurchases, savePurchases, loadProfile, saveProfile, loadSessionDrafts, saveSessionDrafts } from "./persistence";
import { isAgentModePushPending } from "./agentModesPending";
import { loadSessionLastMessageSentAt, saveSessionLastMessageSentAt } from "./persistence";
import type { CustomerInfo } from './revenueCat/types';
import React from "react";
import { sync } from "./sync";
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import { isMutableTool } from "@/components/tools/knownTools";
import { DecryptedArtifact } from "./artifactTypes";
import { FeedItem } from "./feedTypes";
import { getRigActivityIndicators, getRigGitSummary, getRigIdentity, isRigMetadata } from './rig';
import { indexSessionsById } from './sessionIdentity';
import { t } from '@/text';
import type { Project } from './projectTypes';
import { getSessionProjectId, isHappyAgentSession } from './projectTypes';

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

/**
 * A session the agent retired, or a Happy CLI session that has ended. Rig
 * sessions that merely lost their connection are still live work.
 *
 * Archived sessions never sit inside a project card: they trail the list as
 * flat, date-grouped rows, so revealing the archive appends to the bottom
 * instead of reshaping the groups above it.
 */
function isSessionArchived(session: Session): boolean {
    return session.metadata?.lifecycleState === 'archived'
        || (!isRigMetadata(session.metadata) && !session.active);
}

/** "Today", "Yesterday", or "N days ago" for a flat row's date heading. */
function relativeDayTitle(timestamp: number): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const then = new Date(timestamp);
    const day = new Date(then.getFullYear(), then.getMonth(), then.getDate());
    // Rounded because a DST boundary makes a calendar day 23 or 25 hours long.
    const diffDays = Math.round((today.getTime() - day.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays <= 0) return t('sessionHistory.today');
    if (diffDays === 1) return t('sessionHistory.yesterday');
    return t('sessionHistory.daysAgo', { count: diffDays });
}

// Known entitlement IDs
export type KnownEntitlements = 'pro';

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
    // True when the server reported more older messages exist beyond the
    // oldest one we currently have. Drives the "load older" affordance in
    // the chat list. Defaults to false until the initial fetch resolves —
    // the UI must not show a stale paginate-up spinner before that.
    hasMoreOlder: boolean;
    // True while a backward (older-history) page is in flight. Used by the
    // chat list to render a loading footer at the top of the inverted list
    // and to suppress duplicate triggers from FlatList onEndReached.
    isLoadingOlder: boolean;
}

// Machine type is now imported from storageTypes - represents persisted machine data

// Display-only row data — all primitives, cheap to deep-equal
export interface SessionRowData {
    id: string;
    name: string;
    subtitle: string;
    avatarId: string;
    flavor: string | null;
    clientId: string | null;
    identityLine: string | null;
    providerKind: string | null;
    modelName: string | null;
    activitySummary: string | null;
    gitChangedFiles: number | null;
    gitCountsExact: boolean;
    gitDeletions: number | null;
    gitInsertions: number | null;
    state: SessionState;
    // Only present on inactive sessions — active sessions never show "last seen"
    // and activeAt updates on every heartbeat, causing needless deep-equal diffs
    activeAt?: number;
    createdAt: number;
    // Last meaningful message, falling back to this device's sent-message
    // record and then creation — see getSessionActivityAt. Grouping the list by
    // project loses the global ordering the sessions were sorted into, so the
    // flat list re-sorts on these two keys instead.
    lastActivityAt: number;
    hasDraft: boolean;
    active: boolean;
    archived: boolean;
    machineId: string | null;
    // True only when the machine this session runs on is known to be offline.
    // A session that merely dropped its own socket is still live work on a live
    // machine, so the row greys out for this and never for that. Unknown
    // machines count as online: better an unshaded row than a wrongly dead one.
    machineOffline: boolean;
    path: string | null;
    homeDir: string | null;
    completedTodosCount: number;
    totalTodosCount: number;
    hasUnread: boolean;
    // Native project identity supplied by Rig. Happy CLI project cards derive
    // their identity from machineId + path instead.
    projectId: string | null;
    projectName: string | null;
    // Names the git worktree this session runs in; null in the primary tree.
    workspaceId: string | null;
    workspaceName: string | null;
    // Private project art is already materialized as a local/data URI by sync.
    projectAvatarUri?: string | null;
    projectAvatarThumbhash?: string | null;
}

function buildSessionRowData(
    session: Session,
    unreadSessionIds?: Set<string>,
    machines?: Record<string, Machine>,
    projects: Record<string, Project> = {},
): SessionRowData {
    const isOnline = session.presence === "online";
    const state = resolveSessionState({
        agentState: session.agentState,
        thinking: session.thinking,
        isOnline,
    });

    const rigIdentity = getRigIdentity(session.metadata);
    const rigActivity = getRigActivityIndicators(session.metadata);
    const rigGit = getRigGitSummary(session.metadata);
    const machineId = session.metadata?.machineId ?? null;
    const machine = machineId ? machines?.[machineId] : undefined;
    const projectId = getSessionProjectId(session);
    const linkedProject = projectId ? projects[projectId] : undefined;
    const metadataProject = session.metadata?.project;
    const projectAvatar = isHappyAgentSession(session) ? linkedProject?.avatar : null;
    return {
        id: session.id,
        name: getSessionName(session),
        subtitle: getSessionSubtitle(session),
        avatarId: getSessionAvatarId(session),
        flavor: session.metadata?.flavor ?? null,
        clientId: session.metadata?.client?.id ?? null,
        identityLine: rigIdentity ? `${rigIdentity.clientName} · ${rigIdentity.providerName}` : null,
        providerKind: session.metadata?.provider?.kind ?? null,
        modelName: rigIdentity?.modelName ?? null,
        activitySummary: rigActivity.length > 0
            ? rigActivity.map((item) => `${item.count}${item.queued ? `+${item.queued}` : ''} ${item.key}`).join(' · ')
            : null,
        gitChangedFiles: rigGit?.changedFiles ?? null,
        gitCountsExact: rigGit?.countsExact ?? true,
        gitDeletions: rigGit?.deletions ?? null,
        gitInsertions: rigGit?.insertions ?? null,
        state,
        createdAt: session.createdAt,
        lastActivityAt: getSessionActivityAt(session),
        ...(!session.active && { activeAt: session.activeAt }),
        hasDraft: !!session.draft,
        active: session.active,
        archived: isSessionArchived(session),
        machineId,
        machineOffline: machine ? !isMachineOnline(machine) : false,
        path: session.metadata?.path ?? null,
        homeDir: session.metadata?.homeDir ?? null,
        completedTodosCount: session.todos?.filter(todo => todo.status === 'completed').length ?? 0,
        totalTodosCount: session.todos?.length ?? 0,
        hasUnread: unreadSessionIds?.has(session.id) ?? false,
        projectId,
        projectName: linkedProject?.name ?? metadataProject?.name ?? null,
        workspaceId: session.metadata?.workspace?.id ?? null,
        workspaceName: session.metadata?.workspace?.name ?? null,
        projectAvatarUri: projectAvatar?.uri || null,
        projectAvatarThumbhash: projectAvatar?.thumbhash || null,
    };
}


// Unified list item type for SessionsList component
export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: SessionRowData[] }
    | { type: 'project-group'; displayPath: string; machine: Machine }
    | { type: 'projects-header'; source: 'rig' | 'happy' }
    | { type: 'project'; source: 'rig' | 'happy'; project: ProjectGroupData }
    | { type: 'session'; session: SessionRowData };

export type { ProjectGroupData, ProjectWorkspaceGroup } from './projectGroups';


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
    pathGitStatus: Record<string, GitStatus | null>;        // keyed by "machineId:path"
    pathGitStatusFiles: Record<string, GitStatusFiles | null>; // keyed by "machineId:path"
    pathProjectFiles: Record<string, ProjectFilesList | null>;  // keyed by "machineId:path"
    sessionFileCache: Record<string, Record<string, { content: string | null; diff: string | null; isBinary: boolean; cachedAt: number }>>;
    machines: Record<string, Machine>;
    projects: Record<string, Project>;
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
    applyProjects: (projects: Project[], replace?: boolean) => void;
    applyProjectAvatar: (projectId: string, avatar: Project['avatar']) => void;
    deleteMachine: (machineId: string) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[], hasReadyEvent: boolean, enteredPlanMode: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    applyOlderMessagesPagination: (sessionId: string, info: { hasMore: boolean }) => void;
    applyOlderMessagesLoading: (sessionId: string, isLoading: boolean) => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    applyProfile: (profile: Profile) => void;
    applyGitStatus: (pathKey: string, status: GitStatus | null) => void;
    applyGitStatusFiles: (pathKey: string, files: GitStatusFiles | null) => void;
    applyProjectFiles: (pathKey: string, files: ProjectFilesList | null) => void;
    getSessionPathKey: (sessionId: string) => string | null;
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
    updateSessionAgentModes: (sessionId: string, patch: SessionAgentModesPatch) => void;
    markSessionMessageSent: (sessionId: string) => void;
    // Artifact methods
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
    deleteSession: (sessionId: string) => void;
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
    // Unread session tracking (memory-only)
    unreadSessionIds: Set<string>;
    currentViewingSessionId: string | null;
    markSessionRead: (sessionId: string) => void;
    markSessionUnread: (sessionId: string) => void;
    setCurrentViewingSession: (sessionId: string | null) => void;
}

// Helper function to build unified list view data from sessions and machines
function buildSessionListViewData(
    sessions: Record<string, Session>,
    // Required on purpose: an omitted set silently rebuilds the list with
    // hasUnread=false everywhere — exactly the bug this parameter caused twice.
    unreadSessionIds: Set<string>,
    // Also required: rows grey out on their machine's presence, and an omitted
    // map would quietly report every machine as online.
    machines: Record<string, Machine>,
    projects: Record<string, Project> = {},
): SessionListViewItem[] {
    const rigProjectSessions: Session[] = [];
    const rigPathSessions: Session[] = [];
    const happySessions: Session[] = [];
    const archivedSessions: Session[] = [];

    Object.values(sessions).forEach(session => {
        // Side chats are hidden children of another session — they render only
        // inside the parent's sidebar panel, never in the top-level list.
        if (session.metadata?.isSideChat) {
            return;
        }
        // The archive is a flat chronological tail, not part of any project.
        if (isSessionArchived(session)) {
            archivedSessions.push(session);
            return;
        }
        if (isRigMetadata(session.metadata)) {
            if (isProjectSession(session)) {
                rigProjectSessions.push(session);
            } else {
                rigPathSessions.push(session);
            }
        } else {
            happySessions.push(session);
        }
    });

    // Chat lists always sort by last activity. Activity keys off the last
    // meaningful message, not updatedAt: updatedAt
    // bumps on every background agent update, which would make the list jump while
    // several sessions stream at once.
    const sortKey = getSessionActivityAt;
    const sortProjectSessions = (items: Session[]) => items.sort((a, b) => {
        const activeDelta = Number(isSessionActive(b)) - Number(isSessionActive(a));
        return activeDelta !== 0 ? activeDelta : sortKey(b) - sortKey(a);
    });
    sortProjectSessions(rigProjectSessions);
    sortProjectSessions(rigPathSessions);
    sortProjectSessions(happySessions);
    archivedSessions.sort((a, b) => sortKey(b) - sortKey(a));

    const listData: SessionListViewItem[] = [];
    const toRow = (session: Session) => buildSessionRowData(session, unreadSessionIds, machines, projects);

    const rigProjects = [
        ...buildProjectGroups(rigProjectSessions, toRow, isSessionActive),
        ...buildPathProjectGroups(rigPathSessions, toRow, isSessionActive, 'rig'),
    ];
    if (rigProjects.length > 0) {
        listData.push({ type: 'projects-header', source: 'rig' });
        for (const project of rigProjects) {
            listData.push({ type: 'project', source: 'rig', project });
        }
    }

    const happyProjects = buildPathProjectGroups(
        happySessions,
        toRow,
        isSessionActive,
        'happy',
    );
    if (happyProjects.length > 0) {
        listData.push({ type: 'projects-header', source: 'happy' });
        for (const project of happyProjects) {
            listData.push({ type: 'project', source: 'happy', project });
        }
    }

    // The archive trails everything as plain rows, newest first, split by the
    // day they were last worked on.
    let currentDay: number | null = null;
    for (const session of archivedSessions) {
        const timestamp = sortKey(session);
        const day = new Date(timestamp).setHours(0, 0, 0, 0);
        if (day !== currentDay) {
            currentDay = day;
            listData.push({ type: 'header', title: relativeDayTitle(timestamp) });
        }
        listData.push({ type: 'session', session: toRow(session) });
    }

    return listData;
}

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let purchases = loadPurchases();
    let profile = loadProfile();
    let sessionDrafts = loadSessionDrafts();
    let sessionLastMessageSentAt = loadSessionLastMessageSentAt();
    return {
        settings,
        settingsVersion: version,
        localSettings,
        purchases,
        profile,
        sessions: {},
        machines: {},
        projects: {},
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
        pathGitStatus: {},
        pathGitStatusFiles: {},
        pathProjectFiles: {},
        sessionFileCache: {},
        realtimeStatus: 'disconnected',
        realtimeMode: 'idle',
        voiceSessionGeneration: 0,
        socketStatus: 'disconnected',
        socketLastConnectedAt: null,
        socketLastDisconnectedAt: null,
        isDataReady: false,
        nativeUpdateStatus: null,
        unreadSessionIds: new Set<string>(),
        currentViewingSessionId: null,
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
            // Load drafts if sessions are empty (initial load)
            const isInitialLoad = Object.keys(state.sessions).length === 0;
            const savedDrafts = isInitialLoad ? sessionDrafts : {};
            const savedLastMessageSentAt = isInitialLoad ? sessionLastMessageSentAt : {};

            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = indexSessionsById(Object.values(state.sessions));

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Drafts stay device-local; missing/null means "no draft".
                const existingDraft = state.sessions[session.id]?.draft;
                const savedDraft = savedDrafts[session.id];

                // Permission / model / effort picks sync through session
                // metadata (#1492). A metadata value (including explicit
                // null = reset) wins over the local mirror, EXCEPT while an
                // optimistic push for the field is still in flight — inbound
                // events then still carry the OLD metadata, and applying it
                // would bounce the fresh local pick back. Metadata without
                // the field keeps the local value.
                const resolveModePick = (field: 'permissionMode' | 'modelMode' | 'effortLevel'): string | null => {
                    const existing = state.sessions[session.id]?.[field] ?? null;
                    if (isAgentModePushPending(session.id, field)) {
                        return existing;
                    }
                    return session.metadata && session.metadata[field] !== undefined
                        ? session.metadata[field] ?? null
                        : existing;
                };
                const resolvedPermissionMode = resolveModePick('permissionMode');
                const resolvedModelMode = resolveModePick('modelMode');
                const resolvedEffortLevel = resolveModePick('effortLevel');

                // Local activity timestamp — preserve in-memory value, else restore from MMKV.
                const resolvedLastMessageSentAt = state.sessions[session.id]?.lastMessageSentAt ?? savedLastMessageSentAt[session.id];

                mergedSessions[session.id] = {
                    ...session,
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    permissionMode: resolvedPermissionMode,
                    modelMode: resolvedModelMode,
                    effortLevel: resolvedEffortLevel,
                    lastMessageSentAt: resolvedLastMessageSentAt,
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
                // Side chats are hidden children — never in any session list.
                if (session.metadata?.isSideChat) {
                    return;
                }
                if (activeSet.has(session.id)) {
                    activeSessions.push(session);
                } else {
                    inactiveSessions.push(session);
                }
            });

            // Keep both sections in canonical chat-list order: newest activity first.
            const sortKey = getSessionActivityAt;
            activeSessions.sort((a, b) => sortKey(b) - sortKey(a));
            inactiveSessions.sort((a, b) => sortKey(b) - sortKey(a));

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

                    // Only rebuild when the reducer actually produced something.
                    //
                    // An agentState bump carries no new messages most of the
                    // time — a heartbeat, a thinking flag, a permission answer.
                    // Rebuilding the array anyway handed `messages` a fresh
                    // identity on every such tick, and `useSessionMessages`
                    // compares it by identity: that re-rendered ChatList, which
                    // re-derived displayItems and the copy-text map, which gave
                    // `renderItem` a new identity, which defeated every row's
                    // memo and re-rendered the whole window. Measured at 475
                    // renderItem calls/sec and a 525ms frame while streaming.
                    //
                    // reducerState is mutated in place and is already stored by
                    // reference, so leaving the entry untouched still carries
                    // the new agentState forward.
                    if (processedMessages.length > 0) {
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
                            hasMoreOlder: existingSessionMessages.hasMoreOlder,
                            isLoadingOlder: existingSessionMessages.isLoadingOlder
                        };
                    }

                    // IMPORTANT: Copy latestUsage from reducerState to Session for immediate availability
                    if (existingSessionMessages.reducerState.latestUsage) {
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            latestUsage: { ...existingSessionMessages.reducerState.latestUsage }
                        };
                    }
                }
            });

            // Track unread: detect when agent finishes all work for a request.
            // "Was active" = thinking or had pending permission requests.
            // "Now idle" = online, not thinking, no pending permissions.
            let unreadSessionIds = state.unreadSessionIds;
            sessions.forEach(session => {
                const oldSession = state.sessions[session.id];
                if (!oldSession) return;
                const wasActive = oldSession.thinking === true
                    || (oldSession.agentState?.requests && Object.keys(oldSession.agentState.requests).length > 0);
                const newSession = mergedSessions[session.id];
                if (!newSession || !wasActive) return;
                const isNowIdle = newSession.thinking !== true
                    && newSession.presence === 'online'
                    && (!newSession.agentState?.requests || Object.keys(newSession.agentState.requests).length === 0);
                if (isNowIdle && state.currentViewingSessionId !== session.id) {
                    if (!unreadSessionIds.has(session.id)) {
                        unreadSessionIds = new Set(unreadSessionIds);
                        unreadSessionIds.add(session.id);
                    }
                }
            });

            // Build new unified list view data
            const sessionListViewData = buildSessionListViewData(
                mergedSessions,
                unreadSessionIds,
                state.machines,
                state.projects,
            );

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData,  // Legacy - to be removed
                sessionListViewData,
                sessionMessages: updatedSessionMessages,
                unreadSessionIds,
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
                const existingSession: SessionMessages = state.sessionMessages[sessionId] || {
                    messages: [],
                    messagesMap: {},
                    reducerState: createReducer(),
                    isLoaded: false,
                    hasMoreOlder: false,
                    isLoadingOlder: false
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

            return { changed: Array.from(changed), hasReadyEvent, enteredPlanMode: shouldEnterPlanMode };
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
                            hasMoreOlder: false,
                            isLoadingOlder: false
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
        applyOlderMessagesPagination: (sessionId: string, info: { hasMore: boolean }) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) {
                // Pagination metadata is only meaningful once the session has
                // a SessionMessages entry. The fetch path always creates one
                // through applyMessages / applyMessagesLoaded before calling
                // this — but if for any reason it hasn't, ignore the update
                // rather than synthesize a partial entry.
                return state;
            }
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existing,
                        hasMoreOlder: info.hasMore
                    } satisfies SessionMessages
                }
            };
        }),
        applyOlderMessagesLoading: (sessionId: string, isLoading: boolean) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) {
                return state;
            }
            if (existing.isLoadingOlder === isLoading) {
                return state;
            }
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existing,
                        isLoadingOlder: isLoading
                    } satisfies SessionMessages
                }
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
        applyGitStatus: (pathKey: string, status: GitStatus | null) => set((state) => ({
            ...state,
            pathGitStatus: {
                ...state.pathGitStatus,
                [pathKey]: status
            }
        })),
        applyGitStatusFiles: (pathKey: string, files: GitStatusFiles | null) => set((state) => {
            // Short-circuit on no-op writes. gitStatusSync.invalidate fires on every
            // mutable-tool message and on every update-session, but most of those
            // don't actually change the file set. Without this guard, every fetch
            // produces a fresh object reference, the useSessionGitStatusFiles
            // subscription fires, and AllFilesDiffView nukes its scroll position
            // and re-runs every git diff. fast-deep-equal handles arrays + nested
            // objects so we don't have to enumerate fields.
            if (equal(state.pathGitStatusFiles[pathKey] ?? null, files)) {
                return state;
            }
            return {
                ...state,
                pathGitStatusFiles: {
                    ...state.pathGitStatusFiles,
                    [pathKey]: files
                }
            };
        }),
        applyProjectFiles: (pathKey: string, files: ProjectFilesList | null) => set((state) => ({
            ...state,
            pathProjectFiles: {
                ...state.pathProjectFiles,
                [pathKey]: files
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
                sessionListViewData: buildSessionListViewData(updatedSessions, state.unreadSessionIds, state.machines, state.projects)
            };
        }),
        // Permission / model / effort picks are local mirrors of synced session
        // metadata (#1492). Use sessionSetAgentModes from ops.ts to change them —
        // it calls this for the optimistic update and pushes the pick to the server.
        updateSessionAgentModes: (sessionId: string, patch: SessionAgentModesPatch) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // No need to rebuild sessionListViewData since mode picks don't affect the list display
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        ...(patch.permissionMode !== undefined && { permissionMode: patch.permissionMode }),
                        ...(patch.modelMode !== undefined && { modelMode: patch.modelMode }),
                        ...(patch.effortLevel !== undefined && { effortLevel: patch.effortLevel }),
                    }
                }
            };
        }),
        markSessionMessageSent: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    lastMessageSentAt: Date.now()
                }
            };

            // Persist so activity ordering survives app restart.
            const allTimestamps: Record<string, number> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.lastMessageSentAt) {
                    allTimestamps[id] = sess.lastMessageSentAt;
                }
            });
            saveSessionLastMessageSentAt(allTimestamps);

            // Rebuild list view data — this timestamp drives activity-based sort.
            // Pass unreadSessionIds so other sessions keep their unread badges
            // (omitting it drops every badge until the next rebuild).
            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData: buildSessionListViewData(updatedSessions, state.unreadSessionIds, state.machines, state.projects)
            };
        }),
        getSessionPathKey: (sessionId: string): string | null => {
            const session = get().sessions[sessionId];
            if (!session?.metadata?.machineId || !session?.metadata?.path) return null;
            return `${session.metadata.machineId}:${session.metadata.path}`;
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

            // Rebuild sessionListViewData to reflect machine changes — from the
            // merged map, since a machine going offline is exactly what has to
            // reach the rows here.
            const sessionListViewData = buildSessionListViewData(
                state.sessions,
                state.unreadSessionIds,
                mergedMachines,
                state.projects,
            );

            return {
                ...state,
                machines: mergedMachines,
                sessionListViewData
            };
        }),
        applyProjects: (projects: Project[], replace: boolean = false) => set((state) => {
            const mergedProjects: Record<string, Project> = replace ? {} : { ...state.projects };
            projects.forEach((project) => {
                mergedProjects[project.id] = project;
            });
            return {
                ...state,
                projects: mergedProjects,
                sessionListViewData: buildSessionListViewData(
                    state.sessions,
                    state.unreadSessionIds,
                    state.machines,
                    mergedProjects,
                ),
            };
        }),
        applyProjectAvatar: (projectId: string, avatar: Project['avatar']) => set((state) => {
            const project = state.projects[projectId];
            if (!project) return state;
            const projects = {
                ...state.projects,
                [projectId]: { ...project, avatar },
            };
            return {
                ...state,
                projects,
                sessionListViewData: buildSessionListViewData(
                    state.sessions,
                    state.unreadSessionIds,
                    state.machines,
                    projects,
                ),
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
                sessionListViewData: buildSessionListViewData(state.sessions, state.unreadSessionIds, remaining, state.projects)
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
            
            const { [sessionId]: _fileCache, ...remainingFileCache } = state.sessionFileCache;

            // Clear local session data from persistent storage (permission / model / effort
            // picks live in synced session metadata, #1492)
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);

            const lastMessageSentAt = loadSessionLastMessageSentAt();
            delete lastMessageSentAt[sessionId];
            saveSessionLastMessageSentAt(lastMessageSentAt);

            // Rebuild sessionListViewData without the deleted session.
            // Pass unreadSessionIds so the remaining sessions keep their unread badges.
            const sessionListViewData = buildSessionListViewData(remainingSessions, state.unreadSessionIds, state.machines, state.projects);
            
            return {
                ...state,
                sessions: remainingSessions,
                sessionMessages: remainingSessionMessages,
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
        markSessionRead: (sessionId: string) => set((state) => {
            if (!state.unreadSessionIds.has(sessionId)) return state;
            const next = new Set(state.unreadSessionIds);
            next.delete(sessionId);
            return {
                ...state,
                unreadSessionIds: next,
                sessionListViewData: buildSessionListViewData(state.sessions, next, state.machines, state.projects),
            };
        }),
        markSessionUnread: (sessionId: string) => set((state) => {
            if (state.unreadSessionIds.has(sessionId)) return state;
            const next = new Set(state.unreadSessionIds);
            next.add(sessionId);
            return {
                ...state,
                unreadSessionIds: next,
                sessionListViewData: buildSessionListViewData(state.sessions, next, state.machines, state.projects),
            };
        }),
        setCurrentViewingSession: (sessionId: string | null) => set((state) => {
            if (state.currentViewingSessionId === sessionId) return state;
            // If switching to a new session, mark it as read
            const next = sessionId && state.unreadSessionIds.has(sessionId)
                ? (() => { const s = new Set(state.unreadSessionIds); s.delete(sessionId); return s; })()
                : state.unreadSessionIds;
            return {
                ...state,
                currentViewingSessionId: sessionId,
                unreadSessionIds: next,
                ...(next !== state.unreadSessionIds ? {
                    sessionListViewData: buildSessionListViewData(state.sessions, next, state.machines, state.projects),
                } : {}),
            };
        }),
    }
});

export function useSessions() {
    return storage(useShallow((state) => state.isDataReady ? state.sessionsData : null));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

export function useProjects(): Record<string, Project> {
    return storage(useShallow((state) => state.projects));
}

export function useSessionProjectAvatar(sessionId: string): Project['avatar'] {
    return storage(useShallow((state) => {
        const session = state.sessions[sessionId];
        if (!session || !isHappyAgentSession(session)) return null;
        const projectId = getSessionProjectId(session);
        return projectId ? state.projects[projectId]?.avatar ?? null : null;
    }));
}

/**
 * Resolve the live "side chat" sessions belonging to a given parent session.
 * A side chat is a forked child flagged `metadata.isSideChat` whose
 * `metadata.parentSessionId` points at the parent. A parent can have several;
 * closing one archives it (`lifecycleState === 'archived'`), which drops it
 * from this list so the sidebar panel only shows open side chats. Sorted
 * oldest-first so tab order stays stable as new ones are created. Empty when
 * none are open (the panel then offers to start one).
 */
export function useSideChatSessions(parentSessionId: string | null): Session[] {
    return storage(useShallow((state) => {
        if (!parentSessionId) {
            return emptyArray as Session[];
        }
        const result: Session[] = [];
        for (const session of Object.values(state.sessions)) {
            if (
                session.metadata?.isSideChat
                && session.metadata?.parentSessionId === parentSessionId
                && session.metadata?.lifecycleState !== 'archived'
            ) {
                result.push(session);
            }
        }
        if (result.length === 0) {
            return emptyArray as Session[];
        }
        result.sort((a, b) => a.createdAt - b.createdAt);
        return result;
    }));
}

const emptyArray: unknown[] = [];

export function useSessionMessages(sessionId: string): {
    messages: Message[],
    isLoaded: boolean,
    hasMoreOlder: boolean,
    isLoadingOlder: boolean
} {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return {
            messages: session?.messages ?? emptyArray,
            isLoaded: session?.isLoaded ?? false,
            hasMoreOlder: session?.hasMoreOlder ?? false,
            isLoadingOlder: session?.isLoadingOlder ?? false
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
        // Side chats are hidden children — exclude them from every list.
        return Object.values(state.sessions)
            .filter((s) => !s.metadata?.isSideChat)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(name: K): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const setValue = React.useCallback((value: LocalSettings[K]) => {
        storage.getState().applyLocalSettings({ [name]: value });
    }, [name]);
    const value = useLocalSetting(name);
    return [value, setValue];
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    return storage(useShallow((state) => state.localSettings[name]));
}

export function useIsSessionUnread(sessionId: string): boolean {
    return storage((state) => state.unreadSessionIds.has(sessionId));
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

/**
 * Agent-to-user communications this session is currently waiting on.
 *
 * Deep-equal, not shallow: this selector mints a fresh object per pending
 * communication on every call, and shallow compares those elements by identity.
 * Under `useShallow` a session with even one pending request therefore reports a
 * changed snapshot on every read, which re-renders, which reads again — the
 * render loop that used to crash any session holding a question. An empty list
 * shallow-compares equal, which is why only sessions with a live request fell
 * over.
 */
export function useSessionPendingCommunications(sessionId: string): PendingAgentCommunication[] {
    return storage(useDeepEqual((state) =>
        selectPendingCommunications(state.sessions[sessionId]?.agentState ?? null)));
}

/**
 * Agent form joined to one transcript tool call, pending or completed.
 *
 * Deep-equal for the same reason as the hook above: the selection is a fresh
 * object whose `questions` is a fresh array, so shallow compares those by
 * identity and never settles.
 */
export function useSessionAgentFormCommunication(sessionId: string, toolUseId: string) {
    return storage(useDeepEqual((state) =>
        selectAgentFormCommunication(state.sessions[sessionId]?.agentState ?? null, toolUseId)));
}

export function useSessionGitStatus(sessionId: string): GitStatus | null {
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(sessionId);
        return pathKey ? state.pathGitStatus[pathKey] ?? null : null;
    }));
}

export function useSessionGitStatusFiles(sessionId: string): GitStatusFiles | null {
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(sessionId);
        return pathKey ? state.pathGitStatusFiles[pathKey] ?? null : null;
    }));
}

export function useSessionProjectFiles(sessionId: string): ProjectFilesList | null {
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(sessionId);
        return pathKey ? state.pathProjectFiles[pathKey] ?? null : null;
    }));
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
