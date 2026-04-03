import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import { Session, Machine, GitStatus } from "./storageTypes";
import {
    type MessageID,
    type SessionID,
    type SessionMessage,
    type SessionState as SyncNodeSessionState,
    type Todo,
} from '@slopus/happy-sync';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Purchases, customerInfoToPurchases } from "./purchases";
import { Profile } from "./profile";
import { UserProfile, RelationshipUpdatedEvent } from "./friendTypes";
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadPurchases, savePurchases, loadProfile, saveProfile, loadSessionDrafts, saveSessionDrafts, loadSessionPermissionModes, saveSessionPermissionModes } from "./persistence";
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import type { CustomerInfo } from './revenueCat/types';
import React from "react";
import { sync } from "./sync";
import { type AppSessionToolUseRef } from './syncNodeStore';
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import { isMutableTool } from "@/components/tools/knownTools";
import { projectManager } from "./projectManager";
import { DecryptedArtifact } from "./artifactTypes";
import { FeedItem } from "./feedTypes";

// Debounce timer for realtimeMode changes
let realtimeModeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REALTIME_MODE_DEBOUNCE_MS = 150;

// Track which permission IDs we've already notified the voice assistant about
const notifiedPermissionIds = new Set<string>();

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

// Unified list item type for SessionsList component
export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: Session[] }
    | { type: 'project-group'; displayPath: string; machine: Machine }
    | { type: 'session'; session: Session; variant?: 'default' | 'no-path' };

interface StorageState {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    profile: Profile;
    sessions: Record<string, Session>;
    sessionListViewData: SessionListViewItem[] | null;
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
    realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    realtimeMode: 'idle' | 'speaking';
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    isDataReady: boolean;
    nativeUpdateStatus: { available: boolean; updateUrl?: string } | null;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    applyProfile: (profile: Profile) => void;
    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setRealtimeMode: (mode: 'idle' | 'speaking', immediate?: boolean) => void;
    clearRealtimeModeDebounce: () => void;
    setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    updateSessionPermissionMode: (sessionId: string, mode: string) => void;
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

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let purchases = loadPurchases();
    let profile = loadProfile();
    let sessionDrafts = loadSessionDrafts();
    let sessionPermissionModes = loadSessionPermissionModes();
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
        sessionListViewData: null,
        sessionGitStatus: {},
        realtimeStatus: 'disconnected',
        realtimeMode: 'idle',
        socketStatus: 'disconnected',
        socketLastConnectedAt: null,
        socketLastDisconnectedAt: null,
        isDataReady: false,
        nativeUpdateStatus: null,
        isMutableToolCall: (sessionId: string, callId: string) => {
            const messages = sync.appSyncStore?.getMessages(sessionId as SessionID) ?? [];
            for (const msg of messages) {
                if (typeof msg !== 'object' || !('Agent' in msg)) {
                    continue;
                }

                for (const content of msg.Agent.content) {
                    if ('ToolUse' in content && content.ToolUse.id === callId) {
                        return isMutableTool(content.ToolUse.name);
                    }
                }
            }
            return true;
        },
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => set((state) => {
            // Load drafts and permission modes if sessions are empty (initial load)
            const savedDrafts = Object.keys(state.sessions).length === 0 ? sessionDrafts : {};
            const savedPermissionModes = Object.keys(state.sessions).length === 0 ? sessionPermissionModes : {};

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

                mergedSessions[session.id] = {
                    ...session,
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    permissionMode: resolvedPermissionMode
                };
            });

            // Check for NEW permission requests from SyncNode and notify voice assistant
            sessions.forEach(session => {
                const currentRealtimeSessionId = getCurrentRealtimeSessionId();
                const voiceSession = getVoiceSession();
                if (currentRealtimeSessionId !== session.id || !voiceSession) return;

                const syncSession = sync.appSyncStore?.getSession(session.id as SessionID);
                if (!syncSession) return;

                for (const perm of syncSession.permissions) {
                    if (!perm.resolved && !notifiedPermissionIds.has(perm.permissionId)) {
                        notifiedPermissionIds.add(perm.permissionId);
                        voiceSession.sendTextMessage(
                            `Claude is requesting permission to use the ${perm.block.permission} tool`
                        );
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
                sessionListViewData,
            };
        }),
        applyLoaded: () => set((state) => state),
        applyReady: () => set((state) => ({
            ...state,
            isDataReady: true
        })),
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
        applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => set((state) => ({
            ...state,
            nativeUpdateStatus: status
        })),
        setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => ({
            ...state,
            realtimeStatus: status
        })),
        setRealtimeMode: (mode: 'idle' | 'speaking', immediate?: boolean) => {
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
                state.sessions
            );

            return {
                ...state,
                machines: mergedMachines,
                sessionListViewData
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
            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;
            const { [sessionId]: deletedGitStatus, ...remainingGitStatus } = state.sessionGitStatus;

            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);

            const modes = loadSessionPermissionModes();
            delete modes[sessionId];
            saveSessionPermissionModes(modes);

            const sessionListViewData = buildSessionListViewData(remainingSessions);

