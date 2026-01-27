import { create } from "zustand";
import type { DiscardedPendingMessage, GitStatus, Machine, PendingMessage, Session } from "./storageTypes";
import type { Settings } from "./settings";
import type { LocalSettings } from "./localSettings";
import type { Purchases } from "./purchases";
import type { TodoState } from "../-zen/model/ops";
import type { Profile } from "./profile";
import type { RelationshipUpdatedEvent, UserProfile } from "./friendTypes";
import type { CustomerInfo } from './revenueCat/types';
import type { DecryptedArtifact } from "./artifactTypes";
import type { FeedItem } from "./feedTypes";
import type { SessionListViewItem } from './sessionListViewData';
import type { NormalizedMessage } from "./typesRaw";
import { createArtifactsDomain } from './store/domains/artifacts';
import { createFeedDomain } from './store/domains/feed';
import { createFriendsDomain } from './store/domains/friends';
import { createMachinesDomain } from './store/domains/machines';
import { createMessagesDomain, type SessionMessages } from './store/domains/messages';
import { createProfileDomain } from './store/domains/profile';
import { createPendingDomain, type SessionPending } from './store/domains/pending';
import { createRealtimeDomain, type NativeUpdateStatus, type RealtimeMode, type RealtimeStatus, type SocketStatus, type SyncError } from './store/domains/realtime';
import { createSettingsDomain } from './store/domains/settings';
import { createSessionsDomain } from './store/domains/sessions';
import { createTodosDomain } from './store/domains/todos';

// Known entitlement IDs
export type KnownEntitlements = 'pro';

type SessionModelMode = NonNullable<Session['modelMode']>;

// Machine type is now imported from storageTypes - represents persisted machine data

export type { SessionListViewItem } from './sessionListViewData';

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

export const storage = create<StorageState>()((set, get) => {
    const settingsDomain = createSettingsDomain<StorageState>({ set, get });
    const profileDomain = createProfileDomain<StorageState>({ set, get });
    const todosDomain = createTodosDomain<StorageState>({ set, get });
    const machinesDomain = createMachinesDomain<StorageState>({ set, get });
    const sessionsDomain = createSessionsDomain<StorageState>({ set, get });
    const pendingDomain = createPendingDomain<StorageState>({ set, get });
    const messagesDomain = createMessagesDomain<StorageState>({ set, get });
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
        ...pendingDomain,
        ...messagesDomain,
        ...realtimeDomain,
    }
});

export function getStorage() {
    return storage;
}

export * from './store/hooks';