            return {
                ...state,
                sessions: remainingSessions,
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

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptySessionMessages: SessionMessage[] = [];
const emptyTodoArray: Todo[] = [];

function subscribeToAppSyncStore(onStoreChange: () => void): () => void {
    return sync.appSyncStore?.subscribeStore(onStoreChange) ?? (() => {});
}

export function useSessionMessages(sessionId: string): { messages: SessionMessage[], isLoaded: boolean } {
    const cacheRef = React.useRef<{
        version: number;
        messages: SessionMessage[];
        isLoaded: boolean;
        snapshot: { messages: SessionMessage[]; isLoaded: boolean };
    } | null>(null);

    return React.useSyncExternalStore(
        subscribeToAppSyncStore,
        () => {
            const store = sync.appSyncStore;
            const version = store?.getSessionMessagesVersion(sessionId as SessionID) ?? 0;
            const messages = store?.getMessages(sessionId as SessionID) ?? emptySessionMessages;
            const isLoaded = store?.isSessionLoaded(sessionId as SessionID) ?? false;
            const cached = cacheRef.current;

            if (cached && cached.version === version && cached.messages === messages && cached.isLoaded === isLoaded) {
                return cached.snapshot;
            }

            const snapshot = { messages, isLoaded };
            cacheRef.current = { version, messages, isLoaded, snapshot };
            return snapshot;
        },
        () => ({ messages: emptySessionMessages, isLoaded: false }),
    );
}

export function useSessionMessage(sessionId: string, messageId: string): SessionMessage | null {
    const cacheRef = React.useRef<{
        version: number;
        value: SessionMessage | null;
        snapshot: { version: number; value: SessionMessage | null };
    } | null>(null);

    const snapshot = React.useSyncExternalStore(
        subscribeToAppSyncStore,
        () => {
            const store = sync.appSyncStore;
            const version = store?.getMessageVersion(sessionId as SessionID, messageId as MessageID) ?? 0;
            const value = store?.getMessage(sessionId as SessionID, messageId as MessageID) ?? null;
            const cached = cacheRef.current;

            if (cached && cached.version === version && cached.value === value) {
                return cached.snapshot;
            }

            const nextSnapshot = { version, value };
            cacheRef.current = { version, value, snapshot: nextSnapshot };
            return nextSnapshot;
        },
        () => ({ version: 0, value: null }),
    );

    return snapshot.value;
}

export function useSessionToolUse(sessionId: string, messageId: string, toolUseId: string | undefined): AppSessionToolUseRef | null {
    const cacheRef = React.useRef<{
        version: number;
        value: AppSessionToolUseRef | null;
        snapshot: { version: number; value: AppSessionToolUseRef | null };
    } | null>(null);

    const snapshot = React.useSyncExternalStore(
        subscribeToAppSyncStore,
        () => {
            const store = sync.appSyncStore;
            const version = store?.getMessageVersion(sessionId as SessionID, messageId as MessageID) ?? 0;
            const value = store?.getToolUse(
                sessionId as SessionID,
                messageId as MessageID,
                toolUseId,
            ) ?? null;
            const cached = cacheRef.current;

            if (cached && cached.version === version && cached.value === value) {
                return cached.snapshot;
            }

            const nextSnapshot = { version, value };
            cacheRef.current = { version, value, snapshot: nextSnapshot };
            return nextSnapshot;
        },
        () => ({ version: 0, value: null }),
    );

    return snapshot.value;
}

export function useSyncSessionState(sessionId: string): SyncNodeSessionState | null {
    const cacheRef = React.useRef<{
        version: number;
        value: SyncNodeSessionState | null;
        snapshot: { version: number; value: SyncNodeSessionState | null };
    } | null>(null);

    const snapshot = React.useSyncExternalStore(
        subscribeToAppSyncStore,
        () => {
            const store = sync.appSyncStore;
            const version = store?.getSessionStateVersion(sessionId as SessionID) ?? 0;
            const value = store?.getSession(sessionId as SessionID) ?? null;
            const cached = cacheRef.current;

            if (cached && cached.version === version && cached.value === value) {
                return cached.snapshot;
            }

            const nextSnapshot = { version, value };
            cacheRef.current = { version, value, snapshot: nextSnapshot };
            return nextSnapshot;
        },
        () => ({ version: 0, value: null }),
    );

    return snapshot.value;
}

export function useSyncSessionTodos(sessionId: string): Todo[] {
    return useSyncSessionState(sessionId)?.todos ?? emptyTodoArray;
}

export function useV3SessionMessages(sessionId: string): { messages: SessionMessage[], isLoaded: boolean } {
    return useSessionMessages(sessionId);
}

export function useV3Message(sessionId: string, messageId: string): SessionMessage | null {
    return useSessionMessage(sessionId, messageId);
}

export function useV3ToolPart(sessionId: string, messageId: string, partId: string | undefined): AppSessionToolUseRef | null {
    return useSessionToolUse(sessionId, messageId, partId);
}

export function useSyncPendingPermissionCount(sessionId: string): number {
    const session = useSyncSessionState(sessionId);
    return session?.permissions.filter((permission) => !permission.resolved).length ?? 0;
}

export function useAnyOnlineSyncSessionHasPendingPermissions(sessionIds: string[]): boolean {
    return React.useSyncExternalStore(
        subscribeToAppSyncStore,
        () => {
            const store = sync.appSyncStore;
            if (!store) {
                return false;
            }

            return sessionIds.some((sessionId) => {
                const session = store.getSession(sessionId as SessionID);
                return Boolean(session?.permissions.some((permission) => !permission.resolved));
            });
        },
        () => false,
    );
}

export function useSessionUsage(sessionId: string) {
    return storage(useShallow((state) => {
        return state.sessions[sessionId]?.latestUsage ?? null;
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

export function useRealtimeMode(): 'idle' | 'speaking' {
    return storage(useShallow((state) => state.realtimeMode));
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
