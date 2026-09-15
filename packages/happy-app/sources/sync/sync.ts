import type { HistoryViewportReader, HistoryViewportRange } from './historyWindowPolicy';
import Constants from 'expo-constants';
import { refreshNativeUpdateStatus } from './nativeUpdate';
import type { PluginCatalogResponse } from '@slopus/happy-wire';
import { SessionStreamEnvelopeSchema } from '@slopus/happy-wire';
import { sessionTextStream } from './sessionTextStream';
import { apiSocket, getCurrentAppState, getHappyClientId } from '@/sync/apiSocket';
import { notifyUnreadMessage } from '@/sync/webTabTitle';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { storage } from './storage';
import { ApiEphemeralUpdateSchema, ApiMessage, ApiUpdateContainerSchema, type ApiSessionSnapshot, type ApiUpdate } from './apiTypes';
import type { ApiEphemeralActivityUpdate } from './apiTypes';
import { Session, Machine } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { syncCurrentPushToken } from './pushRegistration';
import { Platform, AppState, type AppStateStatus } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { NormalizedMessage, normalizeRawMessage, RawRecord } from './typesRaw';
import {
    applySettings,
    mergeServerSettings,
    mergeSessionPinnedOrders,
    isValidSessionPinnedOrderPayload,
    resolveSessionPinnedOrderMigration,
    resolveSidebarOrganizationMigration,
    Settings,
    settingsDefaults,
    settingsParse,
    settingsToSyncPayload,
    SUPPORTED_SCHEMA_VERSION,
} from './settings';
import { Profile, profileParse } from './profile';
import {
    clearLegacySessionPinnedOrder,
    loadLegacySessionPinnedOrder,
    loadPendingSessionPinnedState,
    loadPendingSettings,
    loadPendingSidebarOrganizationBase,
    recoverPendingSettingsWithPinnedState,
    savePendingSessionPinnedState,
    savePendingSettings,
    savePendingSidebarOrganizationBase,
} from './persistence';
import {
    emptySidebarOrganization,
    isSidebarOrganizationEmpty,
    isUsableSidebarOrganizationPayload,
    isValidSidebarOrganizationPayload,
    mergeSidebarOrganizations,
    removeSidebarSession,
} from './sidebarOrganization';
import {
    initializeTracking,
    trackGitHubConnected,
    trackMessageSent,
    tracking,
    trackPaywallCancelled,
    trackPaywallError,
    trackPaywallPresented,
    trackPaywallPurchased,
    trackPaywallRestored,
} from '@/track';
import type { MessageSentSource } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { RevenueCat, LogLevel, PaywallResult } from './revenueCat';
import { getServerUrl } from './serverConfig';
import { setFirstSubmissionScope } from './firstSubmissionScope';
import { config } from '@/config';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { resyncOnForeground } from './foregroundResync';
import { AsyncLock } from '@/utils/lock';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { Message } from './typesMessage';
import { EncryptionCache } from './encryption/encryptionCache';
import { systemPrompt } from './prompt/systemPrompt';
import { fetchArtifact, fetchArtifacts, createArtifact, updateArtifact } from './apiArtifacts';
import { DecryptedArtifact, Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from './artifactTypes';
import { ArtifactEncryption } from './encryption/artifactEncryption';
import { fetchFeed } from './apiFeed';
import { FeedItem } from './feedTypes';
import {
    getInitialSessionEventLocalNotificationsEnabled,
    maybeScheduleSessionEventLocalNotification,
    shouldEnableSessionEventLocalNotifications,
} from './sessionEventLocalNotification';
import { resolveMessageModeMeta } from './messageMeta';
import type { AttachmentPreview, UploadedAttachment } from './attachmentTypes';
import { requestAttachmentUpload, uploadEncryptedBlob } from './apiAttachments';
import { uploadMediaFile } from './uploadMediaFile';
import { encryptBlob } from '@/encryption/blob';
import { readFileBytes } from '@/utils/readFileBytes';
import { uploadAttachmentForSession } from './uploadAttachmentForSession';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { SessionApplyOptions } from './sessionApply';
import { deriveSessionFallbackTitle, ensureSessionFallbackTitle } from './sessionFallbackTitle';
import { getPluginCatalog } from './plugins';
import { shouldMarkSessionEventUnread } from '@/utils/sessionAttentionBadge';
import { PluginCatalogStore, type PluginCatalogSnapshot } from './pluginCatalogStore';
import {
    fetchActiveSessionSnapshots,
    fetchLegacySessionSnapshots,
    fetchSessionSnapshot,
    fetchSessionSnapshotPage,
} from './apiSessions';
import { useSessionListSyncState } from './sessionListSyncState';
import {
    hydrateSessionSnapshotForRoute,
    type HydratedSession,
} from './sessionSnapshotHydration';
import {
    SessionMessageLoadGate,
    type SessionMessageLease,
    type SessionMessageLoadOperation,
} from './sessionMessageLoadGate';
import { SessionMessageRetention } from './sessionMessageRetention';
import { applyLatestRange, applyOlderRange, type MessageRange, type MessageRangeFrontier } from './sessionMessageFrontier';
import { SessionRouteOwnership, SessionRouteAbandonedError, SessionRouteCoordinationError, type SessionRouteOwner } from './sessionRouteOwnership';
import { sessionStartupTraceRuntime } from './sessionStartupTraceRuntime';
import { openLocalHistory, clearLocalHistoryCaches, subscribeLocalHistoryInvalidation, invalidateLocalHistorySession, type LocalHistory, type HistoryWindow, type HistoryPage, type ReadingState } from './localHistoryStore';
import { boundHistoryWindow, historyWindowBytes, WEB_HISTORY_MAX_MESSAGES, WEB_HISTORY_MAX_BYTES } from './historyWindowPolicy';
import { sessionHistoryPageCache } from './sessionHistoryPageCache';
import { SessionHistoryPrefetch } from './sessionHistoryPrefetch';
import { fetchSessionChanges } from './apiSessionChanges';
import { reconcileSessionHistory } from './sessionHistoryReconciliation';
import { createReducer, reducer } from './reducer/reducer';
import { markSessionCriticalPathAppStage, markSessionCriticalPathHydrationRetry } from './sessionCriticalPathProbeBridge';
import {
    appendSessionWarmMessages,
    createSessionWarmCacheAccountKey,
    loadSessionWarmCache,
    removeSessionFromWarmCache,
    saveSessionWarmLatestPage,
    saveSessionWarmSnapshots,
    touchSessionWarmLatestPage,
    clearSessionWarmCache,
} from './sessionWarmCache';

type V3GetSessionMessagesResponse = {
    messages: ApiMessage[];
    hasMore: boolean;
    localWindow?: HistoryWindow;
    revalidateTail?: boolean;
    // Local-only ownership stamp, captured before HTTP starts.
    nativeCacheGeneration?: object;
};

type SessionOpenResolution = 'ready' | 'not-found';
function memoryHistoryPage(current: HistoryWindow | undefined, page: V3GetSessionMessagesResponse,
    direction: 'older' | 'newer' | 'latest', limit = 300): HistoryWindow {
    const combined = direction === 'latest' ? page.messages : [...(current?.messages ?? []), ...page.messages];
    const unique = [...new Map(combined.map(message => [message.seq, message])).values()].sort((a, b) => a.seq - b.seq);
    const messages = direction === 'older' ? unique.slice(0, limit) : unique.slice(-limit);
    return { messages, oldestSeq: messages[0]?.seq ?? null, newestSeq: messages.at(-1)?.seq ?? null,
        hasMoreOlder: direction === 'older' ? page.hasMore : direction === 'latest' ? page.hasMore || unique.length > limit : (current?.hasMoreOlder ?? false) || unique.length > limit,
        hasMoreNewer: direction === 'older' ? (current?.hasMoreNewer ?? false) || unique.length > limit : direction === 'newer' && page.hasMore,
        isAtLatest: direction === 'latest' || (direction === 'older' ? current?.isAtLatest === true && unique.length <= limit : !page.hasMore),
    };
}
const historyNavigationWindowLimit = () => Platform.OS === 'web' ? WEB_HISTORY_MAX_MESSAGES : 300;
function retainMissingHistoryRows(window: HistoryWindow, current: HistoryWindow | undefined): HistoryWindow {
    if (!current) return window;
    const knownSeqs = new Set(window.messages.map(message => message.seq));
    const missing = current.messages.filter(message => !knownSeqs.has(message.seq));
    if (missing.length === 0) return window;
    const overlaps = current.messages.some(message => knownSeqs.has(message.seq));
    // A restored reading window and a separately fetched latest window can be
    // two disconnected islands. Flattening them into one HistoryWindow lies
    // about the missing middle: both boundary flags can become exhausted even
    // though thousands of cached rows remain unreachable. Keep the historical
    // island authoritative until explicit newer navigation connects it. A
    // latest-following window may instead accept the new authoritative island.
    if (!overlaps) return current.isAtLatest ? window : current;
    const messages = [...window.messages, ...missing].sort((a, b) => a.seq - b.seq);
    const extendsOlder = (current.oldestSeq ?? Infinity) < (window.oldestSeq ?? Infinity);
    const extendsNewer = (current.newestSeq ?? 0) > (window.newestSeq ?? 0);
    return { ...window, messages, oldestSeq: messages[0]?.seq ?? null, newestSeq: messages.at(-1)?.seq ?? null,
        hasMoreOlder: extendsOlder ? current.hasMoreOlder : window.hasMoreOlder,
        hasMoreNewer: extendsNewer ? current.hasMoreNewer : window.hasMoreNewer,
        isAtLatest: extendsNewer ? current.isAtLatest : window.isAtLatest };
}
type SessionOpenPromise = Promise<SessionOpenResolution>;
type SessionRouteOperation = {
    sessionId: string;
    owner: SessionRouteOwner;
    cancelled: boolean;
    messageLease: SessionMessageLease;
    messageLoad: SessionMessageLoadOperation;
    latestPage: Promise<V3GetSessionMessagesResponse>;
    foregroundTarget: number;
    committedPageSeq: number | null;
    committedPageOperation: SessionMessageLoadOperation | null;
};

class CoalescingMessageSync {
    private readonly sync: InvalidateSync;
    private inFlight: Promise<void> | null = null;
    private desiredTargetSeq: number | null = null;
    private stopped = false;

    constructor(
        readonly lease: SessionMessageLease,
        command: () => Promise<void>,
        private readonly getCurrentSeq: () => number | null,
        private readonly isLeaseCurrent: () => boolean,
    ) {
        this.sync = new InvalidateSync(command);
    }

    invalidate(targetSeq?: number): void {
        void this.invalidateAndAwait(targetSeq);
    }

    invalidateAndAwait(targetSeq?: number): Promise<void> {
        if (targetSeq !== undefined) {
            this.desiredTargetSeq = Math.max(this.desiredTargetSeq ?? targetSeq, targetSeq);
        }
        if (this.inFlight) return this.inFlight;
        const pending = this.runUntilTargetOrStalled().finally(() => {
            if (this.inFlight === pending) this.inFlight = null;
        });
        this.inFlight = pending;
        return pending;
    }

    awaitQueue(): Promise<void> {
        return this.inFlight ?? this.sync.awaitQueue();
    }

    stop(): void {
        this.stopped = true;
        this.desiredTargetSeq = null;
        this.sync.stop();
    }

    private async runUntilTargetOrStalled(): Promise<void> {
        while (!this.stopped && this.isLeaseCurrent()) {
            const previousSeq = this.getCurrentSeq();
            await this.sync.invalidateAndAwait();
            if (this.stopped || !this.isLeaseCurrent()) {
                this.desiredTargetSeq = null;
                return;
            }

            const targetSeq = this.desiredTargetSeq;
            if (targetSeq === null) return;
            const currentSeq = this.getCurrentSeq();
            if (currentSeq !== null && currentSeq >= targetSeq) {
                this.desiredTargetSeq = null;
                return;
            }
            if (currentSeq === null || (previousSeq !== null && currentSeq <= previousSeq)) {
                return;
            }
        }
        this.desiredTargetSeq = null;
    }
}

// Sentinel used as `before_seq` for the very first backward fetch of a
// session. It must exceed any real `seq` value the server can produce.
// `seq` is stored as Postgres int4 on the server, so the maximum is
// 2_147_483_647. We use that exact upper bound to keep the request safely
// within int4 while still being effectively "infinite" for any session.
const SEQ_BACKWARD_INITIAL_SENTINEL = 2_147_483_647;
const INITIAL_ACTIVE_SESSION_LIMIT = 25;
const INITIAL_LATEST_MESSAGE_LIMIT = 25;

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

type OutboxMessage = {
    localId: string;
    content: string;
};

type SendMessageOptions = {
    /** Fence a route-independent submission against logout or server changes. */
    isCurrent?: () => boolean;
    displayText?: string;
    editedFromMessageId?: string;
    source?: MessageSentSource;
    /** Optional image attachments to send before the text message. */
    attachments?: AttachmentPreview[];
};

export type LocalMessageQueueReceipt = {
    type: 'queued';
    sessionId: string;
    localIds: readonly string[];
};

type SessionMessageCacheGeneration = {
    localMessageIds?: Map<string, string>;
    // Receipt provenance outlives the optimistic display overlay so a
    // same-generation projection retry can recover exactly what was accepted.
    acceptedLocalMessages?: Map<string, NormalizedMessage>;
    // Only rows not yet observed from the server belong in a replacement's
    // optimistic overlay. Exact echoes retire this map, never the receipt.
    pendingLocalMessages?: Map<string, NormalizedMessage>;
};

function stripNewSessionDiscriminator(
    update: Extract<ApiUpdate, { t: 'new-session' }>,
): ApiSessionSnapshot {
    const { t: _type, ...snapshot } = update;
    return snapshot;
}

function deduplicateSessionSnapshots(snapshots: ApiSessionSnapshot[]): ApiSessionSnapshot[] {
    const byId = new Map<string, ApiSessionSnapshot>();
    for (const snapshot of snapshots) {
        const existing = byId.get(snapshot.id);
        if (!existing) {
            byId.set(snapshot.id, snapshot);
            continue;
        }

        const newest = snapshot.seq > existing.seq
            || (snapshot.seq === existing.seq && snapshot.updatedAt >= existing.updatedAt)
            ? snapshot
            : existing;
        const older = newest === snapshot ? existing : snapshot;
        const newestMetadata = snapshot.metadataVersion >= existing.metadataVersion ? snapshot : existing;
        const newestAgentState = snapshot.agentStateVersion >= existing.agentStateVersion ? snapshot : existing;
        byId.set(snapshot.id, {
            ...newest,
            metadata: newestMetadata.metadata,
            metadataVersion: newestMetadata.metadataVersion,
            agentState: newestAgentState.agentState,
            agentStateVersion: newestAgentState.agentStateVersion,
            dataEncryptionKey: newest.dataEncryptionKey ?? older.dataEncryptionKey,
        });
    }
    return [...byId.values()];
}

function mergeHydratedSessions(sessions: HydratedSession[]): HydratedSession {
    let merged = sessions[0];
    for (let index = 1; index < sessions.length; index += 1) {
        const candidate = sessions[index];
        const base = candidate.updatedAt > merged.updatedAt
            || (candidate.updatedAt === merged.updatedAt && candidate.seq >= merged.seq)
            ? candidate
            : merged;
        const metadataWinner = candidate.metadataVersion >= merged.metadataVersion
            ? candidate
            : merged;
        const agentStateWinner = candidate.agentStateVersion >= merged.agentStateVersion
            ? candidate
            : merged;
        if (base === merged
            && metadataWinner === merged
            && agentStateWinner === merged) {
            continue;
        }
        merged = {
            ...base,
            seq: Math.max(candidate.seq, merged.seq),
            metadata: metadataWinner.metadata,
            metadataVersion: metadataWinner.metadataVersion,
            agentState: agentStateWinner.agentState,
            agentStateVersion: agentStateWinner.agentStateVersion,
        };
    }
    return merged;
}

class SessionWriteCancelled extends Error {
    constructor() { super('session-write-cancelled'); }
}

class SessionNotFoundError extends Error {
    constructor() { super('Session not found'); }
}

class Sync {
    private static readonly BACKGROUND_SEND_TIMEOUT_MS = 30_000;
    encryption!: Encryption;
    serverID!: string;
    private sessionWarmCacheAccountKey: string | null = null;
    private localHistory: LocalHistory | null = null;
    private historyPrefetch = new SessionHistoryPrefetch();
    private historyWindows = new Map<string, HistoryWindow>();
    // Session envelopes have their own IDs; reducer realID is not necessarily
    // the outer server wire ID used by history sequences and reading anchors.
    private historyWireProvenance = new Map<string, Map<string, string>>();
    private memoryReadingStates = new Map<string, ReadingState>();
    private historyWindowLoads = new Map<string, Promise<void>>();
    private historyBoundaryLoadingTokens = new Map<string, { isCurrent: () => boolean }>();
    private changesInFlight: Promise<void> | null = null;
    private changesSupported: boolean | null = null;
    // Native warm snapshots are bounded, not an atomic history database. Replay
    // the lightweight identity feed on cold start instead of persisting a cursor
    // that could outlive a failed cache write and permanently hide a deletion.
    private nativeHistoryCursor: string | undefined;
    private pendingHistoryTargets = new Map<string, number>();
    anonID!: string;
    private credentials!: AuthCredentials;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private sessionBootstrapSync: InvalidateSync;
    private sessionBootstrapInFlight: Promise<void> | null = null;
    private sessionListOwner: Encryption | null = null;
    private cancelScheduledSessionHistory: (() => void) | null = null;
    private sessionHistoryTask: object | null = null;
    private sessionHistoryReconciliationPending = false;
    private sessionReconnectSync: InvalidateSync;
    private sessionHistoryInFlight: Promise<boolean> | null = null;
    private nextSessionHistoryCursor: string | null | undefined = undefined;
    private initialSessionHistoryScheduled = false;
    private messagesSync = new Map<string, CoalescingMessageSync>();
    private sendSync = new Map<string, InvalidateSync>();
    private sendAbortControllers = new Map<string, AbortController>();
    private sessionMessageFrontiers = new Map<string, MessageRangeFrontier>();
    // Accepted API sequences can join cached islands only after the missing
    // range has been fetched. Normalized messages do not retain API sequences.
    private sessionCachedMessageSeqs = new Map<string, Set<number>>();
    private sessionMessageLoadGate = new SessionMessageLoadGate();
    private sessionMessageCacheGenerations = new Map<string, SessionMessageCacheGeneration>();
    // The caller owns receipt lifetime. Keep recovery provenance weakly, outside
    // evictable display caches; deleting a session revokes all its receipts.
    private acceptedLocalMessageReceipts = new Map<string, WeakMap<LocalMessageQueueReceipt, readonly NormalizedMessage[]>>();
    // Observation bounds overlay/retry lifetime within one display cache.
    // Full cache release keeps receipt provenance but resets observation.
    private observedLocalMessageIds = new Map<string, Set<string>>();
    private sessionOlderLoadingTokens = new Map<string, object>();
    private sessionMessageRetention = new SessionMessageRetention(3);
    private activeOpenSession: SessionRouteOperation | null = null;
    private sessionRouteOwnership = new SessionRouteOwnership();
    private sessionRouteOperations = new WeakMap<SessionOpenPromise, SessionRouteOperation>();
    private pendingOutbox = new Map<string, OutboxMessage[]>();
    private sessionMessageQueue = new Map<string, NormalizedMessage[]>();
    private queuedMessageSeqs = new WeakMap<NormalizedMessage, number>();
    private sessionQueueProcessing = new Map<string, object>();
    private sessionFallbackTitleInFlight = new Set<string>();
    private sessionMessageLocks = new Map<string, AsyncLock>();
    // Tracks incremental session writes so a full refresh can retain sessions
    // that appeared after its request began, even when they are absent from
    // that response's snapshot.
    private sessionMutationGeneration = 0;
    private sessionMutationGenerations = new Map<string, number>();
    private sessionDeletionMutationGenerations = new Map<string, number>();
    private inFlightSessionRefreshes = new Set<{ mutationGeneration: number }>();
    private sessionHydrations = new Map<string, Promise<boolean>>();
    private initialSessionBootstrapDeferred = false;
    private boundedSessionBootstrapDeferred = false;
    private historyReconciliationDeferred = false;
    private sessionEventCursors = new Map<string, number>();
    private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private pluginCatalogSync: InvalidateSync;
    private pluginCatalogStore = new PluginCatalogStore();
    private activityAccumulator: ActivityUpdateAccumulator;
    private initialPendingSessionPinnedState = loadPendingSessionPinnedState();
    private pendingSettings: Partial<Settings> = recoverPendingSettingsWithPinnedState(
        loadPendingSettings(),
        this.initialPendingSessionPinnedState,
    );
    private pendingSidebarOrganizationBase = loadPendingSidebarOrganizationBase();
    private pendingSessionPinnedOrderBase = this.initialPendingSessionPinnedState?.base ?? null;
    private appState: AppStateStatus = AppState.currentState;
    private backgroundSendTimeout: ReturnType<typeof setTimeout> | null = null;
    private backgroundSendNotificationId: string | null = null;
    private backgroundSendStartedAt: number | null = null;
    private sessionEventLocalNotificationsEnabled = getInitialSessionEventLocalNotificationsEnabled();
    revenueCatInitialized = false;

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;

    constructor() {
        subscribeLocalHistoryInvalidation(event => {
            if (event.scope !== this.localHistory?.scope || event.kind === 'session-deleted') return;
            const owner = this.sessionRouteOwnership.current();
            if (owner) this.leaveSessionRoute(owner);
            for (const id of [...this.historyWindows.keys()]) this.releaseSessionMessageCache(id);
            this.localHistory = null;
            this.sessionWarmCacheAccountKey = null;
        });
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.sessionBootstrapSync = new InvalidateSync(this.bootstrapSessions);
        this.sessionReconnectSync = new InvalidateSync(this.refreshSessionsAfterReconnect);
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.purchasesSync = new InvalidateSync(this.syncPurchases);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);
        this.feedSync = new InvalidateSync(this.fetchFeed);
        this.pluginCatalogSync = new InvalidateSync(this.fetchPluginCatalog);

        const registerPushToken = async () => {
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);
        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        // Listen for app state changes to refresh purchases
        AppState.addEventListener('change', (nextAppState) => {
            this.appState = nextAppState;
            if (nextAppState !== 'active') this.historyPrefetch.stop();
            else void this.startHistoryPrefetch();

            // Notify server of focus state for push notification routing.
            // Mobile: AppState.currentState reflects fg/bg directly.
            // Web/desktop: visibilitychange/focus listeners below drive this same path
            // by updating this.appState too — re-derive via getCurrentAppState() so
            // the wire value matches what the server uses for suppression.
            apiSocket.sendAppState(getCurrentAppState());

            if (nextAppState === 'active') {
                this.requestHistoryReconciliation();
                const shouldFailAfterResume = this.backgroundSendStartedAt !== null
                    && this.hasPendingOutboxMessages()
                    && (Date.now() - this.backgroundSendStartedAt) >= Sync.BACKGROUND_SEND_TIMEOUT_MS;
                void this.cancelBackgroundSendTimeoutNotification();
                this.clearBackgroundSendWatchdog();
                if (shouldFailAfterResume) {
                    void this.notifyMessageSendFailed();
                    this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
                }
                log.log('📱 App became active');
                log.log('📱 App became active: Invalidating artifacts sync');
                this.requestBoundedSessionBootstrap();
                resyncOnForeground({
                    globalSyncs: [
                        this.purchasesSync,
                        this.profileSync,
                        this.machinesSync,
                        this.pushTokenSync,
                        this.nativeUpdateSync,
                        this.artifactsSync,
                        this.feedSync,
                        this.pluginCatalogSync,
                    ],
                    currentViewingSessionId: storage.getState().currentViewingSessionId,
                    onSessionVisible: this.onSessionVisible,
                });
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
                this.maybeStartBackgroundSendWatchdog();
            }
        });

        // Web/desktop: AppState alone doesn't capture tab focus/visibility.
        // Notify server when the tab becomes hidden, regains visibility,
        // or window focus changes — so push routing can suppress only when
        // the user is actually looking at this client.
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            const broadcast = () => {
                apiSocket.sendAppState(getCurrentAppState());
            };
            document.addEventListener('visibilitychange', broadcast);
            window.addEventListener('focus', broadcast);
            window.addEventListener('blur', broadcast);
        }
    }

    async create(credentials: AuthCredentials, encryption: Encryption) {
        sessionTextStream.activate(null);
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        this.sessionWarmCacheAccountKey = createSessionWarmCacheAccountKey(getServerUrl(), this.serverID);
        setFirstSubmissionScope(this.sessionWarmCacheAccountKey, getServerUrl());
        await this.initializeLocalHistory();
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();

        // Await purchases sync to have fresh purchases
        await this.purchasesSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        sessionTextStream.activate(null);
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        this.sessionWarmCacheAccountKey = createSessionWarmCacheAccountKey(getServerUrl(), this.serverID);
        setFirstSubmissionScope(this.sessionWarmCacheAccountKey, getServerUrl());
        await this.initializeLocalHistory();
        if (!this.localHistory) await this.restoreSessionWarmCache();
        await this.#init();
    }

    private initializeLocalHistory = async (): Promise<void> => {
        this.historyPrefetch.stop();
        this.resetSessionListOwner();
        const previous = this.localHistory;
        this.nativeHistoryCursor = undefined;
        this.changesInFlight = null;
        this.localHistory = null;
        previous?.close();
        this.localHistory = Platform.OS === 'web' && this.sessionWarmCacheAccountKey
            ? await openLocalHistory(this.sessionWarmCacheAccountKey) : null;
        this.historyWindows.clear();
        this.historyWireProvenance.clear();
        this.memoryReadingStates.clear();
        this.changesSupported = null;
        const history = this.localHistory;
        if (!history || !this.sessionWarmCacheAccountKey) return;
        await history.importLegacyWarmCache(loadSessionWarmCache(this.sessionWarmCacheAccountKey));
        // The routed session is restored before the background list. Other
        // snapshots never hold the first readable conversation behind crypto.
        const id = typeof window !== 'undefined' ? window.location.pathname.match(/\/session\/([^/]+)/)?.[1] : undefined;
        if (id) {
            const snapshot = await history.readSnapshot(decodeURIComponent(id));
            if (snapshot) await this.writeSessionSnapshots(async () => [snapshot], { replace: false }, undefined, false);
        }
        void this.writeSessionSnapshots(() => history.listSnapshots(), { replace: false }, undefined, false).then(snapshots => {
            if (this.localHistory === history && snapshots.length) storage.getState().applyReady();
        }).catch(() => undefined);
    };

    private shouldPrioritizeInitialSessionRoute = (): boolean => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
        if (!window.location.pathname.match(/^\/session\/[^/]+\/?$/)) return false;
        const owner = this.sessionRouteOwnership.current();
        return owner === null || owner.phase === 'opening';
    };

    /** Route-aware gate shared by foreground, reconnect, and startup refreshes. */
    private requestBoundedSessionBootstrap = (): void => {
        if (this.shouldPrioritizeInitialSessionRoute()) {
            this.boundedSessionBootstrapDeferred = true;
            return;
        }
        this.boundedSessionBootstrapDeferred = false;
        this.sessionBootstrapSync.invalidate();
    };

    private requestHistoryReconciliation = (): void => {
        if (this.shouldPrioritizeInitialSessionRoute()) {
            this.historyReconciliationDeferred = true;
            return;
        }
        this.historyReconciliationDeferred = false;
        void this.reconcileHistory().catch(() => undefined);
    };

    private releaseDeferredSessionWork = (
        owner?: SessionRouteOwner,
        credentials: AuthCredentials = this.credentials,
        options: { terminal?: boolean } = {},
    ): void => {
        if (this.credentials !== credentials) return;
        const current = this.sessionRouteOwnership.current();
        // A replacement opening route inherits the network lane. An old
        // route's late completion must never release work ahead of it.
        if (owner && current && current.ownerEpoch !== owner.ownerEpoch) return;

        const reconcileAfterBootstrap = options.terminal && this.historyReconciliationDeferred;
        if (options.terminal) this.historyReconciliationDeferred = false;
        let bootstrap: Promise<void>;
        if (this.initialSessionBootstrapDeferred) {
            bootstrap = this.bootstrapSessions({ routeReady: true });
        } else if (this.boundedSessionBootstrapDeferred) {
            // The target transfers have completed, but the route may not yet
            // have been promoted by its first paint. Release this owned attempt
            // explicitly instead of re-entering the opening-route gate.
            bootstrap = this.bootstrapSessions({ routeReady: true });
        } else {
            bootstrap = this.sessionBootstrapInFlight ?? this.sessionBootstrapSync.awaitQueue();
        }
        if (reconcileAfterBootstrap && this.localHistory) {
            void bootstrap.then(() => {
                if (this.credentials === credentials && this.localHistory) {
                    return this.reconcileHistory();
                }
            }).catch(() => undefined);
        }
    };

    public resetLocalHistory = async (): Promise<void> => {
        sessionTextStream.activate(null);
        this.historyPrefetch.stop();
        clearSessionWarmCache();
        const clearing = clearLocalHistoryCaches();
        this.localHistory = null;
        for (const id of [...this.historyWindows.keys()]) this.releaseSessionMessageCache(id);
        this.historyWindows.clear();
        this.historyWireProvenance.clear();
        this.memoryReadingStates.clear();
        await clearing;
    };

    public readSessionReadingState = (id: string): Promise<ReadingState | null> => this.localHistory?.readReadingState(id)
        ?? Promise.resolve(this.memoryReadingStates.get(id) ?? null);
    public saveSessionReadingState = async (id: string, state: ReadingState): Promise<void> => {
        if (this.localHistory) await this.localHistory.writeReadingState(id, state);
        else if (this.historyWindows.has(id)) this.memoryReadingStates.set(id, state);
    };
    public getLocalHistoryScope = (): LocalHistory | null => this.localHistory;
    private captureHistoryOwner = (sessionId: string, operation?: SessionMessageLoadOperation) => {
        const history = this.localHistory;
        const encryption = this.encryption;
        const fence = history?.captureSessionFence(sessionId);
        return { history, isCurrent: () => this.localHistory === history && this.encryption === encryption
            && (!operation || this.sessionMessageLoadGate.isCurrent(operation))
            && (!history || (fence !== undefined && history.isFenceCurrent(fence))) };
    };
    public getMessageWireId = (id: string, renderedId: string): string | null => {
        const normalizedId = storage.getState().sessionMessages[id]?.reducerState.messages.get(renderedId)?.realID;
        return normalizedId ? this.historyWireProvenance.get(id)?.get(normalizedId) ?? normalizedId : null;
    };
    public getMessageWireBlockKey = (id: string, renderedId: string): string | null => {
        const rows = storage.getState().sessionMessages[id]?.reducerState.messages;
        const row = rows?.get(renderedId);
        if (!row?.realID || !rows) return null;
        if (row.tool?.callId) return `tool:${row.tool.callId}`;
        const kind = row.text !== null ? 'text' : row.tool ? 'tool' : 'event';
        // Reducer text/thinking rows are inserted in normalized source-content
        // order (before display grouping/reversal), independently of random IDs
        // and viewport-node registration. Keep tools in their own namespace.
        const siblings = [...rows.values()].filter(candidate => candidate.realID === row.realID
            && (candidate.text !== null ? 'text' : candidate.tool ? 'tool' : 'event') === kind);
        return `${kind}:${siblings.findIndex(candidate => candidate.id === renderedId)}`;
    };
    public getMessageWireSeq = (id: string, renderedId: string): number | null => {
        const wireId = this.getMessageWireId(id, renderedId);
        return this.historyWindows.get(id)?.messages.find(message => message.id === wireId)?.seq ?? null;
    };
    public getHistoryBoundarySeq = (id: string, direction: 'older' | 'newer'): number | null => {
        const window = this.historyWindows.get(id);
        return (direction === 'older' ? window?.oldestSeq : window?.newestSeq) ?? null;
    };
    public resolveRenderedMessageId = (id: string, wireId: string): string | null => {
        const state = storage.getState().sessionMessages[id];
        return state?.messages.find(message => this.getMessageWireId(id, message.id) === wireId)?.id ?? null;
    };

    private retireObservedLocalMessages(sessionId: string, messages: readonly NormalizedMessage[]): void {
        const pending = this.sessionMessageCacheGenerations.get(sessionId)?.pendingLocalMessages;
        if (!pending) return;
        let observed = this.observedLocalMessageIds.get(sessionId);
        for (const message of messages) {
            const identities = [message.localId, message.id].filter((value): value is string => value !== null);
            for (const identity of identities) {
                if (!pending.delete(identity)) continue;
                observed ??= new Set();
                observed.add(identity);
            }
        }
        if (observed) this.observedLocalMessageIds.set(sessionId, observed);
    }

    private applyHistoryWindow = async (id: string, window: HistoryWindow, operation: SessionMessageLoadOperation,
        options: { retainCurrentWebRows?: boolean; retainCurrentRows?: boolean; anchorSeq?: number; direction?: 'older' | 'newer'; compact?: boolean; protectedRange?: HistoryViewportRange; viewport?: HistoryViewportReader } = {}): Promise<boolean> => {
        const owner = this.captureHistoryOwner(id, operation);
        const encryption = this.encryption.getSessionEncryption(id);
        if (!encryption) return false;
        const retainCurrentRows = options.retainCurrentRows === true
            || (Platform.OS === 'web' && options.retainCurrentWebRows === true);
        const normalized: NormalizedMessage[] = [];
        const normalizedWireIds = new Map<NormalizedMessage, string>();
        let pending = window.messages;
        while (true) {
            if (pending.length > 0) {
                const decrypted = await encryption.createDetached().decryptMessages(pending);
                if (!owner.isCurrent() || this.encryption.getSessionEncryption(id) !== encryption) return false;
                if (decrypted.length !== pending.length || decrypted.some(message => !message || message.content === null)) {
                    throw new Error('history-window-decrypt-failed');
                }
                normalized.push(...decrypted.flatMap(message => {
                    const value = message && normalizeRawMessage(message.id, message.localId, message.createdAt, message.content);
                    if (value && message) normalizedWireIds.set(value, message.id);
                    return value ? [value] : [];
                }));
            }
            if (!retainCurrentRows) break;
            const current = this.historyWindows.get(id);
            // An empty initial server page and its concurrently appended live
            // tail have no overlap by definition. The explicit initial-replay
            // retention contract owns that tail, so it is not a disconnected
            // historical island.
            const retained = options.retainCurrentRows === true && window.messages.length === 0
                && current?.isAtLatest === true ? current : retainMissingHistoryRows(window, current);
            if (retained === window) break;
            const knownSeqs = new Set(window.messages.map(message => message.seq));
            const retainedSeqs = new Set(retained.messages.map(message => message.seq));
            if (!window.messages.every(message => retainedSeqs.has(message.seq))) {
                // Retention can deliberately select the already-visible
                // historical island instead of a disconnected replacement.
                // Discard normalized rows from that rejected island before
                // replaying the retained window.
                normalized.length = 0;
                knownSeqs.clear();
            }
            window = retained;
            pending = window.messages.filter(message => !knownSeqs.has(message.seq));
        }
        // A capacity deferral must leave the current projection and live queue
        // untouched. Sample the viewport after every asynchronous decrypt.
        if (Platform.OS === 'web') window = boundHistoryWindow(window, { ...options,
            protectedRange: options.viewport?.() ?? options.protectedRange });
        else if (options.retainCurrentRows === true && window.messages.length > historyNavigationWindowLimit()) {
            const messages = window.messages.slice(-historyNavigationWindowLimit());
            window = { ...window, messages, oldestSeq: messages[0]?.seq ?? null,
                newestSeq: messages.at(-1)?.seq ?? null, hasMoreOlder: true };
        }
        // Flush any admitted live effects before replacing their projection;
        // the scheduled microtask must not resurrect rows evicted below.
        if (Platform.OS === 'web') this.drainQueuedMessages(id, new Set([
            ...(this.historyWireProvenance.get(id)?.keys() ?? []), ...normalized.map(message => message.id),
        ]));
        this.retireObservedLocalMessages(id, normalized);
        const retainedIds = new Set(window.messages.map(message => message.id));
        for (let i = normalized.length - 1; i >= 0; i--) {
            if (!retainedIds.has(normalizedWireIds.get(normalized[i])!)) normalized.splice(i, 1);
        }
        // A latest-window replacement contains acknowledged wire rows only.
        // Keep only unobserved local projections in the live view. Receipt
        // provenance stays separate so acknowledged rows cannot resurrect
        // after ordinary bounded retention evicts their remote echo.
        const generation = this.sessionMessageCacheGenerations.get(id);
        this.historyWireProvenance.set(id, new Map(normalized.map(message => [message.id, normalizedWireIds.get(message)!])));
        const accepted = window.isAtLatest ? [...(generation?.pendingLocalMessages?.values() ?? [])] : [];
        for (const message of accepted) {
            const represented = normalized.some(candidate => candidate.id === message.id
                || (message.localId !== null && candidate.localId === message.localId));
            if (!represented) normalized.push(message);
        }
        // Reproject only the bounded window; historical replay must not change
        // live session thinking/usage/permission mode or retain evicted reducer rows.
        const state = createReducer();
        const projected = reducer(state, normalized, window.isAtLatest ? storage.getState().sessions[id]?.agentState : null);
        const messages = projected.messages.sort((a, b) => b.createdAt - a.createdAt);
        this.historyWindows.set(id, window);
        this.sessionMessageFrontiers.set(id, { latestSeq: window.newestSeq ?? 0, olderBeforeSeq: window.oldestSeq,
            hasMoreOlder: window.hasMoreOlder });
        this.sessionCachedMessageSeqs.set(id, new Set(window.messages.map(message => message.seq)));
        storage.setState(current => ({ sessionMessages: { ...current.sessionMessages, [id]: {
            messages, messagesMap: Object.fromEntries(messages.map(message => [message.id, message])), reducerState: state,
            isLoaded: true, latestAppliedSeq: window.newestSeq ?? 0, hasMoreOlder: window.hasMoreOlder, isLoadingOlder: false,
            hasMoreNewer: window.hasMoreNewer, isLoadingNewer: false, isAtLatest: window.isAtLatest,
            latestVerifiedOwnerEpoch: null,
        } } }));
        sessionTextStream.observeDurable(id, normalized);
        this.recordRoutePageCommit(operation, window.newestSeq ?? 0);
        return true;
    };

    private loadHistoryBoundary = (id: string, direction: 'older' | 'newer' | 'latest', viewport?: HistoryViewportReader): Promise<void> => {
        const existing = this.historyWindowLoads.get(id);
        if (existing && this.historyBoundaryLoadingTokens.get(id)?.isCurrent()) return existing;
        const history = this.localHistory;
        if (!history && Platform.OS !== 'web') return Promise.resolve();
        const pending = (async () => {
            const navigationWindowLimit = historyNavigationWindowLimit();
            let verifiedLatestFromNetwork = false;
            const current = this.historyWindows.get(id);
            if (!current && direction !== 'latest') return;
            if (current && direction === 'older' && !current.hasMoreOlder) return;
            const lease = this.sessionMessageLoadGate.currentLease(id) ?? this.sessionMessageLoadGate.enter(id);
            const operation = this.sessionMessageLoadGate.begin(lease);
            const owner = this.captureHistoryOwner(id, operation);
            const boundary = direction === 'older' ? current!.oldestSeq : direction === 'newer' ? current!.newestSeq : SEQ_BACKWARD_INITIAL_SENTINEL;
            if (boundary === null) return;
            // Loading belongs to the cache/request lifetime, not the projection
            // epoch: a foreground historical no-op may supersede that epoch.
            const cacheOwner = this.captureHistoryOwner(id);
            const cacheGeneration = this.sessionMessageCacheGenerations.get(id) ?? {};
            this.sessionMessageCacheGenerations.set(id, cacheGeneration);
            const loadingToken = { isCurrent: (): boolean => cacheOwner.isCurrent()
                && this.sessionMessageCacheGenerations.get(id) === cacheGeneration
                && this.historyBoundaryLoadingTokens.get(id) === loadingToken };
            this.historyBoundaryLoadingTokens.set(id, loadingToken);
            const field = direction === 'older' ? 'isLoadingOlder' : 'isLoadingNewer';
            const patch = (values: object) => storage.setState(state => state.sessionMessages[id] ? ({ sessionMessages: {
                ...state.sessionMessages, [id]: { ...state.sessionMessages[id], ...values },
            } }) : state);
            patch({ [field]: true, [direction === 'older' ? 'olderError' : 'newerError']: null });
            try {
                let latest = direction === 'latest' ? await history?.readWindow(id) ?? null : null;
                if (!owner.isCurrent()) return;
                if (latest && !latest.isAtLatest) {
                    const afterSeq = latest.newestSeq ?? 0;
                    const response = await apiSocket.request(`/v3/sessions/${id}/messages?after_seq=${afterSeq}&limit=100`);
                    if (!owner.isCurrent()) return;
                    if (response.status === 404) { this.removeSessionLocally(id); return; }
                    if (!response.ok) throw new Error(`Latest history failed: ${response.status}`);
                    const data = await response.json() as V3GetSessionMessagesResponse;
                    if (!owner.isCurrent()) return;
                    verifiedLatestFromNetwork = true;
                    let committed = await history?.commitPage(id, { ...data, direction: 'newer', boundary: afterSeq });
                    if (!owner.isCurrent()) return;
                    let fallback = memoryHistoryPage(latest, data, 'newer');
                    // An explicit jump may skip an unread gap. At most two pages
                    // are requested; never walk all intervening history in the background.
                    if (data.hasMore) {
                        const tail = await this.fetchLatestMessagePageRaw(id);
                        if (!owner.isCurrent()) return;
                        committed = await history?.commitPage(id, { ...tail, direction: 'older', boundary: SEQ_BACKWARD_INITIAL_SENTINEL });
                        fallback = memoryHistoryPage(undefined, tail, 'latest');
                    }
                    latest = committed ? await history?.readWindow(id, { limit: 300 }) ?? fallback : fallback;
                }
                if (direction !== 'latest' || !latest) {
                    let page: HistoryPage | null = direction === 'older' ? await history?.readOlderPage(id, boundary!, 100) ?? null
                        : direction === 'newer' ? await history?.readNewerPage(id, boundary!, 100) ?? null : null;
                    if (!owner.isCurrent()) return;
                    if (!page && direction === 'older') {
                        await this.historyPrefetch.waitForPage(id, boundary!);
                        if (!owner.isCurrent()) return;
                        page = await history?.readOlderPage(id, boundary!, 100) ?? null;
                    }
                    if (!owner.isCurrent()) return;
                    if (!page) {
                        const response = await apiSocket.request(`/v3/sessions/${id}/messages?${direction === 'newer' ? 'after_seq' : 'before_seq'}=${boundary}&limit=100`);
                        if (!owner.isCurrent()) return;
                        if (response.status === 404) { this.removeSessionLocally(id); return; }
                        if (!response.ok) throw new Error(`History ${direction} failed: ${response.status}`);
                        const data = await response.json() as V3GetSessionMessagesResponse;
                        if (!owner.isCurrent()) return;
                        page = { direction: direction === 'newer' ? 'newer' : 'older', boundary: boundary!, ...data };
                        const committed = await history?.commitPage(id, page);
                        if (!committed) {
                            // Quota failures keep the visible records and use the network
                            // page in memory. The durable cursor/coverage remains unchanged.
                            const memoryLimit = Platform.OS === 'web'
                                ? (current?.messages.length ?? 0) + page.messages.length
                                : navigationWindowLimit;
                            latest = memoryHistoryPage(current, page, direction, memoryLimit);
                        }
                    }
                    if (!latest) {
                        // Keep the previous visible edge within the next bounded window.
                        const anchorSeq = direction === 'latest' ? undefined : direction === 'older'
                            ? page!.messages[Math.max(0, page!.messages.length - 50)]?.seq ?? boundary!
                            : page!.messages[Math.min(49, page!.messages.length - 1)]?.seq ?? boundary!;
                        const expanded = await history?.readWindow(id, { anchorSeq, limit: navigationWindowLimit }) ?? null;
                        if (Platform.OS === 'web' && direction !== 'latest') {
                            // Merge overlapping rows before the shared cap is applied.
                            // Keep the previous visible edge as the projection anchor;
                            // offscreen evictions remain reloadable from durable history.
                            const source = expanded ?? page!;
                            latest = memoryHistoryPage(current, {
                                messages: source.messages,
                                hasMore: expanded
                                    ? direction === 'older' ? expanded.hasMoreOlder : expanded.hasMoreNewer
                                    : page!.hasMore,
                            }, direction, (current?.messages.length ?? 0) + source.messages.length);
                        } else {
                            latest = expanded;
                        }
                    }
                }
                if (latest && owner.isCurrent()) {
                    const applied = await this.applyHistoryWindow(id, latest, operation, {
                        retainCurrentWebRows: direction !== 'latest',
                        ...(direction !== 'latest' ? { direction, anchorSeq: boundary!, viewport } : {}),
                    });
                    if (applied && direction === 'latest' && verifiedLatestFromNetwork && latest.isAtLatest) {
                        this.markLatestVerified(id, operation);
                    }
                }
            } catch (error) {
                if (owner.isCurrent()) patch({ [direction === 'older' ? 'olderError' : 'newerError']: error instanceof Error ? error.message : 'History unavailable' });
            } finally {
                if (loadingToken.isCurrent()) {
                    patch({ [field]: false, ...(!owner.isCurrent()
                        ? { [direction === 'older' ? 'olderError' : 'newerError']: 'History load interrupted. Retry.' } : {}) });
                }
                if (this.historyBoundaryLoadingTokens.get(id) === loadingToken) this.historyBoundaryLoadingTokens.delete(id);
            }
        })().finally(() => { if (this.historyWindowLoads.get(id) === pending) this.historyWindowLoads.delete(id); });
        this.historyWindowLoads.set(id, pending); return pending;
    };
    public loadNewerMessages = (id: string, viewport?: HistoryViewportReader): Promise<void> => this.historyWindows.get(id)?.hasMoreNewer === false
        ? Promise.resolve() : this.loadHistoryBoundary(id, 'newer', viewport);
    public jumpToLatestMessages = async (id: string): Promise<void> => {
        const history = this.localHistory;
        const encryption = this.encryption;
        const pending = this.historyWindowLoads.get(id);
        if (pending) await pending;
        if (this.localHistory !== history || this.encryption !== encryption) return;
        if (pending && this.historyWindows.get(id)?.isAtLatest) return;
        await this.loadHistoryBoundary(id, 'latest');
    };

    private reconcileHistory = (): Promise<void> => {
        if (this.changesInFlight) return this.changesInFlight;
        const history = this.localHistory;
        const credentials = this.credentials;
        if (!credentials) return Promise.resolve();
        if (!history) {
            if (Platform.OS === 'web') return Promise.resolve();
            const request = this.reconcileNativeHistory(credentials).finally(() => {
                if (this.changesInFlight === request) this.changesInFlight = null;
            });
            this.changesInFlight = request;
            return request;
        }
        const request = (async () => {
            const capability = await reconcileSessionHistory(history, {
                fetchChanges: cursor => fetchSessionChanges(credentials, cursor),
                fetchSnapshot: id => fetchSessionSnapshot(credentials, id),
                applySnapshot: async snapshot => { await this.writeSessionSnapshots(async () => [snapshot]); },
                deleteSession: id => this.removeSessionLocally(id),
                isCurrent: () => this.localHistory === history,
            });
            if (this.localHistory !== history) return;
            this.changesSupported = capability === 'supported';
            if (capability === 'unsupported') {
                // Old servers still support lightweight per-session snapshots.
                // Their seq includes metadata events, so an ambiguous increase may
                // require an empty forward request, but unchanged seq never does.
                const id = storage.getState().currentViewingSessionId;
                if (id) {
                    const owner = this.captureHistoryOwner(id);
                    const previous = await history.readSnapshot(id);
                    if (!owner.isCurrent()) return;
                    const fresh = await fetchSessionSnapshot(credentials, id);
                    if (!owner.isCurrent()) return;
                    if (!fresh) this.removeSessionLocally(id);
                    else {
                        await this.writeSessionSnapshots(async () => [fresh]);
                        if (!owner.isCurrent()) return;
                        if (!previous || fresh.seq > previous.seq) await this.loadHistoryBoundary(id, 'newer');
                    }
                }
                return;
            }
            const id = storage.getState().currentViewingSessionId ?? this.sessionRouteOwnership.current()?.sessionId;
            if (id) {
                const window = this.historyWindows.get(id);
                const change = await history.readChange(id);
                if (window && change && change.lastMessageSeq > (window.newestSeq ?? 0)) {
                    if (window.isAtLatest) await this.loadHistoryBoundary(id, Platform.OS === 'web' ? 'newer' : 'latest');
                    else storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, [id]: {
                        ...state.sessionMessages[id], hasMoreNewer: true, isAtLatest: false,
                    } } }));
                }
            }
        })().finally(() => { if (this.changesInFlight === request) this.changesInFlight = null; });
        this.changesInFlight = request; return request;
    };

    private reconcileNativeHistory = async (credentials: AuthCredentials): Promise<void> => {
        const owner = this.captureHistoryOwner('');
        const current = () => owner.isCurrent() && this.credentials === credentials;
        let cursor = this.nativeHistoryCursor;
        let reset = false;
        let supported = true;
        const changes = new Map<string, import('./apiSessionChanges').SessionChange>();
        while (current()) {
            const page = await fetchSessionChanges(credentials, cursor);
            if (!current()) return;
            if (page.kind === 'unsupported') { supported = false; break; }
            if (page.kind === 'reset') {
                if (reset) throw new Error('Repeated native history cursor reset');
                cursor = undefined;
                reset = true;
                changes.clear();
                continue;
            }
            for (const change of page.changes) changes.set(change.sessionId, change);
            if (page.hasMore && page.nextCursor === cursor) throw new Error('Native history pagination stalled');
            cursor = page.nextCursor;
            if (!page.hasMore) break;
        }
        if (!current()) return;
        for (const change of changes.values()) {
            if (change.deleted) this.removeSessionLocally(change.sessionId);
        }
        const verifyUnknown = this.nativeHistoryCursor === undefined || reset || !supported;
        const ids = Object.keys(storage.getState().sessions).filter(id => {
            const change = changes.get(id);
            const session = storage.getState().sessions[id];
            return change
                ? !change.deleted && (change.metadataVersion > session.metadataVersion || change.agentStateVersion > session.agentStateVersion)
                : verifyUnknown;
        });
        // Only refresh cached identities, not every historical body/snapshot.
        // Absence from a bounded list or a changes page is never a tombstone.
        let index = 0;
        const results = await Promise.allSettled(Array.from({ length: Math.min(4, ids.length) }, async () => {
            while (index < ids.length && current()) {
                const id = ids[index++];
                if (!storage.getState().sessions[id]) continue;
                let metadataVersion = changes.get(id)?.metadataVersion ?? 0;
                let agentStateVersion = changes.get(id)?.agentStateVersion ?? 0;
                await this.writeSessionSnapshots(async () => {
                    const fresh = await fetchSessionSnapshot(credentials, id);
                    if (!current()) return [];
                    if (!fresh) { this.removeSessionLocally(id); return []; }
                    metadataVersion = Math.max(metadataVersion, fresh.metadataVersion);
                    agentStateVersion = Math.max(agentStateVersion, fresh.agentStateVersion);
                    return [fresh];
                });
                if (!current()) return;
                const applied = storage.getState().sessions[id];
                // A skipped key/decryption or stale HTTP response must not
                // acknowledge a change whose snapshot is still missing locally.
                if (applied && (applied.metadataVersion < metadataVersion || applied.agentStateVersion < agentStateVersion)) {
                    throw new Error('Native history snapshot was not applied');
                }
            }
        }));
        const failure = results.find(result => result.status === 'rejected');
        if (current() && failure?.status === 'rejected') throw failure.reason;
        // Failed page/metadata reads leave the old cursor for the next retry.
        if (current() && supported) this.nativeHistoryCursor = cursor;
    };

    private refreshSessionsAfterReconnect = async (): Promise<void> => {
        const history = this.localHistory;
        const credentials = this.credentials;
        this.requestBoundedSessionBootstrap();
        if (this.shouldPrioritizeInitialSessionRoute()) {
            this.historyReconciliationDeferred = true;
            return;
        }
        this.historyReconciliationDeferred = false;
        const canReconcile = Boolean(history) || (Platform.OS !== 'web' && Boolean(credentials));
        if (!canReconcile) return;
        const earlierReconciliation = this.changesInFlight;
        if (earlierReconciliation) {
            await earlierReconciliation;
            if (this.localHistory !== history || this.credentials !== credentials) return;
        }
        await this.reconcileHistory();
    };

    private restoreSessionWarmCache = async (): Promise<void> => {
        const accountKey = this.sessionWarmCacheAccountKey;
        if (!accountKey) return;
        const warmCache = loadSessionWarmCache(accountKey);
        if (warmCache.snapshots.length === 0) return;
        let restoredSessionCount = 0;
        for (const snapshot of warmCache.snapshots) {
            try {
                const restored = await this.writeSessionSnapshots(async () => [snapshot], { replace: false }, undefined, false);
                if (restored.length === 0) {
                    removeSessionFromWarmCache(accountKey, snapshot.id);
                    continue;
                }
                restoredSessionCount += restored.length;
            } catch {
                // The cache is only a startup accelerator. A stale key or one
                // corrupt ciphertext must not block login or healthy entries;
                // evict it and let the network bootstrap restore the session.
                removeSessionFromWarmCache(accountKey, snapshot.id);
            }
        }
        for (const [sessionId, page] of Object.entries(warmCache.latestPages)) {
            if (!storage.getState().sessions[sessionId]) continue;
            try {
                this.retainSessionMessageCache(sessionId);
                const lease = this.sessionMessageLoadGate.enter(sessionId);
                await this.applyLatestMessagePage(sessionId, page, this.sessionMessageLoadGate.begin(lease), 'warm-cache');
            } catch {
                removeSessionFromWarmCache(accountKey, sessionId);
            }
        }
        if (restoredSessionCount > 0) storage.getState().applyReady();
    };

    async #init() {
        this.sessionEventCursors.clear();
        this.sessionHydrations.clear();
        // Scheduler intent belongs to one authenticated account only. Late
        // completions from the previous account are fenced by credential
        // identity and must leave no work for the next account to consume.
        this.initialSessionBootstrapDeferred = false;
        this.boundedSessionBootstrapDeferred = false;
        this.historyReconciliationDeferred = false;

        // Subscribe to updates
        this.subscribeToUpdates();

        // Sync initial PostHog opt-out state with stored settings
        if (tracking) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // Invalidate sync
        log.log('🔄 #init: Invalidating all syncs');
        void this.bootstrapSessions();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.purchasesSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.artifactsSync.invalidate();
        this.feedSync.invalidate();
        this.pluginCatalogStore.beginAccount();
        this.pluginCatalogSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts');

    }

    private fetchPluginCatalog = async () => {
        const accountGeneration = this.pluginCatalogStore.beginRefresh();
        try {
            const catalog = await getPluginCatalog();
            this.pluginCatalogStore.resolve(catalog.plugins, accountGeneration);
        } catch (error) {
            this.pluginCatalogStore.reject(accountGeneration);
            throw error;
        }
    }

    getPluginCatalogSnapshot = (): PluginCatalogSnapshot => this.pluginCatalogStore.getSnapshot();

    getPluginConfigurationDraftScope = (): number => this.pluginCatalogStore.getConfigurationDraftScope();

    isPluginConfigurationDraftScopeCurrent = (scope: number): boolean => (
        this.pluginCatalogStore.isConfigurationDraftScopeCurrent(scope)
    );

    getPluginConfigurationDraft = (
        pluginId: string,
        pluginVersion: string,
        scope?: number,
    ): Record<string, string> | undefined => (
        this.pluginCatalogStore.getConfigurationDraft(pluginId, pluginVersion, scope)
    );

    setPluginConfigurationDraft = (
        pluginId: string,
        pluginVersion: string,
        draft: Record<string, string>,
        scope?: number,
    ): void => {
        this.pluginCatalogStore.setConfigurationDraft(pluginId, pluginVersion, draft, scope);
    };

    clearPluginConfigurationDraft = (
        pluginId: string,
        pluginVersion: string,
        expectedDraft?: Record<string, string>,
        scope?: number,
    ): void => {
        this.pluginCatalogStore.clearConfigurationDraft(pluginId, pluginVersion, expectedDraft, scope);
    };

    setPluginInstallationStatus = (
        pluginId: string,
        status: import('@slopus/happy-wire').PluginInstallationStatus,
        scope?: number,
    ): void => {
        this.pluginCatalogStore.setPluginInstallationStatus(pluginId, status, scope);
    };

    subscribePluginCatalog = (listener: () => void): (() => void) => {
        return this.pluginCatalogStore.subscribe(listener);
    }

    refreshPluginCatalog = async (): Promise<PluginCatalogResponse> => {
        await this.pluginCatalogSync.invalidateAndAwait();
        return { plugins: [...this.pluginCatalogStore.getSnapshot().plugins] };
    }


    onSessionVisible = (sessionId: string, options?: { loadMessages?: boolean }) => {
        this.retainSessionMessageCache(sessionId);
        if (options?.loadMessages !== false) {
            this.getMessagesSync(sessionId).invalidate();
        }

        // Also invalidate git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();

        // Notify voice assistant about session visibility
        const session = storage.getState().sessions[sessionId];
        if (session) {
            voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
        }
    }

    ensureMessagesLoaded = async (sessionId: string): Promise<void> => {
        await this.getMessagesSync(sessionId).invalidateAndAwait();
    }

    private getMessagesSync(sessionId: string): CoalescingMessageSync {
        const lease = this.sessionMessageLoadGate.currentLease(sessionId)
            ?? this.sessionMessageLoadGate.enter(sessionId);
        let sync = this.messagesSync.get(sessionId);
        if (!sync || sync.lease !== lease) {
            sync?.stop();
            let retryPending = false;
            sync = new CoalescingMessageSync(lease, async () => {
                const operation = this.sessionMessageLoadGate.begin(lease);
                const route = this.activeOpenSession;
                if (retryPending && route?.sessionId === sessionId && route.messageLease === lease
                    && !route.cancelled && this.sessionRouteOwnership.owns(route.owner)
                    && this.sessionMessageLoadGate.isCurrent(operation)) {
                    markSessionCriticalPathHydrationRetry();
                }
                try {
                    await this.fetchMessages(sessionId, operation);
                    retryPending = false;
                } catch (error) {
                    retryPending = true;
                    throw error;
                }
            }, () => this.getSessionProjectedMessageSeq(sessionId), () => (
                this.sessionMessageLoadGate.isLeaseCurrent(lease)
            ));
            this.messagesSync.set(sessionId, sync);
        }
        return sync;
    }

    private retainSessionMessageCache(sessionId: string): void {
        if (!this.sessionMessageCacheGenerations.has(sessionId)) {
            this.sessionMessageCacheGenerations.set(sessionId, {});
        }
        for (const evictedSessionId of this.sessionMessageRetention.touch(sessionId)) {
            this.releaseSessionMessageCache(evictedSessionId, false);
        }
    }

    private releaseSessionMessageCache(sessionId: string, removeFromRetention = true): void {
        if (this.sessionRouteOwnership.ownsSession(sessionId)) sessionTextStream.activate(null);
        if (this.sessionRouteOwnership.ownsSession(sessionId)) this.historyPrefetch.stop();
        this.historyWindows.delete(sessionId);
        this.historyWireProvenance.delete(sessionId);
        this.memoryReadingStates.delete(sessionId);
        this.historyWindowLoads.delete(sessionId);
        this.historyBoundaryLoadingTokens.delete(sessionId);
        const messageSync = this.messagesSync.get(sessionId);
        messageSync?.stop();
        this.messagesSync.delete(sessionId);
        this.sessionMessageLoadGate.invalidate(sessionId);
        this.sessionMessageCacheGenerations.delete(sessionId);
        this.observedLocalMessageIds.delete(sessionId);
        this.sessionOlderLoadingTokens.delete(sessionId);
        this.sessionMessageFrontiers.delete(sessionId);
        this.sessionCachedMessageSeqs.delete(sessionId);
        this.sessionMessageLocks.delete(sessionId);
        this.sessionMessageQueue.delete(sessionId);
        this.sessionQueueProcessing.delete(sessionId);
        if (removeFromRetention) {
            this.sessionMessageRetention.remove(sessionId);
        }
        storage.setState((state) => {
            if (!state.sessionMessages[sessionId]) return state;
            const { [sessionId]: _released, ...sessionMessages } = state.sessionMessages;
            return { sessionMessages };
        });
    }

    private getSendSync(sessionId: string): InvalidateSync {
        let sync = this.sendSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.flushOutbox(sessionId));
            this.sendSync.set(sessionId, sync);
        }
        return sync;
    }

    private enqueueMessages(sessionId: string, messages: NormalizedMessage[], latestSeq?: number) {
        if (messages.length === 0) {
            return;
        }

        let queue = this.sessionMessageQueue.get(sessionId);
        if (!queue) {
            queue = [];
            this.sessionMessageQueue.set(sessionId, queue);
        }
        queue.push(...messages);
        if (latestSeq !== undefined) {
            for (const message of messages) this.queuedMessageSeqs.set(message, latestSeq);
        }

        this.scheduleQueuedMessagesProcessing(sessionId);
    }

    private containsMutableToolResult(sessionId: string, messages: NormalizedMessage[]): boolean {
        return messages.some((message) => (
            message.role === 'agent'
            && message.content.some((content) => (
                content.type === 'tool-result'
                && storage.getState().isMutableToolCall(sessionId, content.tool_use_id)
            ))
        ));
    }

    private getSessionMessageLock(sessionId: string): AsyncLock {
        let lock = this.sessionMessageLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncLock();
            this.sessionMessageLocks.set(sessionId, lock);
        }
        return lock;
    }

    public awaitLocalMessageProjection = async (
        sessionId: string,
        localIds: readonly string[],
        receipt?: LocalMessageQueueReceipt,
    ): Promise<boolean> => {
        if (localIds.length === 0 || localIds.some(id => typeof id !== 'string' || !id.trim())) return false;
        if (!storage.getState().sessions[sessionId]) return false;
        let generation = this.sessionMessageCacheGenerations.get(sessionId);
        if (receipt) {
            const accepted = this.acceptedLocalMessageReceipts.get(sessionId)?.get(receipt);
            if (!accepted || receipt.sessionId !== sessionId
                || localIds.length !== receipt.localIds.length
                || receipt.localIds.some(id => !localIds.includes(id))) return false;
            const cache = storage.getState().sessionMessages[sessionId];
            const isProjected = !!cache && localIds.every(id => {
                const messageId = cache.reducerState.localIds.get(id);
                if (messageId !== undefined) return cache.messagesMap[messageId]?.kind === 'user-text';
                const normalizedId = generation?.localMessageIds?.get(id);
                const fileId = normalizedId ? cache.reducerState.toolIdToMessageId.get(normalizedId) : undefined;
                return fileId !== undefined && cache.reducerState.messages.get(fileId)?.realID === normalizedId;
            });
            if (!generation || localIds.some(id => !generation?.localMessageIds?.has(id)) || !isProjected) {
                // A retained generation knows whether its local display was
                // already observed remotely. Receipt retries may rebuild a
                // pending projection, but must never revive an echoed row
                // merely because bounded latest retention later evicted it.
                const observed = this.observedLocalMessageIds.get(sessionId);
                if (observed && accepted.some(message => observed.has(message.localId ?? message.id))) {
                    return false;
                }
                // A background gap/retention eviction discards the display
                // generation, not the accepted encrypted send. Restore from the
                // original receipt's exact normalized entries, even after ACK
                // removed the outbox. No ID/order inference or network work.
                generation ??= {};
                generation.localMessageIds ??= new Map();
                generation.acceptedLocalMessages ??= new Map();
                generation.pendingLocalMessages ??= new Map();
                for (const message of accepted) {
                    const identity = message.localId ?? message.id;
                    generation.localMessageIds.set(identity, message.id);
                    generation.acceptedLocalMessages.set(identity, message);
                    generation.pendingLocalMessages.set(identity, message);
                }
                this.sessionMessageCacheGenerations.set(sessionId, generation);
                this.applyMessages(sessionId, [...accepted]);
            }
        }
        if (!generation) return false;
        const acceptedIds = generation.localMessageIds;
        if (!acceptedIds || localIds.some(id => !acceptedIds.has(id))) return false;

        // Drain the receipt's local entries synchronously so navigation need
        // not wait for the scheduled projection microtask. Preserve queue order
        // and leave realtime entries for the normal projection task.
        // Reducer commits are synchronous, so no network writer can interleave.
        const ids = new Set(localIds);
        const queue = this.sessionMessageQueue.get(sessionId);
        if (queue) {
            const local = queue.filter(message => message.localId !== null
                && ids.has(message.localId) && acceptedIds.get(message.localId) === message.id);
            if (local.length > 0) {
                const projected = new Set(local);
                this.sessionMessageQueue.set(sessionId, queue.filter(message => !projected.has(message)));
                this.applyMessages(sessionId, local);
            }
        }

        // Let the accepted store commit settle and reject deletion/eviction
        // occurring before the caller transfers its draft to the route.
        await Promise.resolve();
        const state = storage.getState();
        const cache = state.sessionMessages[sessionId];
        return !!state.sessions[sessionId]
            && this.sessionMessageCacheGenerations.get(sessionId) === generation
            && !!cache
            && localIds.every(id => {
                // The reducer assigns display IDs; resolve each literal receipt
                // ID through its deduplication index, never by array position.
                const messageId = cache.reducerState.localIds.get(id);
                if (messageId !== undefined) {
                    const message = cache.messagesMap[messageId];
                    return message?.kind === 'user-text' && message.localId === id;
                }
                // File envelopes normalize into tool calls with a distinct
                // envelope ID and intentionally have no display localId.
                const normalizedId = acceptedIds.get(id)!;
                const fileId = cache.reducerState.toolIdToMessageId.get(normalizedId);
                if (fileId === undefined || cache.reducerState.messages.get(fileId)?.realID !== normalizedId) return false;
                const file = cache.messagesMap[fileId];
                return file?.kind === 'tool-call' && file.tool.name === 'file';
            });
    };

    private scheduleQueuedMessagesProcessing(sessionId: string) {
        if (this.sessionQueueProcessing.has(sessionId)) {
            return;
        }

        const task = {};
        this.sessionQueueProcessing.set(sessionId, task);
        // Projection commits are synchronous. Network/history work may keep
        // the fetch lock for seconds; an already admitted live row must not
        // wait for that lock to reach the transcript. Coalesce this JS turn.
        queueMicrotask(() => {
            // Releasing/remounting a cache cancels the old task. Its callback
            // must neither drain the new queue nor clear the new task's token.
            if (this.sessionQueueProcessing.get(sessionId) !== task) return;
            try {
                this.drainQueuedMessages(sessionId);
            } finally {
                if (this.sessionQueueProcessing.get(sessionId) === task) {
                    this.sessionQueueProcessing.delete(sessionId);
                    if (this.sessionMessageQueue.get(sessionId)?.length) {
                        this.scheduleQueuedMessagesProcessing(sessionId);
                    }
                }
            }
        });
    }

    private drainQueuedMessages(sessionId: string, wireIds?: Set<string>): void {
        const apply = (batch: NormalizedMessage[]) => {
            const seqs = batch.flatMap(message => {
                const seq = this.queuedMessageSeqs.get(message);
                return seq === undefined ? [] : [seq];
            });
            this.applyMessages(sessionId, batch, seqs.length ? Math.max(...seqs) : undefined);
        };
        const pending = this.sessionMessageQueue.get(sessionId);
        if (pending?.length && wireIds) {
            // Unrelated/local-only queued rows are not certified by this wire
            // replacement. Leave them owned by the normal projection queue.
            const batch = pending.filter(message => wireIds.has(message.id));
            for (let index = pending.length - 1; index >= 0; index--) {
                if (wireIds.has(pending[index].id)) pending.splice(index, 1);
            }
            if (batch.length) apply(batch);
            return;
        }
        while (pending?.length) apply(pending.splice(0, pending.length));
    }

    private hasPendingOutboxMessages() {
        if (this.sendAbortControllers.size > 0) {
            return true;
        }
        for (const messages of this.pendingOutbox.values()) {
            if (messages.length > 0) {
                return true;
            }
        }
        return false;
    }

    private maybeStartBackgroundSendWatchdog() {
        if (Platform.OS === 'web' || this.appState === 'active') {
            return;
        }
        if (!this.hasPendingOutboxMessages() || this.backgroundSendTimeout) {
            return;
        }

        log.log('📨 Pending messages detected in background. Starting 30s send watchdog.');
        this.backgroundSendStartedAt = Date.now();
        this.backgroundSendTimeout = setTimeout(() => {
            this.backgroundSendTimeout = null;
            void this.handleBackgroundSendTimeout();
        }, Sync.BACKGROUND_SEND_TIMEOUT_MS);
        void this.scheduleBackgroundSendTimeoutNotification();
    }

    private clearBackgroundSendWatchdog() {
        if (this.backgroundSendTimeout) {
            clearTimeout(this.backgroundSendTimeout);
            this.backgroundSendTimeout = null;
        }
        this.backgroundSendStartedAt = null;
    }

    private async scheduleBackgroundSendTimeoutNotification() {
        if (Platform.OS === 'web' || this.backgroundSendNotificationId) {
            return;
        }
        try {
            this.backgroundSendNotificationId = await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message not sent',
                    body: 'A message is still sending in the background. It will fail in 30 seconds if not delivered.',
                    sound: true
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                    seconds: Math.ceil(Sync.BACKGROUND_SEND_TIMEOUT_MS / 1000)
                }
            });
        } catch (error) {
            log.log(`Failed to schedule background send timeout notification: ${error}`);
        }
    }

    private async cancelBackgroundSendTimeoutNotification() {
        if (!this.backgroundSendNotificationId) {
            return;
        }
        try {
            await Notifications.cancelScheduledNotificationAsync(this.backgroundSendNotificationId);
        } catch (error) {
            log.log(`Failed to cancel background send timeout notification: ${error}`);
        } finally {
            this.backgroundSendNotificationId = null;
        }
    }

    private async notifyMessageSendFailed() {
        if (Platform.OS === 'web') {
            return;
        }
        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message failed',
                    body: 'A message failed to send while the app was in background. Open Paws and retry.',
                    sound: true
                },
                trigger: null
            });
        } catch (error) {
            log.log(`Failed to schedule message failure notification: ${error}`);
        }
    }

    private failPendingOutboxMessages(reasonText: string) {
        for (const controller of this.sendAbortControllers.values()) {
            controller.abort();
        }
        this.sendAbortControllers.clear();

        const now = Date.now();
        const sessionIds: string[] = [];
        for (const [sessionId, pending] of this.pendingOutbox) {
            if (pending.length === 0) {
                continue;
            }
            pending.length = 0;
            this.pendingOutbox.delete(sessionId);
            sessionIds.push(sessionId);
        }

        for (const sessionId of sessionIds) {
            this.enqueueMessages(sessionId, [{
                id: randomUUID(),
                localId: null,
                createdAt: now,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'message',
                    message: reasonText
                }
            }]);
        }
    }

    private async handleBackgroundSendTimeout() {
        if (!this.hasPendingOutboxMessages()) {
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
            return;
        }

        await this.cancelBackgroundSendTimeoutNotification();
        await this.notifyMessageSendFailed();
        this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
        this.backgroundSendStartedAt = null;
    }

    /**
     * Upload attachments for a session. Images stay E2E-encrypted; audio/video
     * stream directly to private object storage without entering JS memory.
     * Returns UploadedAttachment records to embed as file events before the text message.
     * Failures are logged and skipped rather than aborting the whole message send.
     */
    private async uploadAttachmentsForSession(
        sessionId: string,
        attachments: AttachmentPreview[],
        isCurrent: () => boolean = () => true,
    ): Promise<{ uploaded: UploadedAttachment[]; failed: number }> {
        if (!this.credentials) return { uploaded: [], failed: attachments.length };

        const blobKey = this.encryption.getSessionBlobKey(sessionId);
        const credentials = this.credentials;
        const assertCurrent = () => { if (!isCurrent()) throw new Error('local-message-session-unavailable'); };

        const uploaded: UploadedAttachment[] = [];
        let failed = 0;

        for (const attachment of attachments) {
            assertCurrent();
            try {
                uploaded.push(await uploadAttachmentForSession(
                    {
                        credentials,
                        sessionId,
                        attachment,
                        blobKey: blobKey ?? undefined,
                    },
                    {
                        requestUpload: (...args) => { assertCurrent(); return requestAttachmentUpload(...args); },
                        uploadMediaFile: (...args) => { assertCurrent(); return uploadMediaFile(...args); },
                        readFileBytes,
                        encryptBlob,
                        uploadEncryptedBlob: (...args) => { assertCurrent(); return uploadEncryptedBlob(...args); },
                    },
                ));
            } catch (err) {
                assertCurrent();
                failed++;
                // Skip this attachment; do not abort the whole message send.
            }
        }

        return { uploaded, failed };
    }

    async sendMessage(sessionId: string, text: string, options?: SendMessageOptions): Promise<LocalMessageQueueReceipt> {
        const isCurrent = options?.isCurrent ?? (() => true);
        if (!isCurrent()) throw new Error('local-message-session-unavailable');

        // Snapshot per-turn controls before the first possible await. If the
        // user changes model/effort while attachment upload or initial sync is
        // still pending, that new choice must apply to the next message rather
        // than rewriting the turn that was already submitted.
        const modeSessionSnapshot = storage.getState().sessions[sessionId];
        const modeSettingsSnapshot = storage.getState().settings;

        const encryptionOwner = this.encryption;
        const encryption = encryptionOwner.getSessionEncryption(sessionId);
        const session = storage.getState().sessions[sessionId];
        if (!encryption || !session) throw new Error('local-message-session-unavailable');
        const stagedOutbox: OutboxMessage[] = [];
        const stagedMessages: NormalizedMessage[] = [];

        const modeMeta = resolveMessageModeMeta(modeSessionSnapshot ?? session, modeSettingsSnapshot);
        const { displayText, editedFromMessageId, source = 'chat', attachments } = options ?? {};

        // OpenCode's ACP runner accepts images; Claude/Codex also stage media files.
        // Reject unsupported submissions as a whole, never silently drop attachments.
        const flavor = session.metadata?.flavor;
        const supportsAttachments = !flavor || flavor === 'claude' || flavor === 'codex'
            || (flavor === 'opencode' && (attachments ?? []).every(a => !a.kind || a.kind === 'image'));
        const effectiveAttachments = supportsAttachments ? attachments : undefined;

        if (attachments && attachments.length > 0 && !supportsAttachments) {
            Modal.alert(
                t('imageUpload.notSupportedTitle'),
                t('imageUpload.notSupportedMessage'),
                [{ text: t('common.ok'), style: 'cancel' }],
            );
            throw new Error('local-message-attachments-unsupported');
        }

        // Upload attachments and queue file events before the text message.
        if (effectiveAttachments && effectiveAttachments.length > 0) {
            const { uploaded, failed } = await this.uploadAttachmentsForSession(sessionId, effectiveAttachments, isCurrent);
            if (!isCurrent()) throw new Error('local-message-session-unavailable');

            if (failed > 0) {
                Modal.alert(
                    t('imageUpload.uploadFailedTitle'),
                    t('imageUpload.uploadFailedMessage', { count: failed }),
                    [{ text: t('common.ok'), style: 'cancel' }],
                );
                throw new Error('local-message-attachment-upload-failed');
            }
            if (uploaded.length !== effectiveAttachments.length) throw new Error('local-message-attachment-upload-incomplete');

            if (uploaded.length > 0) {
                for (const att of uploaded) {
                    const fileRecord: RawRecord = {
                        role: 'session',
                        content: {
                            type: 'session',
                            data: {
                                id: randomUUID(),
                                time: Date.now(),
                                role: 'user',
                                ev: {
                                    t: 'file',
                                    ref: att.ref,
                                    name: att.name,
                                    size: att.size,
                                    // Non-image attachments need kind + MIME metadata so the
                                    // terminal stages them to a local path. Audio/video may be
                                    // plaintext (encrypted:false); PDF files stay E2E encrypted.
                                    ...(att.kind && att.kind !== 'image'
                                        ? { kind: att.kind, ...(att.mimeType ? { mimeType: att.mimeType } : {}) }
                                        : {}),
                                    ...(att.encrypted !== undefined ? { encrypted: att.encrypted } : {}),
                                    ...(att.motionPhoto ? { motionPhoto: att.motionPhoto } : {}),
                                    // Include image metadata when we have dimensions; thumbhash is
                                    // optional. The native iOS picker can't generate a thumbhash
                                    // without Canvas, so requiring it here would reduce the chat
                                    // bubble to a compact filename row instead of an inline picture.
                                    // FileView only needs w/h to size the inline render — placeholder
                                    // is absent, but the real image is decrypted on mount.
                                    ...(att.width > 0 && att.height > 0
                                        ? {
                                            image: {
                                                width: att.width,
                                                height: att.height,
                                                ...(att.thumbhash ? { thumbhash: att.thumbhash } : {}),
                                            },
                                        }
                                        : {}),
                                },
                            },
                        },
                    };
                    const encryptedFileRecord = await encryption.encryptRawRecord(fileRecord);
                    const fileLocalId = randomUUID();
                    const fileNormalized = normalizeRawMessage(fileLocalId, fileLocalId, Date.now(), fileRecord);
                    if (fileNormalized) {
                        stagedMessages.push(fileNormalized);
                    }
                    stagedOutbox.push({ localId: fileLocalId, content: encryptedFileRecord });
                }
            }
        }

        // Generate local ID
        const localId = randomUUID();

        // Determine sentFrom based on platform
        let sentFrom: string;
        if (Platform.OS === 'web') {
            sentFrom = 'web';
        } else if (Platform.OS === 'android') {
            sentFrom = 'android';
        } else if (Platform.OS === 'ios') {
            // Check if running on Mac (Catalyst or Designed for iPad on Mac)
            if (isRunningOnMac()) {
                sentFrom = 'mac';
            } else {
                sentFrom = 'ios';
            }
        } else {
            sentFrom = 'web'; // fallback
        }

        // Create user message content with metadata
        const content: RawRecord = {
            role: 'user',
            content: {
                type: 'text',
                text
            },
            meta: {
                sentFrom,
                appendSystemPrompt: [systemPrompt, storage.getState().settings.customInstructions?.trim()].filter(Boolean).join('\n\n'),
                ...(modeMeta.permissionMode !== undefined ? { permissionMode: modeMeta.permissionMode } : {}),
                ...(modeMeta.permissionModeExplicit ? { permissionModeExplicit: true } : {}),
                ...(modeMeta.model !== undefined ? { model: modeMeta.model } : {}),
                ...(modeMeta.effort !== undefined ? { effort: modeMeta.effort } : {}),
                ...(modeMeta.fast !== undefined ? { fast: modeMeta.fast } : {}),
                ...(displayText && { displayText }), // Add displayText if provided
                ...(editedFromMessageId && { editedFromMessageId })
            }
        };
        const encryptedRawRecord = await encryption.encryptRawRecord(content);

        // Add to messages - normalize the raw record
        const createdAt = Date.now();
        const normalizedMessage = normalizeRawMessage(localId, localId, createdAt, content);
        if (normalizedMessage) {
            stagedMessages.push(normalizedMessage);
        }
        stagedOutbox.push({
            localId,
            content: encryptedRawRecord
        });

        // No awaits between ownership validation and the complete outbox commit.
        // Nothing from a failed upload/encryption attempt becomes locally queued.
        if (!isCurrent() || this.encryption !== encryptionOwner
            || encryptionOwner.getSessionEncryption(sessionId) !== encryption
            || !storage.getState().sessions[sessionId]) throw new Error('local-message-session-unavailable');
        // Preserve the queue identity: an in-flight flush owns a prefix of this
        // array and removes only that prefix when its acknowledgement arrives.
        const pending = this.pendingOutbox.get(sessionId) ?? [];
        pending.push(...stagedOutbox);
        this.pendingOutbox.set(sessionId, pending);
        const generation: SessionMessageCacheGeneration = this.sessionMessageCacheGenerations.get(sessionId) ?? {};
        generation.localMessageIds ??= new Map();
        generation.acceptedLocalMessages ??= new Map();
        generation.pendingLocalMessages ??= new Map();
        for (const message of stagedMessages) {
            const identity = message.localId ?? message.id;
            generation.localMessageIds.set(identity, message.id);
            generation.acceptedLocalMessages.set(identity, message);
            generation.pendingLocalMessages.set(identity, message);
        }
        this.sessionMessageCacheGenerations.set(sessionId, generation);
        const receipt: LocalMessageQueueReceipt = Object.freeze({ type: 'queued', sessionId, localIds: Object.freeze(stagedOutbox.map(item => item.localId)) });
        let receipts = this.acceptedLocalMessageReceipts.get(sessionId);
        if (!receipts) {
            receipts = new WeakMap();
            this.acceptedLocalMessageReceipts.set(sessionId, receipts);
        }
        receipts.set(receipt, stagedMessages);
        // After commit, ancillary failures must not turn an accepted message into
        // a retry that duplicates it. Reconnect also retries the encrypted outbox.
        try {
            if (this.historyWindows.get(sessionId)?.isAtLatest === false) {
                // Sending accepts a new live turn, but does not replace the
                // user's historical reading window with optimistic tail rows.
                storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, [sessionId]: {
                    ...state.sessionMessages[sessionId], hasMoreNewer: true, isAtLatest: false,
                } } }));
            } else this.enqueueMessages(sessionId, stagedMessages);
        } catch { /* accepted; recover from outbox */ }
        try { this.getSendSync(sessionId).invalidate(); this.maybeStartBackgroundSendWatchdog(); } catch { /* reconnect retries */ }
        try { trackMessageSent(source, session.metadata); } catch { /* best effort */ }

        try {
            const fallbackTitle = deriveSessionFallbackTitle(text, effectiveAttachments);
            if (
                fallbackTitle
                && session.metadata
                && !session.metadata.summary?.text.trim()
                && !this.sessionFallbackTitleInFlight.has(sessionId)
            ) {
                this.sessionFallbackTitleInFlight.add(sessionId);
                void ensureSessionFallbackTitle({
                    sessionId,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    sessionEncryption: encryption,
                    title: fallbackTitle,
                }).catch(() => {
                    // Title updates are ancillary to the confirmed local queue.
                }).finally(() => {
                    this.sessionFallbackTitleInFlight.delete(sessionId);
                });
            }
        } catch { /* title derivation cannot invalidate a committed receipt */ }

        return receipt;
    }

    /** Server sent us settings — merge any pending local changes on top, then apply as one update. */
    private applyServerSettings = (serverSettings: Settings, version: number, rawServerSettings: unknown) => {
        const rawServerSidebarOrganization = !!rawServerSettings
            && typeof rawServerSettings === 'object'
            && !Array.isArray(rawServerSettings)
            && Object.prototype.hasOwnProperty.call(rawServerSettings, 'sidebarOrganization')
            ? (rawServerSettings as { sidebarOrganization: unknown }).sidebarOrganization
            : undefined;
        const hasValidServerSidebarOrganization = isValidSidebarOrganizationPayload(rawServerSidebarOrganization);
        const hasUsableServerSidebarOrganization = isUsableSidebarOrganizationPayload(rawServerSidebarOrganization);
        const hasServerSessionPinnedOrderField = !!rawServerSettings
            && typeof rawServerSettings === 'object'
            && !Array.isArray(rawServerSettings)
            && Object.prototype.hasOwnProperty.call(rawServerSettings, 'sessionPinnedOrder');
        const rawServerSessionPinnedOrder = hasServerSessionPinnedOrderField
            ? (rawServerSettings as { sessionPinnedOrder: unknown }).sessionPinnedOrder
            : undefined;
        const hasValidServerSessionPinnedOrder = isValidSessionPinnedOrderPayload(rawServerSessionPinnedOrder);
        const legacyLocalOrganization = storage.getState().localSettings.sidebarOrganization;
        const legacyLocalPinnedOrder = loadLegacySessionPinnedOrder();
        if (hasServerSessionPinnedOrderField
            && !hasValidServerSessionPinnedOrder
            && Object.prototype.hasOwnProperty.call(this.pendingSettings, 'sessionPinnedOrder')) {
            // A newer client owns an unrecognized representation. Do not let an
            // older pending array overwrite it during a version-conflict retry.
            const {
                sessionPinnedOrder: _unsupportedPendingPinnedOrder,
                sessionPinnedOrderRaw: _pendingRawReset,
                ...compatiblePending
            } = this.pendingSettings;
            this.pendingSettings = compatiblePending;
            this.pendingSessionPinnedOrderBase = null;
            savePendingSessionPinnedState(null);
            savePendingSettings(this.pendingSettings);
        }
        if (this.pendingSettings.sidebarOrganization
            && this.pendingSidebarOrganizationBase
            && hasUsableServerSidebarOrganization) {
            this.pendingSettings = {
                ...this.pendingSettings,
                sidebarOrganization: mergeSidebarOrganizations(
                    this.pendingSidebarOrganizationBase,
                    this.pendingSettings.sidebarOrganization,
                    serverSettings.sidebarOrganization,
                ),
            };
            this.pendingSidebarOrganizationBase = serverSettings.sidebarOrganization;
            savePendingSettings(this.pendingSettings);
            savePendingSidebarOrganizationBase(this.pendingSidebarOrganizationBase);
        }
        if (!Object.prototype.hasOwnProperty.call(this.pendingSettings, 'sidebarOrganization')) {
            const migration = resolveSidebarOrganizationMigration(
                rawServerSettings,
                storage.getState().settings.sidebarOrganization,
                legacyLocalOrganization,
            );
            if (migration.shouldUpload) {
                this.pendingSidebarOrganizationBase = serverSettings.sidebarOrganization;
                const migratedOrganization = mergeSidebarOrganizations(
                    emptySidebarOrganization,
                    migration.organization,
                    serverSettings.sidebarOrganization,
                );
                this.pendingSettings = {
                    ...this.pendingSettings,
                    sidebarOrganization: migratedOrganization,
                };
                savePendingSettings(this.pendingSettings);
                savePendingSidebarOrganizationBase(this.pendingSidebarOrganizationBase);
                this.settingsSync.invalidate();
            }
        }
        if (hasValidServerSidebarOrganization && !isSidebarOrganizationEmpty(legacyLocalOrganization)) {
            storage.getState().applyLocalSettings({ sidebarOrganization: emptySidebarOrganization });
        }
        if (this.pendingSettings.sessionPinnedOrder
            && this.pendingSessionPinnedOrderBase
            && hasValidServerSessionPinnedOrder) {
            this.pendingSettings = {
                ...this.pendingSettings,
                sessionPinnedOrder: mergeSessionPinnedOrders(
                    this.pendingSessionPinnedOrderBase,
                    this.pendingSettings.sessionPinnedOrder,
                    serverSettings.sessionPinnedOrder,
                ),
            };
            this.pendingSessionPinnedOrderBase = serverSettings.sessionPinnedOrder;
            savePendingSessionPinnedState({
                value: this.pendingSettings.sessionPinnedOrder!,
                base: this.pendingSessionPinnedOrderBase,
                clearRaw: true,
            });
            savePendingSettings(this.pendingSettings);
        }
        if (!Object.prototype.hasOwnProperty.call(this.pendingSettings, 'sessionPinnedOrder')) {
            const migration = resolveSessionPinnedOrderMigration(
                rawServerSettings,
                storage.getState().settings.sessionPinnedOrder,
                legacyLocalPinnedOrder,
            );
            if (migration.shouldUpload) {
                this.pendingSessionPinnedOrderBase = serverSettings.sessionPinnedOrder;
                this.pendingSettings = {
                    ...this.pendingSettings,
                    sessionPinnedOrder: mergeSessionPinnedOrders(
                        [],
                        migration.pinnedOrder,
                        serverSettings.sessionPinnedOrder,
                    ),
                };
                savePendingSessionPinnedState({
                    value: this.pendingSettings.sessionPinnedOrder!,
                    base: this.pendingSessionPinnedOrderBase,
                    clearRaw: true,
                });
                savePendingSettings(this.pendingSettings);
                this.settingsSync.invalidate();
            }
        }
        if (hasValidServerSessionPinnedOrder && legacyLocalPinnedOrder.length > 0) {
            clearLegacySessionPinnedOrder();
        }
        const merged = mergeServerSettings(
            storage.getState().settings,
            serverSettings,
            this.pendingSettings,
            rawServerSettings,
        );
        storage.getState().applySettings(merged, version);
    }

    applySettings = (delta: Partial<Settings>) => {
        const normalizedDelta = Object.prototype.hasOwnProperty.call(delta, 'sessionPinnedOrder')
            ? { ...delta, sessionPinnedOrderRaw: null }
            : delta;
        if (Object.prototype.hasOwnProperty.call(delta, 'sidebarOrganization')
            && !Object.prototype.hasOwnProperty.call(this.pendingSettings, 'sidebarOrganization')) {
            this.pendingSidebarOrganizationBase = storage.getState().settings.sidebarOrganization;
            savePendingSidebarOrganizationBase(this.pendingSidebarOrganizationBase);
        }
        if (Object.prototype.hasOwnProperty.call(normalizedDelta, 'sessionPinnedOrder')
            && !Object.prototype.hasOwnProperty.call(this.pendingSettings, 'sessionPinnedOrder')) {
            this.pendingSessionPinnedOrderBase = storage.getState().settings.sessionPinnedOrder;
        }
        if (Object.prototype.hasOwnProperty.call(normalizedDelta, 'sessionPinnedOrder')) {
            savePendingSessionPinnedState({
                value: normalizedDelta.sessionPinnedOrder!,
                base: this.pendingSessionPinnedOrderBase ?? storage.getState().settings.sessionPinnedOrder,
                clearRaw: true,
            });
        }
        storage.getState().applySettingsLocal(normalizedDelta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...normalizedDelta };
        savePendingSettings(this.pendingSettings);

        // Sync PostHog opt-out state if it was changed
        if (tracking && 'analyticsOptOut' in delta) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // Invalidate settings sync
        this.settingsSync.invalidate();
    }

    refreshPurchases = () => {
        this.purchasesSync.invalidate();
    }

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    purchaseProduct = async (productId: string): Promise<{ success: boolean; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Fetch the product
            const products = await RevenueCat.getProducts([productId]);
            if (products.length === 0) {
                return { success: false, error: `Product '${productId}' not found` };
            }

            // Purchase the product
            const product = products[0];
            const { customerInfo } = await RevenueCat.purchaseStoreProduct(product);

            // Update local purchases data
            storage.getState().applyPurchases(customerInfo);

            return { success: true };
        } catch (error: any) {
            // Check if user cancelled
            if (error.userCancelled) {
                return { success: false, error: 'Purchase cancelled' };
            }

            // Return the error message
            return { success: false, error: error.message || 'Purchase failed' };
        }
    }

    getOfferings = async (): Promise<{ success: boolean; offerings?: any; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Fetch offerings
            const offerings = await RevenueCat.getOfferings();

            // Return the offerings data
            return {
                success: true,
                offerings: {
                    current: offerings.current,
                    all: offerings.all
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || 'Failed to fetch offerings' };
        }
    }

    presentPaywall = async (flow?: string): Promise<{ success: boolean; purchased?: boolean; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                const error = 'RevenueCat not initialized';
                trackPaywallError(error, flow);
                return { success: false, error };
            }

            // Track paywall presentation
            trackPaywallPresented(flow);

            // Present the paywall (with flow custom variable if specified)
            const result = await RevenueCat.presentPaywall(
                flow ? { customVariables: { flow } } : undefined
            );

            // Handle the result
            switch (result) {
                case PaywallResult.PURCHASED:
                    trackPaywallPurchased(flow);
                    // Refresh customer info after purchase
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.RESTORED:
                    trackPaywallRestored(flow);
                    // Refresh customer info after restore
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.CANCELLED:
                    trackPaywallCancelled(flow);
                    return { success: true, purchased: false };
                case PaywallResult.NOT_PRESENTED:
                    trackPaywallError('Paywall not presented', flow);
                    return { success: false, error: 'Paywall not available on this platform' };
                case PaywallResult.ERROR:
                default:
                    const errorMsg = 'Failed to present paywall';
                    trackPaywallError(errorMsg, flow);
                    return { success: false, error: errorMsg };
            }
        } catch (error: any) {
            const errorMessage = error.message || 'Failed to present paywall';
            trackPaywallError(errorMessage, flow);
            return { success: false, error: errorMessage };
        }
    }

    //
    // Private
    //

    private fetchActiveSessions = async () => {
        if (!this.credentials) return;
        await this.writeSessionSnapshots(() => fetchActiveSessionSnapshots(this.credentials!, INITIAL_ACTIVE_SESSION_LIMIT));
    }

    private resetSessionListOwner = () => {
        this.cancelScheduledSessionHistory?.();
        this.sessionHistoryTask = null;
        this.sessionHistoryReconciliationPending = false;
        this.sessionListOwner = this.encryption;
        this.sessionBootstrapInFlight = null;
        this.sessionHistoryInFlight = null;
        this.nextSessionHistoryCursor = undefined;
        this.initialSessionHistoryScheduled = false;
        useSessionListSyncState.setState({ bootstrap: 'idle', history: 'idle' });
    };

    public bootstrapSessions = (options: { routeReady?: boolean } = {}): Promise<void> => {
        if (this.sessionListOwner !== this.encryption) this.resetSessionListOwner();
        if (!options.routeReady && this.shouldPrioritizeInitialSessionRoute()) {
            this.initialSessionBootstrapDeferred = true;
            return Promise.resolve();
        }
        this.initialSessionBootstrapDeferred = false;
        this.boundedSessionBootstrapDeferred = false;
        if (this.sessionBootstrapInFlight) return this.sessionBootstrapInFlight;
        const owner = this.captureHistoryOwner('');
        useSessionListSyncState.setState({ bootstrap: 'loading' });
        const request = (async () => {
            try {
                await this.fetchActiveSessions();
                if (!owner.isCurrent()) return;
                storage.getState().applyReady();
                useSessionListSyncState.setState({ bootstrap: 'ready' });
            } catch {
                if (owner.isCurrent()) useSessionListSyncState.setState({ bootstrap: 'error' });
            }
        })().finally(() => {
            if (this.sessionBootstrapInFlight === request) this.sessionBootstrapInFlight = null;
        });
        this.sessionBootstrapInFlight = request;
        return request;
    }

    public hydrateHistoricalSessionPage = async (
        cursor?: string,
    ): Promise<string | null> => {
        if (!this.credentials) return null;
        let nextCursor: string | null = null;
        await this.writeSessionSnapshots(async () => {
            const page = await fetchSessionSnapshotPage(this.credentials, {
                ...(cursor === undefined ? {} : { cursor }), limit: 50,
            });
            nextCursor = page.hasNext ? page.nextCursor : null;
            return page.sessions;
        });
        return nextCursor;
    }

    public sessionRouteBecameInteractive = async (): Promise<void> => {
        if (this.sessionListOwner !== this.encryption) this.resetSessionListOwner();
        this.releaseDeferredSessionWork(this.sessionRouteOwnership.current() ?? undefined);
        if (this.initialSessionHistoryScheduled) {
            if (!this.sessionHistoryTask && !this.sessionHistoryInFlight
                && this.historyReconciliationDeferred) this.requestHistoryReconciliation();
            return;
        }
        this.initialSessionHistoryScheduled = true;
        // This intent outlives a failed page and is consumed by the successful
        // automatic page or manual retry, not by firing/cancelling its timer.
        this.sessionHistoryReconciliationPending = true;
        const task = {};
        this.sessionHistoryTask = task;
        const owner = this.captureHistoryOwner('');
        await new Promise<void>(resolve => {
            let idle: number | undefined;
            let finished = false;
            const cleanup = () => {
                clearTimeout(fallback);
                if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
                if (this.cancelScheduledSessionHistory === cancel) this.cancelScheduledSessionHistory = null;
            };
            const cancel = () => { finished = true; cleanup(); resolve(); };
            const run = () => {
                if (finished) return;
                finished = true;
                cleanup();
                if (!owner.isCurrent()) { resolve(); return; }
                void (async () => {
                    // Idle grants CPU time, not permission to compete with the
                    // active summary/target network lane. Direct bootstrap
                    // attempts are owned outside the invalidator queue.
                    await this.sessionBootstrapInFlight;
                    await this.sessionBootstrapSync.awaitQueue();
                    if (!owner.isCurrent()) return;
                    if (this.shouldPrioritizeInitialSessionRoute()) {
                        this.initialSessionHistoryScheduled = false;
                        this.historyReconciliationDeferred = true;
                        return;
                    }
                    const loaded = await this.requestNextSessionHistoryPage();
                    if (loaded && owner.isCurrent() && this.sessionHistoryReconciliationPending) {
                        this.sessionHistoryReconciliationPending = false;
                        this.requestHistoryReconciliation();
                    }
                })().finally(resolve);
            };
            const fallback = setTimeout(run, 1000);
            this.cancelScheduledSessionHistory = cancel;
            if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run, { timeout: 1000 });
        }).finally(() => {
            if (this.sessionHistoryTask === task) this.sessionHistoryTask = null;
        });
    }

    public loadNextSessionHistoryPage = async (): Promise<boolean> => {
        if (this.sessionListOwner !== this.encryption) this.resetSessionListOwner();
        const owner = this.captureHistoryOwner('');
        if (this.cancelScheduledSessionHistory) {
            this.cancelScheduledSessionHistory();
        }
        this.initialSessionHistoryScheduled = true;
        const task = {};
        this.sessionHistoryTask = task;
        let loaded = false;
        try {
            if (this.sessionBootstrapInFlight) await this.sessionBootstrapInFlight;
            if (!owner.isCurrent()) return false;
            loaded = await this.requestNextSessionHistoryPage();
            if (loaded && owner.isCurrent() && this.sessionHistoryReconciliationPending) {
                this.sessionHistoryReconciliationPending = false;
                this.requestHistoryReconciliation();
            }
        } finally {
            if (this.sessionHistoryTask === task) this.sessionHistoryTask = null;
        }
        return loaded && this.nextSessionHistoryCursor !== null;
    }

    private requestNextSessionHistoryPage = async (): Promise<boolean> => {
        if (this.nextSessionHistoryCursor === null) return true;
        if (this.sessionHistoryInFlight) {
            return this.sessionHistoryInFlight;
        }

        const cursor = this.nextSessionHistoryCursor;
        const owner = this.captureHistoryOwner('');
        useSessionListSyncState.setState({ history: 'loading' });
        const request = (async () => {
            try {
                const nextCursor = await this.hydrateHistoricalSessionPage(cursor);
                if (!owner.isCurrent()) return false;
                this.nextSessionHistoryCursor = nextCursor;
                useSessionListSyncState.setState({ history: 'ready' });
                return true;
            } catch (error) {
                log.log('session-history-load-failed');
                if (owner.isCurrent()) {
                    this.initialSessionHistoryScheduled = false;
                    useSessionListSyncState.setState({ history: 'error' });
                }
                return false;
            }
        })();
        const trackedRequest = request.finally(() => {
            if (this.sessionHistoryInFlight === trackedRequest) {
                this.sessionHistoryInFlight = null;
            }
        });
        this.sessionHistoryInFlight = trackedRequest;
        return trackedRequest;
    }

    private fetchSessions = async () => {
        if (!this.credentials) return;
        if (this.localHistory) {
            await this.reconcileHistory();
            if (this.changesSupported) return;
        }
        await this.writeSessionSnapshots(() => fetchLegacySessionSnapshots(this.credentials), { replace: false });
        if (!this.localHistory && Platform.OS !== 'web') await this.reconcileHistory();
    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    /**
     * Hydrate one freshly spawned session without decrypting the account's
     * complete history. The daemon only resolves a successful spawn after the
     * session has reported to the server, so the row is available here.
     *
     * `/new` previously awaited refreshSessions(), which decrypts up to 150
     * sessions and can be queued twice when the concurrent `new-session`
     * broadcast also invalidates the same sync. The session and even its first
     * reply could already exist while the compose page kept spinning.
     */
    public ensureSessionHydrated = async (sessionId: string): Promise<boolean> => {
        const existing = this.sessionHydrations.get(sessionId);
        if (existing) return existing;
        const request = this.hydrateSessionSnapshot(sessionId);
        this.sessionHydrations.set(sessionId, request);
        try { return await request; }
        finally {
            if (this.sessionHydrations.get(sessionId) === request) this.sessionHydrations.delete(sessionId);
        }
    }

    /** Every async snapshot source prepares privately, then commits encryption
     * and store in the same synchronous turn under one deletion generation. */
    private writeSessionSnapshots = async (
        load: () => Promise<ApiSessionSnapshot[]>,
        options: SessionApplyOptions = { replace: false },
        operation?: SessionRouteOperation,
        persist = true,
    ): Promise<HydratedSession[]> => {
        const write = { mutationGeneration: this.sessionMutationGeneration };
        const encryptionOwner = this.encryption;
        const historyOwner = this.localHistory;
        const warmAccount = this.sessionWarmCacheAccountKey;
        const scopeOwner = this.captureHistoryOwner('');
        this.inFlightSessionRefreshes.add(write);
        const committed: HydratedSession[] = [];
        const committedWireSnapshots: ApiSessionSnapshot[] = [];
        try {
            const snapshots = deduplicateSessionSnapshots(await load());
            for (let offset = 0; offset < snapshots.length; offset += 10) {
                if (offset > 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
                if (!scopeOwner.isCurrent()) break;
                let pending = snapshots.slice(offset, offset + 10);
                for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
                    const preparedBatch: Array<{
                        snapshot: ApiSessionSnapshot;
                        prepared: NonNullable<Awaited<ReturnType<typeof hydrateSessionSnapshotForRoute>>>;
                        assertCurrent: () => void;
                    }> = [];
                    for (const snapshot of pending) {
                        const fence = historyOwner?.captureSessionFence(snapshot.id);
                        const assertCurrent = () => {
                            if (operation) this.assertSessionRouteCurrent(operation);
                            if (!scopeOwner.isCurrent() || this.encryption !== encryptionOwner || this.localHistory !== historyOwner
                                || (historyOwner && fence && !historyOwner.isFenceCurrent(fence))
                                || (this.sessionDeletionMutationGenerations.get(snapshot.id) ?? 0) > write.mutationGeneration) {
                                throw new SessionWriteCancelled();
                            }
                        };
                        try {
                            assertCurrent();
                            const prepared = await hydrateSessionSnapshotForRoute(snapshot, encryptionOwner, { assertCurrent });
                            assertCurrent();
                            if (prepared) preparedBatch.push({ snapshot, prepared, assertCurrent });
                        } catch (error) {
                            if (operation && !(error instanceof SessionWriteCancelled)) throw error;
                            // Corrupt ciphertext is isolated to its row. Account and
                            // deletion cancellation never prevents healthy rows committing.
                        }
                    }
                    pending = [];
                    const batch: HydratedSession[] = [];
                    // No await between these final ownership checks, installing
                    // encryption and publishing the corresponding batch of rows.
                    for (const { snapshot, prepared, assertCurrent } of preparedBatch) {
                        try { assertCurrent(); }
                        catch (error) {
                            if (!(error instanceof SessionWriteCancelled)) throw error;
                            continue;
                        }
                        if (!prepared.commitEncryption()) { pending.push(snapshot); continue; }
                        batch.push(prepared.session);
                        committedWireSnapshots.push(snapshot);
                    }
                    this.applySessions(batch, { replace: false });
                    committed.push(...batch);
                }
            }
            const current = scopeOwner.isCurrent();
            if (options.replace && current) this.applySessions(committed, options, write.mutationGeneration);
            if (persist && current && warmAccount && this.sessionWarmCacheAccountKey === warmAccount && committedWireSnapshots.length > 0) {
                const survivingSnapshots = committedWireSnapshots.filter(snapshot =>
                    (this.sessionDeletionMutationGenerations.get(snapshot.id) ?? 0) <= write.mutationGeneration);
                saveSessionWarmSnapshots(warmAccount, survivingSnapshots);
                await historyOwner?.writeSnapshots(survivingSnapshots);
            }
            return committed;
        } finally {
            this.inFlightSessionRefreshes.delete(write);
            this.pruneSessionDeletionTombstones();
        }
    }

    private hydrateSessionSnapshot = async (
        sessionId: string,
        operation?: SessionRouteOperation,
    ): Promise<boolean> => {
        if (operation) this.assertSessionRouteCurrent(operation);
        if (!this.credentials) return false;

        // Attribute this route's hydration operation, including a cache hit or
        // waiting for another writer. Earlier bootstrap I/O is not this span.
        if (operation) markSessionCriticalPathAppStage('web.session.snapshot_started');
        const complete = (found: boolean): boolean => {
            if (operation) {
                this.assertSessionRouteCurrent(operation);
                if (found) markSessionCriticalPathAppStage('web.session.snapshot_completed');
            }
            return found;
        };
        if (storage.getState().sessions[sessionId]
            && this.encryption.getSessionEncryption(sessionId)) return complete(true);

        if (operation && this.sessionHydrations.has(sessionId)) {
            await this.sessionHydrations.get(sessionId);
            this.assertSessionRouteCurrent(operation);
            if (storage.getState().sessions[sessionId] && this.encryption.getSessionEncryption(sessionId)) return complete(true);
        }
        let usedCache = false;
        try {
            await this.writeSessionSnapshots(async () => {
                const cached = await this.localHistory?.readSnapshot(sessionId);
                if (cached) { usedCache = true; return [cached]; }
                const raw = await fetchSessionSnapshot(this.credentials, sessionId);
                return raw ? [raw] : [];
            }, { replace: false }, operation);
        } catch (error) {
            if (!usedCache) throw error;
            if (operation) this.assertSessionRouteCurrent(operation);
        }
        if (usedCache && !(storage.getState().sessions[sessionId] && this.encryption.getSessionEncryption(sessionId))) {
            await this.writeSessionSnapshots(async () => {
                const raw = await fetchSessionSnapshot(this.credentials, sessionId);
                return raw ? [raw] : [];
            }, { replace: false }, operation);
        }
        return complete(Boolean(storage.getState().sessions[sessionId] && this.encryption.getSessionEncryption(sessionId)));
    }

    private ensureRealtimeSessionReady = async (sessionId: string): Promise<boolean> => {
        const isReady = () => Boolean(
            storage.getState().sessions[sessionId]
            && this.encryption.getSessionEncryption(sessionId),
        );
        if (isReady()) return true;

        await (this.sessionBootstrapInFlight ?? this.sessionBootstrapSync.awaitQueue());
        if (isReady()) return true;

        if (!await this.ensureSessionHydrated(sessionId)) return false;
        return isReady();
    }

    public beginSessionRoute = (sessionId: string): SessionRouteOwner => {
        const previous = this.sessionRouteOwnership.current();
        if (previous) this.leaveSessionRoute(previous);
        const owner = this.sessionRouteOwnership.enter(sessionId);
        sessionTextStream.activate(sessionId);
        this.retainSessionMessageCache(sessionId);
        return owner;
    }

    public promoteSessionRoute = (owner: SessionRouteOwner): SessionRouteOwner | null => {
        const promoted = this.sessionRouteOwnership.promote(owner);
        if (promoted) void this.startHistoryPrefetch();
        return promoted;
    }

    private startHistoryPrefetch = async (): Promise<void> => {
        const route = this.sessionRouteOwnership.current();
        if (!route || route.phase !== 'interactive' || this.appState !== 'active') return;
        const id = route.sessionId;
        const frontier = this.sessionMessageFrontiers.get(id);
        if (!frontier || !storage.getState().sessionMessages[id]?.isLoaded) return;
        const owner = this.captureHistoryOwner(id);
        const history = owner.history;
        const account = Platform.OS !== 'web' ? this.sessionWarmCacheAccountKey : null;
        if (!history && !account) return;
        const generation = this.sessionMessageCacheGenerations.get(id);
        const diskIsCurrent = account ? sessionHistoryPageCache.captureFence(account, id) : () => true;
        const isCurrent = () => owner.isCurrent() && this.sessionRouteOwnership.owns(route)
            && this.appState === 'active' && this.sessionMessageCacheGenerations.get(id) === generation
            && (history !== null || (this.sessionWarmCacheAccountKey === account
                && diskIsCurrent()));
        // A restored reading anchor may be in the middle. Walk from the cached
        // tail so both sides of that anchor eventually become available offline.
        const tail = history ? await history.readWindow(id) : null;
        if (!isCurrent()) return;
        this.historyPrefetch.start({
            key: route, sessionId: id, beforeSeq: (tail?.newestSeq ?? frontier.latestSeq ?? 0) + 1,
            isCurrent,
            canRun: () => !this.historyWindowLoads.has(id) && !this.sessionOlderLoadingTokens.has(id)
                && !this.hasPendingOutboxMessages(),
            read: async boundary => history ? history.readOlderPage(id, boundary, 100)
                : sessionHistoryPageCache.readOlder(account!, id, boundary),
            fetch: async (boundary, signal) => {
                const response = await apiSocket.request(`/v3/sessions/${id}/messages?before_seq=${boundary}&limit=100`, { signal });
                if (!response.ok) throw new Error(`History prefetch failed: ${response.status}`);
                return await response.json() as V3GetSessionMessagesResponse;
            },
            write: async (boundary, page) => isCurrent() && (history
                ? await history.commitPage(id, { ...page, direction: 'older', boundary })
                : sessionHistoryPageCache.save(account!, id, boundary, page)),
        });
    };

    public isSessionRouteOwner = (owner: SessionRouteOwner): boolean => {
        return this.sessionRouteOwnership.owns(owner);
    }

    public leaveSessionRoute = (owner: SessionRouteOwner): boolean => {
        if (!this.sessionRouteOwnership.leave(owner)) return false;
        sessionTextStream.activate(null);
        this.historyPrefetch.stop();
        const operation = this.activeOpenSession;
        if (operation?.owner.ownerEpoch === owner.ownerEpoch) {
            operation.cancelled = true;
            this.sessionMessageLoadGate.leave(operation.messageLease);
            this.messagesSync.get(owner.sessionId)?.stop();
            this.activeOpenSession = null;
        }
        const credentials = this.credentials;
        // beginSessionRoute() may synchronously install a replacement owner.
        // Give it that chance before treating this as a real navigation away.
        queueMicrotask(() => {
            if (!this.sessionRouteOwnership.current()) {
                this.releaseDeferredSessionWork(undefined, credentials, { terminal: true });
            }
        });
        return true;
    }

    public openSession = (sessionId: string, owner = this.beginSessionRoute(sessionId), options: { retry?: boolean } = {}): SessionOpenPromise => {
        if (owner.sessionId !== sessionId || !this.sessionRouteOwnership.owns(owner)) {
            return Promise.reject(new SessionRouteAbandonedError());
        }
        this.retainSessionMessageCache(sessionId);
        storage.setState(state => state.sessionMessages[sessionId] ? ({ sessionMessages: {
            ...state.sessionMessages,
            [sessionId]: { ...state.sessionMessages[sessionId], latestVerifiedOwnerEpoch: null },
        } }) : state);
        const messageLease = this.sessionMessageLoadGate.enter(sessionId);
        const hasLoadedMessageCache = storage.getState().sessionMessages[sessionId]?.isLoaded === true
            && this.getSessionProjectedMessageSeq(sessionId) !== null;
        if (options.retry) markSessionCriticalPathHydrationRetry();
        markSessionCriticalPathAppStage('web.messages.latest_started');
        const historyOwner = this.localHistory;
        const latestPagePromise: Promise<V3GetSessionMessagesResponse> = hasLoadedMessageCache
            ? Promise.resolve({ messages: [], hasMore: false })
            : historyOwner ? (async (): Promise<V3GetSessionMessagesResponse> => {
                const reading = await historyOwner.readReadingState(sessionId);
                const window = await historyOwner.readWindow(sessionId, { anchorSeq: reading?.anchorSeq });
                if (window) return { messages: window.messages, hasMore: window.hasMoreOlder, localWindow: window,
                    revalidateTail: (!reading || reading.followLatest === true) && !window.isAtLatest };
                return this.fetchLatestMessagePageRaw(sessionId);
            })() : this.fetchLatestMessagePageRaw(sessionId);
        const operation: SessionRouteOperation = {
            sessionId,
            owner,
            cancelled: false,
            messageLease,
            messageLoad: this.sessionMessageLoadGate.begin(messageLease),
            latestPage: latestPagePromise,
            foregroundTarget: 0,
            committedPageSeq: null,
            committedPageOperation: null,
        };
        this.activeOpenSession = operation;
        // A missing target can be resolved before its concurrently-started
        // message request finishes. Attach a rejection observer immediately so
        // that discarded 404/network results never become unhandled promises.
        void latestPagePromise.catch(() => undefined);
        const snapshotPromise = this.hydrateSessionSnapshot(sessionId, operation);
        const targetTransfersSettled = Promise.allSettled([snapshotPromise, latestPagePromise]);
        const routeCredentials = this.credentials;

        const opening = (async (): SessionOpenPromise => {
            const found = await snapshotPromise;
            this.assertSessionRouteCurrent(operation);
            if (!found) return 'not-found';

            if (hasLoadedMessageCache) {
                if (!this.localHistory) {
                    await this.getMessagesSync(sessionId).invalidateAndAwait();
                    this.markLatestVerified(sessionId, operation.committedPageOperation);
                }
                this.assertSessionRouteCurrent(operation);
                markSessionCriticalPathAppStage('web.messages.latest_completed');
                markSessionCriticalPathAppStage('web.session.store_committed');
                return 'ready';
            }

            let latestPage = await latestPagePromise;
            this.assertSessionRouteCurrent(operation);
            if (latestPage.localWindow) {
                try {
                    const applied = await this.applyHistoryWindow(sessionId, latestPage.localWindow, operation.messageLoad);
                    this.assertSessionRouteCurrent(operation);
                    if (!applied) {
                        await this.messagesSync.get(sessionId)?.awaitQueue();
                        this.assertSessionRouteCurrent(operation);
                        if (!this.historyWindows.has(sessionId)) throw new SessionRouteCoordinationError();
                    }
                    markSessionCriticalPathAppStage('web.messages.latest_completed');
                    markSessionCriticalPathAppStage('web.session.store_committed');
                    if (latestPage.revalidateTail) setTimeout(() => {
                        // A superseding load may already have verified latest.
                        // Replaying that winner as local history would clear its
                        // verification before Deferred can paint it.
                        if (this.localHistory === historyOwner && this.sessionRouteOwnership.owns(owner)
                            && this.historyWindows.get(sessionId)?.isAtLatest !== true) {
                            void this.jumpToLatestMessages(sessionId);
                        }
                    }, 0);
                    return 'ready';
                } catch {
                    this.assertSessionRouteCurrent(operation);
                    await this.localHistory?.invalidateMessages(sessionId);
                    latestPage = await this.fetchLatestMessagePageRaw(sessionId);
                    this.assertSessionRouteCurrent(operation);
                }
            }
            const applied = await this.applyLatestMessagePage(sessionId, latestPage, operation.messageLoad);
            this.assertSessionRouteCurrent(operation);
            if (!applied || operation.foregroundTarget > 0) {
                // A foreground gap can supersede the route's decrypt on the same
                // lease. Await that winner, then require a page commit covering
                // both the raw latest page and the foreground target. A realtime
                // sequence alone is not evidence that such a page committed.
                await this.messagesSync.get(sessionId)?.awaitQueue();
                this.assertSessionRouteCurrent(operation);
                let pageTarget = Math.max(...latestPage.messages.map(message => message.seq), 0);
                const targetCommitted = () => operation.committedPageSeq !== null
                    && operation.committedPageSeq >= Math.max(pageTarget, operation.foregroundTarget)
                    && storage.getState().sessionMessages[sessionId]?.isLoaded;
                if (!targetCommitted()) {
                    // One recovery belongs to this route operation and lease.
                    // It must not consume SessionView's network retry budget or
                    // grant a cancelled route a fresh ownership epoch.
                    operation.messageLoad = this.sessionMessageLoadGate.begin(operation.messageLease);
                    // Coordination does not spend the UI retry budget, but its
                    // additional latest-page request is still an observed retry.
                    markSessionCriticalPathHydrationRetry();
                    operation.latestPage = this.fetchLatestMessagePageRaw(sessionId);
                    const recoveryPage = await operation.latestPage;
                    this.assertSessionRouteCurrent(operation);
                    pageTarget = Math.max(pageTarget, ...recoveryPage.messages.map(message => message.seq));
                    await this.applyLatestMessagePage(sessionId, recoveryPage, operation.messageLoad);
                    this.assertSessionRouteCurrent(operation);
                    await this.messagesSync.get(sessionId)?.awaitQueue();
                    this.assertSessionRouteCurrent(operation);
                    if (!targetCommitted()) throw new SessionRouteCoordinationError();
                }
            }
            markSessionCriticalPathAppStage('web.messages.latest_completed');
            this.assertSessionRouteCurrent(operation);
            this.markLatestVerified(sessionId, operation.committedPageOperation);
            markSessionCriticalPathAppStage('web.session.store_committed');
            return 'ready';
        })().catch((error: unknown) => {
            // A cancelled/deleted route stays terminal even if its pending
            // request or decrypt rejects instead of delivering a stale page.
            this.assertSessionRouteCurrent(operation);
            if (error instanceof SessionNotFoundError) {
                this.removeSessionLocally(sessionId);
                return 'not-found' as const;
            }
            throw error;
        });
        // A missing snapshot may resolve the UI immediately while the already
        // started latest-message request is still transferring. Ready routes
        // already await their message work as part of `opening`.
        void opening.then(async result => {
            if (result === 'ready') void this.startHistoryPrefetch();
            if (result === 'not-found') {
                await targetTransfersSettled;
                // The not-found screen remains mounted, so component cleanup
                // cannot end its opening phase. Keep the epoch for stale-cleanup
                // fencing, but terminalize it so later foreground/reconnect work
                // is no longer held behind a route that can never paint.
                if (this.credentials !== routeCredentials || this.activeOpenSession !== operation
                    || !this.sessionRouteOwnership.terminalize(owner)) return;
                operation.cancelled = true;
                this.sessionMessageLoadGate.leave(operation.messageLease);
                this.messagesSync.get(owner.sessionId)?.stop();
                this.activeOpenSession = null;
            }
            this.releaseDeferredSessionWork(owner, routeCredentials, { terminal: result === 'not-found' });
        }, () => {
            // SessionView keeps ownership across a bounded transient retry and
            // explicitly leaves on terminal error/unmount. Releasing here would
            // create an owner-less lane during the retry delay.
        });
        this.sessionRouteOperations.set(opening, operation);
        return opening;
    }

    public abandonSessionRoute = (sessionId: string, opening: SessionOpenPromise): void => {
        const operation = this.sessionRouteOperations.get(opening);
        if (!operation || operation.sessionId !== sessionId) return;
        operation.cancelled = true;
        this.sessionMessageLoadGate.leave(operation.messageLease);
        if (this.activeOpenSession === operation) this.leaveSessionRoute(operation.owner);
    }

    private assertSessionRouteCurrent(operation: SessionRouteOperation): void {
        if (operation.cancelled || this.activeOpenSession !== operation || !this.sessionRouteOwnership.owns(operation.owner)
            || !this.sessionMessageLoadGate.isLeaseCurrent(operation.messageLease)) {
            throw new SessionRouteAbandonedError();
        }
    }

    private markLatestVerified(sessionId: string, operation: SessionMessageLoadOperation | null): void {
        const route = this.activeOpenSession;
        if (route?.sessionId !== sessionId || !this.sessionRouteOwnership.owns(route.owner)
            || !operation || !this.sessionMessageLoadGate.isCurrent(operation)
            || storage.getState().sessionMessages[sessionId]?.isAtLatest === false) return;
        storage.setState(state => state.sessionMessages[sessionId] ? ({ sessionMessages: {
            ...state.sessionMessages,
            [sessionId]: state.sessionMessages[sessionId].latestVerifiedOwnerEpoch === route.owner.ownerEpoch
                ? state.sessionMessages[sessionId]
                : { ...state.sessionMessages[sessionId], latestVerifiedOwnerEpoch: route.owner.ownerEpoch },
        } }) : state);
    }

    // Kept as a compatibility alias while call sites migrate to the more
    // precise ensureSessionHydrated() name.
    public refreshSession = this.ensureSessionHydrated;

    public getCredentials() {
        return this.credentials;
    }

    public getSessionLastMessageSeq(sessionId: string): number | null {
        return this.sessionMessageFrontiers.get(sessionId)?.latestSeq ?? null;
    }

    private getSessionProjectedMessageSeq(sessionId: string, includeQueued = false): number | null {
        let seq = storage.getState().sessionMessages[sessionId]?.latestAppliedSeq
            ?? null;
        if (includeQueued && seq !== null) {
            for (const message of this.sessionMessageQueue.get(sessionId) ?? []) {
                const queuedSeq = this.queuedMessageSeqs.get(message);
                if (queuedSeq === seq + 1) seq = queuedSeq;
            }
        }
        return seq;
    }

    private advanceLatestMessageSeq(sessionId: string, seq: number): void {
        const current = this.sessionMessageFrontiers.get(sessionId);
        this.sessionMessageFrontiers.set(sessionId, {
            olderBeforeSeq: null,
            hasMoreOlder: false,
            ...current,
            latestSeq: Math.max(current?.latestSeq ?? 0, seq),
        });
    }

    private recordFetchedMessageRange(sessionId: string, messages: ApiMessage[]): MessageRange | null {
        if (messages.length === 0) return null;
        const cached = this.sessionCachedMessageSeqs.get(sessionId) ?? new Set<number>();
        let minSeq = Infinity;
        let maxSeq = 0;
        for (const message of messages) {
            cached.add(message.seq);
            minSeq = Math.min(minSeq, message.seq);
            maxSeq = Math.max(maxSeq, message.seq);
        }
        this.sessionCachedMessageSeqs.set(sessionId, cached);
        return { minSeq, maxSeq };
    }

    public hasPendingOutboxMessagesForSession(sessionId: string): boolean {
        return (this.pendingOutbox.get(sessionId)?.length ?? 0) > 0;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        log.log('📦 fetchArtifactsList: Starting artifact sync');
        if (!this.credentials) {
            log.log('📦 fetchArtifactsList: No credentials, skipping');
            return;
        }

        try {
            log.log('📦 fetchArtifactsList: Fetching artifacts from server');
            const artifacts = await fetchArtifacts(this.credentials);
            log.log(`📦 fetchArtifactsList: Received ${artifacts.length} artifacts from server`);
            const decryptedArtifacts: DecryptedArtifact[] = [];

            for (const artifact of artifacts) {
                try {
                    // Decrypt the data encryption key
                    const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        console.error(`Failed to decrypt key for artifact ${artifact.id}`);
                        continue;
                    }

                    // Store the decrypted key in memory
                    this.artifactDataKeys.set(artifact.id, decryptedKey);

                    // Create artifact encryption instance
                    const artifactEncryption = new ArtifactEncryption(decryptedKey);

                    // Decrypt header
                    const header = await artifactEncryption.decryptHeader(artifact.header);
                    
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: header?.title || null,
                        sessions: header?.sessions,  // Include sessions from header
                        draft: header?.draft,        // Include draft flag from header
                        body: undefined, // Body not loaded in list
                        headerVersion: artifact.headerVersion,
                        bodyVersion: artifact.bodyVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: !!header,
                    });
                } catch (err) {
                    console.error(`Failed to decrypt artifact ${artifact.id}:`, err);
                    // Add with decryption failed flag
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: null,
                        body: undefined,
                        headerVersion: artifact.headerVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: false,
                    });
                }
            }

            log.log(`📦 fetchArtifactsList: Successfully decrypted ${decryptedArtifacts.length} artifacts`);
            storage.getState().applyArtifacts(decryptedArtifacts);
            log.log('📦 fetchArtifactsList: Artifacts applied to storage');
        } catch (error) {
            log.log(`📦 fetchArtifactsList: Error fetching artifacts: ${error}`);
            console.error('Failed to fetch artifacts:', error);
            throw error;
        }
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;

        try {
            const artifact = await fetchArtifact(this.credentials, artifactId);

            // Decrypt the data encryption key
            const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
            if (!decryptedKey) {
                console.error(`Failed to decrypt key for artifact ${artifactId}`);
                return null;
            }

            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifact.id, decryptedKey);

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(decryptedKey);

            // Decrypt header and body
            const header = await artifactEncryption.decryptHeader(artifact.header);
            const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

            return {
                id: artifact.id,
                title: header?.title || null,
                sessions: header?.sessions,  // Include sessions from header
                draft: header?.draft,        // Include draft flag from header
                body: body?.body || null,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: !!header,
            };
        } catch (error) {
            console.error(`Failed to fetch artifact ${artifactId}:`, error);
            return null;
        }
    }

    public async createArtifact(
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<string> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Generate unique artifact ID
            const artifactId = this.encryption.generateId();

            // Generate data encryption key
            const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();
            
            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifactId, dataEncryptionKey);
            
            // Encrypt the data encryption key with user's key
            const encryptedKey = await this.encryption.encryptEncryptionKey(dataEncryptionKey);
            
            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
            
            // Encrypt header and body
            const encryptedHeader = await artifactEncryption.encryptHeader({ title, sessions, draft });
            const encryptedBody = await artifactEncryption.encryptBody({ body });
            
            // Create the request
            const request: ArtifactCreateRequest = {
                id: artifactId,
                header: encryptedHeader,
                body: encryptedBody,
                dataEncryptionKey: encodeBase64(encryptedKey, 'base64'),
            };
            
            // Send to server
            const artifact = await createArtifact(this.credentials, request);
            
            // Add to local storage
            const decryptedArtifact: DecryptedArtifact = {
                id: artifact.id,
                title,
                sessions,
                draft,
                body,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
            };
            
            storage.getState().addArtifact(decryptedArtifact);
            
            return artifactId;
        } catch (error) {
            console.error('Failed to create artifact:', error);
            throw error;
        }
    }

    public async updateArtifact(
        artifactId: string, 
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Get current artifact to get versions and encryption key
            const currentArtifact = storage.getState().artifacts[artifactId];
            if (!currentArtifact) {
                throw new Error('Artifact not found');
            }

            // Get the data encryption key from memory or fetch it
            let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
            
            // Fetch full artifact if we don't have version info or encryption key
            let headerVersion = currentArtifact.headerVersion;
            let bodyVersion = currentArtifact.bodyVersion;
            
            if (headerVersion === undefined || bodyVersion === undefined || !dataEncryptionKey) {
                const fullArtifact = await fetchArtifact(this.credentials, artifactId);
                headerVersion = fullArtifact.headerVersion;
                bodyVersion = fullArtifact.bodyVersion;
                
                // Decrypt and store the data encryption key if we don't have it
                if (!dataEncryptionKey) {
                    const decryptedKey = await this.encryption.decryptEncryptionKey(fullArtifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        throw new Error('Failed to decrypt encryption key');
                    }
                    this.artifactDataKeys.set(artifactId, decryptedKey);
                    dataEncryptionKey = decryptedKey;
                }
            }

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Prepare update request
            const updateRequest: ArtifactUpdateRequest = {};
            
            // Check if header needs updating (title, sessions, or draft changed)
            if (title !== currentArtifact.title || 
                JSON.stringify(sessions) !== JSON.stringify(currentArtifact.sessions) ||
                draft !== currentArtifact.draft) {
                const encryptedHeader = await artifactEncryption.encryptHeader({ 
                    title, 
                    sessions, 
                    draft 
                });
                updateRequest.header = encryptedHeader;
                updateRequest.expectedHeaderVersion = headerVersion;
            }

            // Only update body if it changed
            if (body !== currentArtifact.body) {
                const encryptedBody = await artifactEncryption.encryptBody({ body });
                updateRequest.body = encryptedBody;
                updateRequest.expectedBodyVersion = bodyVersion;
            }

            // Skip if no changes
            if (Object.keys(updateRequest).length === 0) {
                return;
            }

            // Send update to server
            const response = await updateArtifact(this.credentials, artifactId, updateRequest);
            
            if (!response.success) {
                // Handle version mismatch
                if (response.error === 'version-mismatch') {
                    throw new Error('Artifact was modified by another client. Please refresh and try again.');
                }
                throw new Error('Failed to update artifact');
            }

            // Update local storage
            const updatedArtifact: DecryptedArtifact = {
                ...currentArtifact,
                title,
                sessions,
                draft,
                body,
                headerVersion: response.headerVersion !== undefined ? response.headerVersion : headerVersion,
                bodyVersion: response.bodyVersion !== undefined ? response.bodyVersion : bodyVersion,
                updatedAt: Date.now(),
            };
            
            storage.getState().updateArtifact(updatedArtifact);
        } catch (error) {
            console.error('Failed to update artifact:', error);
            throw error;
        }
    }

    private fetchMachines = async () => {
        if (!this.credentials) return;

        console.log('📊 Sync: Fetching machines...');
        const API_ENDPOINT = getServerUrl();
        const response = await fetch(`${API_ENDPOINT}/v1/machines`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            console.error(`Failed to fetch machines: ${response.status}`);
            return;
        }

        const data = await response.json();
        console.log(`📊 Sync: Fetched ${Array.isArray(data) ? data.length : 0} machines from server`);
        const machines = data as Array<{
            id: string;
            metadata: string;
            metadataVersion: number;
            daemonState?: string | null;
            daemonStateVersion?: number;
            dataEncryptionKey?: string | null; // Add support for per-machine encryption keys
            seq: number;
            active: boolean;
            activeAt: number;  // Changed from lastActiveAt
            createdAt: number;
            updatedAt: number;
        }>;

        // First, collect and decrypt encryption keys for all machines.
        //
        // Resilience: a single machine whose data key cannot be decrypted
        // (legacy/foreign key format, contentKeyPair mismatch, malformed
        // base64) must NOT abort the whole sync. Previously a throw here
        // rejected fetchMachines entirely — backoff() only console.warn's and
        // retries forever, so applyMachines was never reached and EVERY
        // machine silently vanished from the store (empty /new, no
        // console.error). On failure we fall back to a null key: the machine
        // still gets a (legacy) encryptor and stays visible/selectable, just
        // with undecryptable metadata.
        const machineKeysMap = new Map<string, Uint8Array | null>();
        for (const machine of machines) {
            if (machine.dataEncryptionKey) {
                let decryptedKey: Uint8Array | null = null;
                try {
                    decryptedKey = await this.encryption.decryptEncryptionKey(machine.dataEncryptionKey);
                } catch (error) {
                    console.error(`Failed to decrypt data encryption key for machine ${machine.id}:`, error);
                }
                if (decryptedKey) {
                    machineKeysMap.set(machine.id, decryptedKey);
                    this.machineDataKeys.set(machine.id, decryptedKey);
                } else {
                    console.error(`Failed to decrypt data encryption key for machine ${machine.id} - keeping machine with undecryptable metadata`);
                    machineKeysMap.set(machine.id, null);
                }
            } else {
                machineKeysMap.set(machine.id, null);
            }
        }

        // Initialize machine encryptions. Guard so an init failure cannot
        // reject the whole sync and wipe the machine list.
        try {
            await this.encryption.initializeMachines(machineKeysMap);
        } catch (error) {
            console.error('Failed to initialize machine encryptions:', error);
        }

        // Process all machines first, then update state once. Every machine is
        // pushed exactly once — decryption failures degrade to null metadata
        // instead of dropping the machine, so a machine never disappears from
        // the picker just because its metadata could not be read.
        const decryptedMachines: Machine[] = [];

        for (const machine of machines) {
            try {
                const machineEncryption = this.encryption.getMachineEncryption(machine.id);

                // Use machine-specific encryption (which handles fallback internally)
                const metadata = machineEncryption && machine.metadata
                    ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                    : null;

                const daemonState = machineEncryption && machine.daemonState
                    ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
                    : null;

                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState,
                    daemonStateVersion: machine.daemonStateVersion || 0
                });
            } catch (error) {
                console.error(`Failed to decrypt machine ${machine.id}:`, error);
                // Still add the machine with null metadata so it stays visible.
                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata: null,
                    metadataVersion: machine.metadataVersion,
                    daemonState: null,
                    daemonStateVersion: 0
                });
            }
        }

        // Replace entire machine state with fetched machines — but never wipe
        // a populated store with an empty result. An empty list here almost
        // always means a transient fetch/decrypt problem, not "user has no
        // machines"; destroying good state would blank /new until restart.
        const existingMachineCount = Object.keys(storage.getState().machines).length;
        if (decryptedMachines.length === 0 && existingMachineCount > 0) {
            log.log(`🖥️ fetchMachines: empty result, keeping ${existingMachineCount} existing machine(s)`);
            return;
        }
        storage.getState().applyMachines(decryptedMachines, true);
        log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
    }

    private fetchFeed = async () => {
        if (!this.credentials) return;

        try {
            log.log('📰 Fetching feed...');
            const state = storage.getState();
            const existingItems = state.feedItems;
            const head = state.feedHead;
            
            // Load feed items - if we have a head, load newer items
            let allItems: FeedItem[] = [];
            let hasMore = true;
            let cursor = head ? { after: head } : undefined;
            let loadedCount = 0;
            const maxItems = 500;
            
            // Keep loading until we reach known items or hit max limit
            while (hasMore && loadedCount < maxItems) {
                const response = await fetchFeed(this.credentials, {
                    limit: 100,
                    ...cursor
                });
                
                // Check if we reached known items
                const foundKnown = response.items.some(item => 
                    existingItems.some(existing => existing.id === item.id)
                );
                
                allItems.push(...response.items);
                loadedCount += response.items.length;
                hasMore = response.hasMore && !foundKnown;
                
                // Update cursor for next page
                if (response.items.length > 0) {
                    const lastItem = response.items[response.items.length - 1];
                    cursor = { after: lastItem.cursor };
                }
            }
            
            // If this is initial load (no head), also load older items
            if (!head && allItems.length < 100) {
                const response = await fetchFeed(this.credentials, {
                    limit: 100
                });
                allItems.push(...response.items);
            }
            
            const compatibleItems = allItems.filter(item => item.body.kind === 'text');

            // Apply only compatible items to storage
            storage.getState().applyFeedItems(compatibleItems);
            log.log(`📰 fetchFeed completed - loaded ${compatibleItems.length} compatible items (${allItems.length - compatibleItems.length} filtered)`);
        } catch (error) {
            console.error('Failed to fetch feed:', error);
        }
    }

    private syncSettings = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const maxRetries = 3;
        let retryCount = 0;

        // Apply pending settings
        if (Object.keys(this.pendingSettings).length > 0) {

            while (retryCount < maxRetries) {
                // Snapshot what we're about to send so we can detect concurrent changes
                const sentPending = { ...this.pendingSettings };
                let version = storage.getState().settingsVersion;
                let settings = applySettings(storage.getState().settings, this.pendingSettings);
                const response = await fetch(`${API_ENDPOINT}/v1/account/settings`, {
                    method: 'POST',
                    body: JSON.stringify({
                        settings: await this.encryption.encryptRaw(settingsToSyncPayload(settings)),
                        expectedVersion: version ?? 0
                    }),
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'Content-Type': 'application/json',
                        'X-Happy-Client': getHappyClientId(),
                    }
                });
                const data = await response.json() as {
                    success: false,
                    error: string,
                    currentVersion: number,
                    currentSettings: string | null
                } | {
                    success: true
                };
                if (data.success) {
                    // Only clear keys we actually sent — preserve any settings
                    // added by applySettings() calls during the POST roundtrip
                    const newPending: Partial<Settings> = {};
                    for (const key of Object.keys(this.pendingSettings) as (keyof Settings)[]) {
                        if (!(key in sentPending) || this.pendingSettings[key] !== sentPending[key]) {
                            (newPending as any)[key] = this.pendingSettings[key];
                        }
                    }
                    this.pendingSettings = newPending;
                    if (newPending.sidebarOrganization) {
                        this.pendingSidebarOrganizationBase = sentPending.sidebarOrganization ?? settings.sidebarOrganization;
                    } else {
                        this.pendingSidebarOrganizationBase = null;
                    }
                    savePendingSidebarOrganizationBase(this.pendingSidebarOrganizationBase);
                    if (newPending.sessionPinnedOrder) {
                        this.pendingSessionPinnedOrderBase = sentPending.sessionPinnedOrder ?? settings.sessionPinnedOrder;
                    } else {
                        this.pendingSessionPinnedOrderBase = null;
                    }
                    savePendingSessionPinnedState(newPending.sessionPinnedOrder && this.pendingSessionPinnedOrderBase
                        ? {
                            value: newPending.sessionPinnedOrder,
                            base: this.pendingSessionPinnedOrderBase,
                            clearRaw: true,
                        }
                        : null);
                    savePendingSettings(this.pendingSettings);
                    if (sentPending.sessionPinnedOrder) {
                        clearLegacySessionPinnedOrder();
                    }
                    break;
                }
                if (data.error === 'version-mismatch') {
                    // Parse server settings
                    const rawServerSettings = data.currentSettings
                        ? await this.encryption.decryptRaw(data.currentSettings)
                        : null;
                    const serverSettings = rawServerSettings
                        ? settingsParse(rawServerSettings)
                        : { ...settingsDefaults };

                    // Update local storage with merged result at server's version
                    this.applyServerSettings(serverSettings, data.currentVersion, rawServerSettings);
                    const mergedSettings = storage.getState().settings;

                    // Sync tracking state with merged settings
                    if (tracking) {
                        mergedSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
                    }

                    // Log and retry
                    console.log('settings version-mismatch, retrying', {
                        serverVersion: data.currentVersion,
                        retry: retryCount + 1,
                        pendingKeys: Object.keys(this.pendingSettings)
                    });
                    retryCount++;
                    continue;
                } else {
                    throw new Error(`Failed to sync settings: ${data.error}`);
                }
            }
        }

        // If exhausted retries, throw to trigger outer backoff delay
        if (retryCount >= maxRetries) {
            throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts`);
        }

        // Run request
        const response = await fetch(`${API_ENDPOINT}/v1/account/settings`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch settings: ${response.status}`);
        }
        const data = await response.json() as {
            settings: string | null,
            settingsVersion: number
        };

        // Parse response
        let rawServerSettings: unknown = null;
        let parsedSettings: Settings;
        if (data.settings) {
            rawServerSettings = await this.encryption.decryptRaw(data.settings);
            parsedSettings = rawServerSettings
                ? settingsParse(rawServerSettings)
                : { ...settingsDefaults };
        } else {
            parsedSettings = { ...settingsDefaults };
        }

        // Log
        console.log('settings', JSON.stringify({
            settings: parsedSettings,
            version: data.settingsVersion
        }));

        // Apply settings to storage, re-layering any pending local changes on top
        this.applyServerSettings(parsedSettings, data.settingsVersion, rawServerSettings);

        // Sync PostHog opt-out state with settings
        if (tracking) {
            if (parsedSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }
    }

    private fetchProfile = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const response = await fetch(`${API_ENDPOINT}/v1/account/profile`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch profile: ${response.status}`);
        }

        const data = await response.json();
        const parsedProfile = profileParse(data);

        // Log profile data for debugging
        console.log('profile', JSON.stringify({
            id: parsedProfile.id,
            timestamp: parsedProfile.timestamp,
            firstName: parsedProfile.firstName,
            lastName: parsedProfile.lastName,
            hasAvatar: !!parsedProfile.avatar,
            hasGitHub: !!parsedProfile.github
        }));

        // Apply profile to storage
        storage.getState().applyProfile(parsedProfile);
    }

    private fetchNativeUpdate = async () => {
        try {
            await refreshNativeUpdateStatus();
        } catch (error) {
            console.log('[fetchNativeUpdate] Error:', error);
        }
    }

    private syncPurchases = async () => {
        try {
            // Initialize RevenueCat if not already done
            if (!this.revenueCatInitialized) {
                // Get the appropriate API key based on platform
                let apiKey: string | undefined;

                if (Platform.OS === 'ios') {
                    apiKey = config.revenueCatAppleKey;
                } else if (Platform.OS === 'android') {
                    apiKey = config.revenueCatGoogleKey;
                } else if (Platform.OS === 'web') {
                    apiKey = config.revenueCatStripeKey;
                }

                if (!apiKey) {
                    console.log(`RevenueCat: No API key found for platform ${Platform.OS}`);
                    return;
                }

                // Configure RevenueCat
                if (__DEV__) {
                    RevenueCat.setLogLevel(LogLevel.DEBUG);
                }

                // Initialize with the public ID as user ID
                RevenueCat.configure({
                    apiKey,
                    appUserID: this.serverID, // In server this is a CUID, which we can assume is globaly unique even between servers
                    useAmazon: false,
                });

                this.revenueCatInitialized = true;
                console.log('RevenueCat initialized successfully');
            }

            // Sync purchases
            await RevenueCat.syncPurchases();

            // Fetch customer info
            const customerInfo = await RevenueCat.getCustomerInfo();

            // Apply to storage (storage handles the transformation)
            storage.getState().applyPurchases(customerInfo);

        } catch (error) {
            console.error('Failed to sync purchases:', error);
            // Don't throw - purchases are optional
        }
    }

    private flushOutbox = async (sessionId: string) => {
        const pending = this.pendingOutbox.get(sessionId);
        if (!pending || pending.length === 0) {
            if (!this.hasPendingOutboxMessages()) {
                this.clearBackgroundSendWatchdog();
                await this.cancelBackgroundSendTimeoutNotification();
                this.backgroundSendStartedAt = null;
            }
            return;
        }

        const batch = pending.slice();
        const owner = this.captureHistoryOwner(sessionId);
        const historyOwner = owner.history;
        const cacheGeneration = this.sessionMessageCacheGenerations.get(sessionId) ?? {};
        this.sessionMessageCacheGenerations.set(sessionId, cacheGeneration);
        const controller = new AbortController();
        this.sendAbortControllers.set(sessionId, controller);
        try {
            const response = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    messages: batch.map((message) => ({
                        localId: message.localId,
                        content: message.content
                    }))
                }),
                headers: {
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            });
            if (!owner.isCurrent()) return;
            if (!response.ok) {
                throw new Error(`Failed to send messages for ${sessionId}: ${response.status}`);
            }

            const data = await response.json() as V3PostSessionMessagesResponse;
            // A deletion can remove this queue while the server acknowledgement
            // is in flight. It must not recreate message runtime afterwards.
            if (!owner.isCurrent() || this.pendingOutbox.get(sessionId) !== pending) return;
            if (historyOwner && Array.isArray(data.messages)) {
                const contents = new Map(batch.map(message => [message.localId, message.content]));
                await historyOwner.appendMessages(sessionId, data.messages.flatMap(message => {
                    const content = message.localId ? contents.get(message.localId) : undefined;
                    return content ? [{ ...message, content: { t: 'encrypted' as const, c: content } }] : [];
                }));
                if (!owner.isCurrent() || this.pendingOutbox.get(sessionId) !== pending) return;
            }
            pending.splice(0, batch.length);
            // The outbox survives eviction, but an old acknowledgement does not
            // own the released or subsequently remounted message cache.
            if (this.sessionMessageCacheGenerations.get(sessionId) === cacheGeneration
                && Array.isArray(data.messages) && data.messages.length > 0) {
                let frontier = this.sessionMessageFrontiers.get(sessionId);
                // An acknowledgement observes only its own sequences. Concurrent
                // messages between acknowledgements still need backward loading.
                for (const message of [...data.messages].sort((a, b) => a.seq - b.seq)) {
                    frontier = applyLatestRange(frontier, { minSeq: message.seq, maxSeq: message.seq }, true);
                }
                this.sessionMessageFrontiers.set(sessionId, frontier!);
                storage.getState().applyOlderMessagesPagination(sessionId, { hasMore: frontier!.hasMoreOlder });
            }
        } catch (error) {
            this.maybeStartBackgroundSendWatchdog();
            throw error;
        } finally {
            this.sendAbortControllers.delete(sessionId);
        }

        if (pending.length === 0) {
            this.pendingOutbox.delete(sessionId);
        }
        if (!this.hasPendingOutboxMessages()) {
            this.clearBackgroundSendWatchdog();
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
        } else if (this.appState !== 'active') {
            this.maybeStartBackgroundSendWatchdog();
        }
    }

    private fetchMessages = async (
        sessionId: string,
        operation: SessionMessageLoadOperation,
    ) => {
        const owner = this.captureHistoryOwner(sessionId, operation);
        log.log(`💬 fetchMessages starting for session ${sessionId} - acquiring lock`);
        const lock = this.getSessionMessageLock(sessionId);
        await lock.inLock(async () => {
            if (!owner.isCurrent()) return;
            if (owner.history && !this.historyWindows.has(sessionId)) {
                const history = owner.history;
                const reading = await history.readReadingState(sessionId);
                const window = await history.readWindow(sessionId, { anchorSeq: reading?.anchorSeq });
                if (!owner.isCurrent()) return;
                if (window) {
                    try { if (await this.applyHistoryWindow(sessionId, window, operation)) return; }
                    catch { await history.invalidateMessages(sessionId); }
                }
                if (!owner.isCurrent()) return;
            }
            if (Platform.OS === 'web' && this.historyWindows.get(sessionId)?.isAtLatest === false) return;
            if (this.localHistory && this.historyWindows.has(sessionId)) {
                const window = this.historyWindows.get(sessionId)!;
                const change = await this.localHistory.readChange(sessionId);
                if (!owner.isCurrent()) return;
                if (change?.deleted) { this.removeSessionLocally(sessionId); return; }
                const target = Math.max(change?.lastMessageSeq ?? 0, this.pendingHistoryTargets.get(sessionId) ?? 0);
                const projectedSeq = this.getSessionProjectedMessageSeq(sessionId) ?? 0;
                if (!window.isAtLatest || (change && target <= projectedSeq)) return;
                // Unknown target is reconciled through metadata, never by probing old bodies.
                if (this.changesSupported !== false && !change && target <= projectedSeq) return;
            }
            const encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption) {
                log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, will retry`);
                throw new Error(`Session encryption not ready for ${sessionId}`);
            }

            const knownLastSeq = this.getSessionProjectedMessageSeq(sessionId);
            const isInitialLoad = knownLastSeq === null;
            if (isInitialLoad) {
                // Initial load. Pull only the most recent page so the user can
                // start chatting immediately. Background prefetch archives older
                // ciphertext separately; loadOlderMessages projects it on scroll.
                //
                // Previously this method walked forward from seq=0 until every
                // page had been fetched and decrypted, which blocked the chat
                // from displaying anything for sessions with thousands of
                // messages. The user's reported pain point was "opening a long
                // session feels frozen" — this is the fix.
                try {
                    await this.fetchInitialLatestPage(sessionId, encryption, operation);
                } catch (error) {
                    if (!owner.isCurrent()) return;
                    if (!(error instanceof SessionNotFoundError)) throw error;
                    this.removeSessionLocally(sessionId);
                    return;
                }
            } else {
                // Forward incremental sync. Used after reconnect, invalidate,
                // or any subsequent visit. Only pulls messages newer than what
                // we already have, so it's bounded and fast in normal use.
                await this.fetchForwardSince(sessionId, encryption, knownLastSeq, operation);
            }

            if (!this.sessionMessageLoadGate.isCurrent(operation)) return;
            storage.getState().applyMessagesLoaded(sessionId);
            log.log(`💬 fetchMessages completed for session ${sessionId}`);
        });
    }

    private fetchLatestMessagePageRaw = async (
        sessionId: string,
    ): Promise<V3GetSessionMessagesResponse> => {
        const owner = this.captureHistoryOwner(sessionId);
        const nativeCacheGeneration = sessionHistoryPageCache.generation;
        const response = await apiSocket.request(
            `/v3/sessions/${sessionId}/messages?before_seq=${SEQ_BACKWARD_INITIAL_SENTINEL}&limit=${INITIAL_LATEST_MESSAGE_LIMIT}`,
        );
        if (!owner.isCurrent()) throw new SessionWriteCancelled();
        if (response.status === 404) throw new SessionNotFoundError();
        if (!response.ok) {
            throw new Error(`Failed to fetch initial page for ${sessionId}: ${response.status}`);
        }
        const data = await response.json() as V3GetSessionMessagesResponse;
        if (!owner.isCurrent()) throw new SessionWriteCancelled();
        const page = {
            messages: Array.isArray(data.messages) ? data.messages : [],
            hasMore: !!data.hasMore,
            nativeCacheGeneration,
        };
        return page;
    }

    private applyLatestMessagePage = async (
        sessionId: string,
        data: V3GetSessionMessagesResponse,
        operation: SessionMessageLoadOperation,
        source: 'network' | 'warm-cache' = 'network',
    ): Promise<boolean> => {
        const owner = this.captureHistoryOwner(sessionId, operation);
        const warmAccount = this.sessionWarmCacheAccountKey;
        const pageCacheGeneration = data.nativeCacheGeneration ?? sessionHistoryPageCache.generation;
        if (!this.sessionMessageLoadGate.isCurrent(operation)) return false;
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            throw new Error(`Session encryption not ready for ${sessionId}`);
        }

        const messages = data.messages;
        let maxSeq = 0;
        for (const message of messages) {
            if (message.seq > maxSeq) maxSeq = message.seq;
        }
        // An active/event winner may already have loaded a newer page while
        // this route's HTTP response was pending. Keep that cache's anchors.
        const isStalePage = () => storage.getState().sessionMessages[sessionId]?.isLoaded
            && (this.getSessionProjectedMessageSeq(sessionId) ?? -1) > maxSeq;
        if (isStalePage()) return true;
        const decryptedMessages = messages.length > 0
            ? await encryption.createDetached().decryptMessages(messages)
            : [];
        if (!owner.isCurrent()) return false;
        if (this.encryption.getSessionEncryption(sessionId) !== encryption) return false;
        if (isStalePage()) return true;
        const fullyDecrypted = decryptedMessages.length === messages.length
            && decryptedMessages.every((decrypted) => !!decrypted && decrypted.content !== null);
        if (!fullyDecrypted) {
            throw new Error(`Failed to decrypt complete latest message page for ${sessionId}`);
        }

        const normalizedMessages: NormalizedMessage[] = [];
        const normalizedWireIds = new Map<NormalizedMessage, string>();
        for (const decrypted of decryptedMessages) {
            if (!decrypted) continue;
            const normalized = normalizeRawMessage(
                decrypted.id,
                decrypted.localId,
                decrypted.createdAt,
                decrypted.content,
            );
            if (normalized) {
                normalizedMessages.push(normalized);
                normalizedWireIds.set(normalized, decrypted.id);
            }
        }
        this.retireObservedLocalMessages(sessionId, normalizedMessages);
        // Warm snapshots may contain disconnected realtime islands. Display
        // them immediately, but only a network page certifies latest progress.
        this.applyMessages(sessionId, normalizedMessages, source === 'network' ? maxSeq : undefined);

        const frontier = applyLatestRange(this.sessionMessageFrontiers.get(sessionId),
            this.recordFetchedMessageRange(sessionId, messages), data.hasMore);
        this.sessionMessageFrontiers.set(sessionId, frontier);
        if (source === 'network' && (owner.history || Platform.OS === 'web')) {
            // Establish raw-row ownership before persistence yields. Realtime
            // events admitted during the initial archive replay can then extend
            // this window and be retained by the final bounded projection.
            const provisional = memoryHistoryPage(undefined, data, 'latest', historyNavigationWindowLimit());
            this.historyWindows.set(sessionId, provisional);
            this.historyWireProvenance.set(sessionId, new Map(normalizedMessages.map(message => [
                message.id, normalizedWireIds.get(message)!,
            ])));
        }
        storage.getState().applyMessagesLoaded(sessionId);
        storage.getState().applyOlderMessagesPagination(sessionId, {
            hasMore: frontier.hasMoreOlder,
        });
        if (source === 'network') this.recordRoutePageCommit(operation, maxSeq);
        if (warmAccount) {
            saveSessionWarmLatestPage(warmAccount, sessionId, data);
            // Startup warm pages can combine non-adjacent realtime records;
            // only a server page certifies the interval between its messages.
            if (Platform.OS !== 'web' && source === 'network') {
                sessionHistoryPageCache.save(warmAccount, sessionId, SEQ_BACKWARD_INITIAL_SENTINEL, data, pageCacheGeneration);
            }
        }
        if (source === 'network' && (owner.history || Platform.OS === 'web')) {
            const committed = await owner.history?.commitPage(sessionId, { ...data, direction: 'older', boundary: SEQ_BACKWARD_INITIAL_SENTINEL });
            if (!owner.isCurrent()) return false;
            const fallback = memoryHistoryPage(undefined, data, 'latest', Platform.OS === 'web' ? WEB_HISTORY_MAX_MESSAGES : 300);
            const disk = committed ? await owner.history?.readWindow(sessionId) : null;
            if (!owner.isCurrent()) return false;
            const window = disk && fallback.messages.every(message => disk.messages.some(row => row.id === message.id)) ? disk : fallback;
            await this.applyHistoryWindow(sessionId, window, operation, { retainCurrentRows: true });
        }
        return true;
    }

    private recordRoutePageCommit(operation: SessionMessageLoadOperation, seq: number): void {
        const route = this.activeOpenSession;
        if (route?.sessionId === operation.sessionId
            && route.messageLease.leaseEpoch === operation.leaseEpoch
            && this.sessionMessageLoadGate.isCurrent(operation)) {
            route.committedPageSeq = Math.max(route.committedPageSeq ?? 0, seq);
            route.committedPageOperation = operation;
        }
    }

    private fetchInitialLatestPage = async (
        sessionId: string,
        _encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        operation: SessionMessageLoadOperation,
    ) => {
        const route = this.activeOpenSession;
        const data = await (route?.sessionId === sessionId && route.messageLease.leaseEpoch === operation.leaseEpoch
            ? route.latestPage
            : this.fetchLatestMessagePageRaw(sessionId));
        await this.applyLatestMessagePage(sessionId, data, operation);
    }

    private fetchForwardSince = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        fromSeq: number,
        operation: SessionMessageLoadOperation,
    ) => {
        const owner = this.captureHistoryOwner(sessionId, operation);
        const followLatest = this.historyWindows.get(sessionId)?.isAtLatest === true;
        let memoryWindow = this.historyWindows.get(sessionId);
        let persisted = true;
        let afterSeq = fromSeq;
        let didInvalidateGit = false;
        while (true) {
            if (!owner.isCurrent()) return;
            const response = await apiSocket.request(`/v3/sessions/${sessionId}/messages?after_seq=${afterSeq}&limit=100`);
            if (!owner.isCurrent()) return;
            if (response.status === 404) {
                this.removeSessionLocally(sessionId);
                return;
            }
            if (!response.ok) {
                throw new Error(`Failed to forward-sync ${sessionId}: ${response.status}`);
            }
            const data = await response.json() as V3GetSessionMessagesResponse;
            if (!owner.isCurrent()) return;
            const messages = Array.isArray(data.messages) ? data.messages : [];

            if (owner.history) persisted = await owner.history.commitPage(sessionId, { messages, hasMore: data.hasMore, direction: 'newer', boundary: afterSeq }) && persisted;
            if (!owner.isCurrent()) return;

            const applied = await this.applyFetchedMessages(sessionId, encryption, messages, operation, true);
            if (!applied.current) return;
            if (!didInvalidateGit
                && applied.hasMutableToolResult
                && storage.getState().currentViewingSessionId === sessionId) {
                gitStatusSync.invalidate(sessionId);
                didInvalidateGit = true;
            }
            if (followLatest) {
                const memoryLimit = Platform.OS === 'web'
                    ? (memoryWindow?.messages.length ?? 0) + messages.length
                    : 300;
                memoryWindow = memoryHistoryPage(memoryWindow, { messages, hasMore: data.hasMore }, 'newer', memoryLimit);
                if (Platform.OS === 'web' && (memoryWindow.messages.length > WEB_HISTORY_MAX_MESSAGES
                    || historyWindowBytes(memoryWindow) > WEB_HISTORY_MAX_BYTES)) {
                    const reading = await this.readSessionReadingState(sessionId);
                    if (!owner.isCurrent()) return;
                    await this.applyHistoryWindow(sessionId, memoryWindow, operation, {
                        compact: true, anchorSeq: reading?.followLatest === false ? reading.anchorSeq : undefined,
                    });
                    memoryWindow = this.historyWindows.get(sessionId);
                    if ((memoryWindow?.newestSeq ?? 0) < (messages.at(-1)?.seq ?? 0)) return;
                }
            }

            let maxSeq = afterSeq;
            for (const message of messages) {
                if (message.seq > maxSeq) maxSeq = message.seq;
            }
            if (!this.sessionMessageLoadGate.isCurrent(operation)) return;
            this.recordRoutePageCommit(operation, maxSeq);
            this.advanceLatestMessageSeq(sessionId, maxSeq);

            if (!data.hasMore) break;
            if (maxSeq === afterSeq) {
                log.log(`💬 fetchForwardSince: pagination stalled for ${sessionId}, stopping to avoid infinite loop`);
                break;
            }
            afterSeq = maxSeq;
        }
        if ((owner.history || Platform.OS === 'web') && owner.isCurrent() && followLatest && memoryWindow) {
            const diskLimit = Platform.OS === 'web' ? memoryWindow.messages.length : 300;
            const disk = persisted ? await owner.history?.readWindow(sessionId, { limit: diskLimit }) : null;
            const window = disk && memoryWindow.messages.every(message => disk.messages.some(row => row.id === message.id)) ? disk : memoryWindow;
            if (owner.isCurrent()) await this.applyHistoryWindow(sessionId, window, operation, { retainCurrentWebRows: true });
        }
    }

    private applyFetchedMessages = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        messages: ApiMessage[],
        operation: SessionMessageLoadOperation,
        advancesLatestProjection = false,
    ): Promise<{ current: boolean; hasMutableToolResult: boolean }> => {
        const owner = this.captureHistoryOwner(sessionId, operation);
        const warmAccount = this.sessionWarmCacheAccountKey;
        if (!this.sessionMessageLoadGate.isCurrent(operation)) {
            return { current: false, hasMutableToolResult: false };
        }
        if (messages.length === 0) {
            if (this.sessionWarmCacheAccountKey) {
                touchSessionWarmLatestPage(this.sessionWarmCacheAccountKey, sessionId);
            }
            return { current: true, hasMutableToolResult: false };
        }
        const decryptedMessages = await encryption.createDetached().decryptMessages(messages);
        if (!owner.isCurrent()
            || this.encryption.getSessionEncryption(sessionId) !== encryption) {
            return { current: false, hasMutableToolResult: false };
        }
        const fullyDecrypted = decryptedMessages.length === messages.length
            && decryptedMessages.every((decrypted) => !!decrypted && decrypted.content !== null);
        if (!fullyDecrypted) {
            throw new Error(`Failed to decrypt complete message page for ${sessionId}`);
        }
        const normalizedMessages: NormalizedMessage[] = [];
        for (let i = 0; i < decryptedMessages.length; i++) {
            const decrypted = decryptedMessages[i];
            if (!decrypted) continue;
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
            if (normalized) {
                normalizedMessages.push(normalized);
            }
        }
        this.retireObservedLocalMessages(sessionId, normalizedMessages);
        // Older pages may belong to a disconnected island below an ACK. Only
        // forward catch-up from the applied cursor certifies latest progress.
        this.applyMessages(sessionId, normalizedMessages,
            advancesLatestProjection ? Math.max(...messages.map(message => message.seq)) : undefined);
        this.recordFetchedMessageRange(sessionId, messages);
        if (warmAccount) {
            appendSessionWarmMessages(warmAccount, sessionId, messages);
        }
        return {
            current: true,
            hasMutableToolResult: this.containsMutableToolResult(sessionId, normalizedMessages),
        };
    }

    /**
     * Fetch one page of older messages for a session and prepend them to the
     * store. Called from the chat UI when the user scrolls past the top of
     * the currently loaded history. No-op when we have already fetched the
     * earliest message, when no initial fetch has happened yet, or when an
     * older-fetch is already in flight for this session.
     */
    loadOlderMessages = async (sessionId: string, viewport?: HistoryViewportReader) => {
        if ((this.localHistory || Platform.OS === 'web') && this.historyWindows.has(sessionId)) return this.loadHistoryBoundary(sessionId, 'older', viewport);
        const frontier = this.sessionMessageFrontiers.get(sessionId);
        if (!frontier?.hasMoreOlder || frontier.olderBeforeSeq == null || frontier.olderBeforeSeq <= 1) {
            return;
        }
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        if (!sessionMessages || sessionMessages.isLoadingOlder || this.sessionOlderLoadingTokens.has(sessionId) || !sessionMessages.hasMoreOlder) {
            return;
        }

        const cacheGeneration = this.sessionMessageCacheGenerations.get(sessionId) ?? {};
        this.sessionMessageCacheGenerations.set(sessionId, cacheGeneration);
        const loadingToken = {};
        this.sessionOlderLoadingTokens.set(sessionId, loadingToken);
        const encryptionOwner = this.encryption;
        const warmAccount = Platform.OS !== 'web' ? this.sessionWarmCacheAccountKey : null;
        let pageCacheGeneration = sessionHistoryPageCache.generation;
        const cachedPage = warmAccount ? sessionHistoryPageCache.readOlder(warmAccount, sessionId, frontier.olderBeforeSeq) : null;
        const ownsLoading = () => this.encryption === encryptionOwner
            && this.sessionMessageCacheGenerations.get(sessionId) === cacheGeneration
            && this.sessionOlderLoadingTokens.get(sessionId) === loadingToken;
        const setOlderError = (olderError: string | null) => storage.setState(state => state.sessionMessages[sessionId] ? ({
            sessionMessages: { ...state.sessionMessages, [sessionId]: { ...state.sessionMessages[sessionId], olderError } },
        }) : state);
        const lease = this.sessionMessageLoadGate.currentLease(sessionId)
            ?? this.sessionMessageLoadGate.enter(sessionId);
        const operation = this.sessionMessageLoadGate.begin(lease);
        setOlderError(null);
        if (!cachedPage) storage.getState().applyOlderMessagesLoading(sessionId, true);
        const lock = this.getSessionMessageLock(sessionId);
        try {
            await lock.inLock(async () => {
                if (!this.sessionMessageLoadGate.isCurrent(operation)) return;
                const encryption = this.encryption.getSessionEncryption(sessionId);
                if (!encryption) {
                    log.log(`💬 loadOlderMessages: encryption not ready for ${sessionId}`);
                    return;
                }
                // Re-read the cursor inside the lock. A concurrent
                // socket-pushed update or reload could have changed it.
                const currentFrontier = this.sessionMessageFrontiers.get(sessionId);
                const beforeSeq = currentFrontier?.olderBeforeSeq;
                if (!currentFrontier?.hasMoreOlder || beforeSeq == null || beforeSeq <= 1) {
                    return;
                }
                const fetchPage = async (): Promise<V3GetSessionMessagesResponse> => {
                    storage.getState().applyOlderMessagesLoading(sessionId, true);
                    const response = await apiSocket.request(
                        `/v3/sessions/${sessionId}/messages?before_seq=${beforeSeq}&limit=100`
                    );
                    if (!response.ok) {
                        throw new Error(`Failed to load older messages for ${sessionId}: ${response.status}`);
                    }
                    return await response.json() as V3GetSessionMessagesResponse;
                };
                let data = warmAccount && pageCacheGeneration === sessionHistoryPageCache.generation
                    ? beforeSeq === frontier.olderBeforeSeq ? cachedPage : sessionHistoryPageCache.readOlder(warmAccount, sessionId, beforeSeq)
                    : null;
                if (!data && warmAccount) {
                    await this.historyPrefetch.waitForPage(sessionId, beforeSeq);
                    if (!ownsLoading() || !this.sessionMessageLoadGate.isCurrent(operation)) return;
                    if (pageCacheGeneration === sessionHistoryPageCache.generation) {
                        data = sessionHistoryPageCache.readOlder(warmAccount, sessionId, beforeSeq);
                    }
                }
                let cached = data !== null;
                data ??= await fetchPage();
                let messages = Array.isArray(data.messages) ? data.messages : [];

                let applied;
                try {
                    applied = await this.applyFetchedMessages(sessionId, encryption, messages, operation);
                } catch (error) {
                    if (!cached || !warmAccount || !ownsLoading() || !this.sessionMessageLoadGate.isCurrent(operation)) throw error;
                    // Valid JSON may still contain ciphertext that cannot be
                    // decrypted with this session key. Retry the network once.
                    sessionHistoryPageCache.remove(warmAccount, sessionId);
                    pageCacheGeneration = sessionHistoryPageCache.generation;
                    cached = false;
                    data = await fetchPage();
                    messages = Array.isArray(data.messages) ? data.messages : [];
                    applied = await this.applyFetchedMessages(sessionId, encryption, messages, operation);
                }
                if (!applied.current) return;
                if (!cached && warmAccount) sessionHistoryPageCache.save(warmAccount, sessionId, beforeSeq,
                    { messages, hasMore: !!data.hasMore }, pageCacheGeneration);

                if (!this.sessionMessageLoadGate.isCurrent(operation)) return;
                const liveFrontier = this.sessionMessageFrontiers.get(sessionId);
                // Sparse server pages cover their requested boundary, not a
                // newer boundary established while this request was in flight.
                if (!liveFrontier || liveFrontier.olderBeforeSeq !== beforeSeq) return;
                const nextFrontier = applyOlderRange(
                    liveFrontier,
                    this.recordFetchedMessageRange(sessionId, messages), !!data.hasMore,
                    [...(this.sessionCachedMessageSeqs.get(sessionId) ?? [])],
                );
                this.sessionMessageFrontiers.set(sessionId, nextFrontier);
                storage.getState().applyOlderMessagesPagination(sessionId, {
                    hasMore: nextFrontier.hasMoreOlder,
                });
            });
        } catch (error) {
            if (ownsLoading()) setOlderError(error instanceof Error ? error.message : 'History unavailable');
            throw error;
        } finally {
            if (ownsLoading()) {
                if (!this.sessionMessageLoadGate.isCurrent(operation)) setOlderError('History load interrupted. Retry.');
                this.sessionOlderLoadingTokens.delete(sessionId);
                storage.getState().applyOlderMessagesLoading(sessionId, false);
            }
        }
    }

    private registerPushToken = async () => {
        log.log('registerPushToken');
        try {
            const result = await syncCurrentPushToken(this.credentials);
            log.log('Push token sync result: ' + JSON.stringify({
                registered: result.registered,
                hasToken: !!result.token,
                permission: result.permission.status,
                error: result.error,
            }));
            this.sessionEventLocalNotificationsEnabled = shouldEnableSessionEventLocalNotifications(result);
            log.log('Session-event local notification fallback: ' + (this.sessionEventLocalNotificationsEnabled ? 'enabled' : 'disabled'));
            if (!result.permission.granted) {
                console.log('Failed to get push token for push notification!');
            }
        } catch (error) {
            log.log('Failed to register push token: ' + JSON.stringify(error));
        }
    }

    private stopTextStreamStatus: (() => void) | undefined;

    private handleSessionTextStream = async (data: unknown): Promise<void> => {
        const parsed = SessionStreamEnvelopeSchema.safeParse(data);
        if (!parsed.success) return;
        const { sid } = parsed.data;
        const route = this.sessionRouteOwnership.current();
        const credentials = this.credentials;
        const encryption = this.encryption.getSessionEncryption(sid);
        if (!route || route.phase !== 'interactive' || route.sessionId !== sid || !encryption) return;
        await sessionTextStream.receive(parsed.data, value => encryption.decryptRaw(value), () =>
            this.credentials === credentials && this.sessionRouteOwnership.owns(route)
            && this.sessionRouteOwnership.current()?.phase === 'interactive'
            && this.encryption.getSessionEncryption(sid) === encryption);
    };

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));
        apiSocket.onMessage('session-stream', this.handleSessionTextStream);
        this.stopTextStreamStatus?.();
        this.stopTextStreamStatus = apiSocket.onStatusChange(status => {
            if (status !== 'connected') sessionTextStream.interrupt();
        });

        // Subscribe to connection state changes
        apiSocket.onReconnected(() => {
            log.log('🔌 Socket reconnected');

            // Send current focus state on reconnect so the server's
            // suppression rules pick up where we left off (handshake.auth.appState
            // covers the very first connect; this covers reconnects).
            apiSocket.sendAppState(getCurrentAppState());

            // Active summaries discover current sessions while the retrying
            // reconnect invalidator reconciles change cursors. Both respect the
            // route-aware opening gate; repeated signals retain a trailing pass.
            // No reconnect path uses the legacy account-wide session response.
            this.sessionReconnectSync.invalidate();
            this.machinesSync.invalidate();
            log.log('🔌 Socket reconnected: Invalidating artifacts sync');
            this.artifactsSync.invalidate();
            this.feedSync.invalidate();
            this.pluginCatalogSync.invalidate();
            // Messages are fetched lazily per-session via onSessionVisible (called by SessionView
            // when realtimeStatus changes). Session metadata + agentState (including permission
            // requests) are refreshed through changes or bounded active summaries above.
            for (const sync of this.sendSync.values()) {
                sync.invalidate();
            }
        });
    }

    private handleUpdate = async (update: unknown) => {
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            log.log('session-update-invalid');
            return;
        }
        const updateData = validatedUpdate.data;
        console.log(`🔄 Sync: Validated update type: ${updateData.body.t}`);

        const body = updateData.body;
        const sessionId = body.t === 'new-session' || body.t === 'update-session' ? body.id
            : body.t === 'new-message' || body.t === 'delete-session' ? body.sid : null;
        if (sessionId && body.t === 'new-session'
            && updateData.seq <= (this.sessionEventCursors.get(sessionId) ?? -1)) return;
        if (sessionId) this.sessionEventCursors.set(sessionId, Math.max(updateData.seq, this.sessionEventCursors.get(sessionId) ?? -1));
        const write = { mutationGeneration: this.sessionMutationGeneration };
        const encryptionOwner = this.encryption;
        const historyOwner = sessionId ? this.captureHistoryOwner(sessionId) : null;
        this.inFlightSessionRefreshes.add(write);
        const assertCurrent = () => {
            if ((historyOwner && !historyOwner.isCurrent()) || this.encryption !== encryptionOwner || (sessionId
                && (this.sessionDeletionMutationGenerations.get(sessionId) ?? 0) > write.mutationGeneration)) {
                throw new SessionWriteCancelled();
            }
        };
        try {

        if (updateData.body.t === 'new-message') {
            let persisted = false;
            if (updateData.body.message && historyOwner?.history) {
                persisted = await historyOwner.history.appendMessages(updateData.body.sid, [updateData.body.message]);
                assertCurrent();
                this.pendingHistoryTargets.set(updateData.body.sid, Math.max(this.pendingHistoryTargets.get(updateData.body.sid) ?? 0, updateData.body.message.seq));
            }

            // Get encryption — may not be ready if sessions are still syncing
            if (!await this.ensureRealtimeSessionReady(updateData.body.sid)) {
                console.error(`Session ${updateData.body.sid} not found after bootstrap`);
                return;
            }
            assertCurrent();
            const encryption = this.encryption.getSessionEncryption(updateData.body.sid)!.createDetached();

            // Decrypt message
            let lastMessage: NormalizedMessage | null = null;
            if (updateData.body.message) {
                const decrypted = await encryption.decryptMessage(updateData.body.message);
                assertCurrent();
                if (decrypted) {
                    lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                    if (lastMessage) this.retireObservedLocalMessages(updateData.body.sid, [lastMessage]);

                    // Startup-ready measures validated realtime receipt, before
                    // sequence, visibility, cache locks or route hydration can
                    // discard/delay this packet. History replay is not receipt.
                    if (lastMessage?.role === 'event' && lastMessage.content.type === 'ready'
                        && lastMessage.content.terminal !== true) {
                        sessionStartupTraceRuntime.markSessionStage(updateData.body.sid, 'web.processor.ready_received');
                    }

                    // Check for task lifecycle events to update thinking state
                    // This ensures UI updates even if volatile activity updates are lost
                    const rawContent = decrypted.content as {
                        role?: string;
                        content?: {
                            type?: string;
                            data?: {
                                type?: string;
                                ev?: { t?: string };
                            }
                        }
                    } | null;
                    const contentType = rawContent?.content?.type;
                    const dataType = rawContent?.content?.data?.type;
                    const sessionEventType = rawContent?.content?.data?.ev?.t;
                    
                    // Debug logging to trace lifecycle events
                    if (dataType === 'task_complete' || dataType === 'turn_aborted' || dataType === 'task_started' || sessionEventType === 'turn-start' || sessionEventType === 'turn-end') {
                        console.log(`🔄 [Sync] Lifecycle event detected: contentType=${contentType}, dataType=${dataType}, sessionEventType=${sessionEventType}`);
                    }
                    
                    const isTaskComplete = 
                        ((contentType === 'acp' || contentType === 'codex') && 
                            (dataType === 'task_complete' || dataType === 'turn_aborted')) ||
                        (contentType === 'session' && sessionEventType === 'turn-end');
                    
                    const isTaskStarted = 
                        ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started') ||
                        (contentType === 'session' && sessionEventType === 'turn-start');
                    
                    if (isTaskComplete || isTaskStarted) {
                        console.log(`🔄 [Sync] Updating thinking state: isTaskComplete=${isTaskComplete}, isTaskStarted=${isTaskStarted}`);
                    }
                    // Update session
                    const session = storage.getState().sessions[updateData.body.sid];
                    if (session) {
                        this.applySessions([{
                            ...session,
                            updatedAt: updateData.createdAt,
                            seq: Math.max(session.seq, updateData.body.message.seq),
                            // Update thinking state based on task lifecycle events
                            ...(isTaskComplete ? { thinking: false } : {}),
                            ...(isTaskStarted ? { thinking: true } : {})
                        }])
                    }

                    const historyWindow = this.historyWindows.get(updateData.body.sid);
                    if (historyWindow && !historyWindow.isAtLatest) {
                        const sid = updateData.body.sid;
                        // This receipt will not be projected while reading old
                        // history, and may fall outside the next latest window.
                        // Retire its preview now so it cannot reappear on jump.
                        if (lastMessage) sessionTextStream.observeDurable(sid, [lastMessage]);
                        storage.setState(state => ({ sessionMessages: { ...state.sessionMessages,
                            [sid]: { ...state.sessionMessages[sid], hasMoreNewer: true, isAtLatest: false },
                        } }));
                        return;
                    }
                    // Fast-path only on consecutive seq values, otherwise fetch from server.
                    // ACKs can observe an isolated sequence before its echo or
                    // intervening rows are projected. Only the applied prefix
                    // plus admitted queued rows can authorize the live fast path.
                    const currentLastSeq = this.getSessionProjectedMessageSeq(updateData.body.sid, true);
                    const incomingSeq = updateData.body.message.seq;
                    const isVisible = storage.getState().currentViewingSessionId === updateData.body.sid
                        || this.sessionRouteOwnership.ownsSession(updateData.body.sid);
                    if (currentLastSeq !== null && incomingSeq <= currentLastSeq) {
                        // Duplicate or out-of-order delivery. The cache already
                        // owns this sequence, so neither history nor Git needs
                        // to be refreshed.
                        if (lastMessage) sessionTextStream.observeDurable(updateData.body.sid, [lastMessage]);
                    } else if (lastMessage && currentLastSeq !== null && incomingSeq === currentLastSeq + 1) {
                        // Inspect tool ownership before replay can evict the tool
                        // row, and preserve the live refresh on compaction returns.
                        if (isVisible && this.containsMutableToolResult(updateData.body.sid, [lastMessage])) {
                            gitStatusSync.invalidate(updateData.body.sid);
                        }
                        if (historyWindow) {
                            const messages = [...historyWindow.messages, updateData.body.message];
                            const appended = { ...historyWindow, messages,
                                oldestSeq: historyWindow.oldestSeq ?? incomingSeq, newestSeq: incomingSeq };
                            if (Platform.OS === 'web' && (messages.length > WEB_HISTORY_MAX_MESSAGES
                                || historyWindowBytes(appended) > WEB_HISTORY_MAX_BYTES)) {
                                const sid = updateData.body.sid;
                                const reading = await this.readSessionReadingState(sid);
                                assertCurrent();
                                // Apply this live event once for thinking/usage/permissions;
                                // replay below only replaces the displayed projection.
                                this.enqueueMessages(sid, [lastMessage], incomingSeq);
                                const lease = this.sessionMessageLoadGate.currentLease(sid) ?? this.sessionMessageLoadGate.enter(sid);
                                await this.applyHistoryWindow(sid, appended, this.sessionMessageLoadGate.begin(lease), {
                                    compact: true, anchorSeq: reading?.followLatest === false ? reading.anchorSeq : undefined,
                                });
                                return;
                            }
                            if (Platform.OS !== 'web' && messages.length > 300 && historyOwner?.history) {
                                const sid = updateData.body.sid;
                                const fallback = memoryHistoryPage(historyWindow, { messages: [updateData.body.message], hasMore: false }, 'newer');
                                const disk = persisted ? await historyOwner.history.readWindow(sid, { limit: 300 }) : null;
                                const complete = disk && fallback.messages.every(message => disk.messages.some(row => row.id === message.id));
                                let bounded = complete ? disk : fallback;
                                const reading = await historyOwner.history.readReadingState(sid);
                                if (reading && bounded?.oldestSeq && reading.anchorSeq < bounded.oldestSeq) {
                                    bounded = complete ? await historyOwner.history.readWindow(sid, { anchorSeq: reading.anchorSeq, limit: 300 }) ?? bounded : bounded;
                                }
                                assertCurrent();
                                const lease = this.sessionMessageLoadGate.currentLease(sid);
                                if (bounded && lease) await this.applyHistoryWindow(sid, bounded, this.sessionMessageLoadGate.begin(lease));
                                assertCurrent();
                                // Compaction can retain an older reading anchor
                                // instead of projecting this completion record.
                                if (!bounded?.messages.some(message => message.seq === incomingSeq)) {
                                    sessionTextStream.observeDurable(sid, [lastMessage]);
                                }
                                return;
                            }
                            this.historyWindows.set(updateData.body.sid, appended);
                            this.historyWireProvenance.get(updateData.body.sid)?.set(lastMessage.id, updateData.body.message.id);
                        }
                        this.enqueueMessages(updateData.body.sid, [lastMessage], incomingSeq);
                        this.advanceLatestMessageSeq(updateData.body.sid, incomingSeq);
                        if (this.sessionWarmCacheAccountKey) appendSessionWarmMessages(this.sessionWarmCacheAccountKey, updateData.body.sid, [updateData.body.message]);
                    } else if (isVisible) {
                        const route = this.activeOpenSession;
                        if (route?.sessionId === updateData.body.sid) {
                            route.foregroundTarget = Math.max(route.foregroundTarget, incomingSeq);
                        }
                        this.getMessagesSync(updateData.body.sid).invalidate(incomingSeq);
                    } else {
                        this.releaseSessionMessageCache(updateData.body.sid);
                    }
                }
            }

        } else if (updateData.body.t === 'new-session') {
            log.log('🆕 New session update received');
            const snapshot = stripNewSessionDiscriminator(updateData.body);
            const request = this.writeSessionSnapshots(async () => [snapshot])
                .then(() => Boolean(storage.getState().sessions[snapshot.id] && this.encryption.getSessionEncryption(snapshot.id)));
            this.sessionHydrations.set(snapshot.id, request);
            try { await request; }
            finally {
                if (this.sessionHydrations.get(snapshot.id) === request) this.sessionHydrations.delete(snapshot.id);
            }
        } else if (updateData.body.t === 'delete-session') {
            log.log('🗑️ Delete session update received');
            const sessionId = updateData.body.sid;
            this.removeSessionLocally(sessionId);

            log.log(`🗑️ Session ${sessionId} deleted from local storage`);
        } else if (updateData.body.t === 'update-session') {
            // Session + encryption may not be initialized yet if sessions are
            // still hydrating on startup. Await the active bootstrap, then use
            // one targeted snapshot if needed before applying this same event;
            // dropping here silently loses the metadata update that carries the
            // chat title (#1251: every chat stuck on "New chat").
            if (!await this.ensureRealtimeSessionReady(updateData.body.id)) {
                console.error(`Session ${updateData.body.id} not found after bootstrap`);
                return;
            }
            assertCurrent();
            const session = storage.getState().sessions[updateData.body.id];
            const sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id)?.createDetached();
            if (session) {
                if (!sessionEncryption) {
                    console.error(`Session encryption not found for ${updateData.body.id} after bootstrap`);
                    return;
                }

                const agentState = updateData.body.agentState && sessionEncryption
                    ? await sessionEncryption.decryptAgentState(updateData.body.agentState.version, updateData.body.agentState.value)
                    : session.agentState;
                const metadata = updateData.body.metadata && sessionEncryption
                    ? await sessionEncryption.decryptMetadata(updateData.body.metadata.version, updateData.body.metadata.value)
                    : session.metadata;
                assertCurrent();

                this.applySessions([{
                    ...session,
                    agentState,
                    agentStateVersion: updateData.body.agentState
                        ? updateData.body.agentState.version
                        : session.agentStateVersion,
                    metadata,
                    metadataVersion: updateData.body.metadata
                        ? updateData.body.metadata.version
                        : session.metadataVersion,
                    updatedAt: updateData.createdAt,
                    seq: session.seq
                }]);

                const history = historyOwner?.history;
                if (history) {
                    const wire = await history.readSnapshot(updateData.body.id);
                    assertCurrent();
                    if (wire) await history.writeSnapshots([{
                        ...wire, updatedAt: updateData.createdAt,
                        ...(updateData.body.metadata ? { metadata: updateData.body.metadata.value, metadataVersion: updateData.body.metadata.version } : {}),
                        ...(updateData.body.agentState ? { agentState: updateData.body.agentState.value, agentStateVersion: updateData.body.agentState.version } : {}),
                    }]);
                    assertCurrent();
                }

                // Agent-state updates carry permissions/control state, not a
                // concrete mutable tool result, so they do not refresh Git.
                if (updateData.body.agentState) {
                    const isVisible = storage.getState().currentViewingSessionId === updateData.body.id;

                    // Check for new permission requests and notify voice assistant
                    if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
                        const requestIds = Object.keys(agentState.requests);
                        const firstRequest = agentState.requests[requestIds[0]];
                        const toolName = firstRequest?.tool;
                        voiceHooks.onPermissionRequested(updateData.body.id, requestIds[0], toolName, firstRequest?.arguments);
                    }

                    // Re-fetch messages when control returns to mobile (local -> remote mode switch)
                    // This catches up on any messages that were exchanged while desktop had control
                    const wasControlledByUser = session.agentState?.controlledByUser;
                    const isNowControlledByUser = agentState?.controlledByUser;
                    if (isVisible && !wasControlledByUser && isNowControlledByUser) {
                        log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                        this.getMessagesSync(updateData.body.id).invalidate();
                    }
                }
            }
        } else if (updateData.body.t === 'update-account') {
            const accountUpdate = updateData.body;
            const currentProfile = storage.getState().profile;
            const hadGitHub = !!currentProfile.github?.login;

            // Build updated profile with new data
            const updatedProfile: Profile = {
                ...currentProfile,
                firstName: accountUpdate.firstName !== undefined ? accountUpdate.firstName : currentProfile.firstName,
                lastName: accountUpdate.lastName !== undefined ? accountUpdate.lastName : currentProfile.lastName,
                avatar: accountUpdate.avatar !== undefined ? accountUpdate.avatar : currentProfile.avatar,
                github: accountUpdate.github !== undefined ? accountUpdate.github : currentProfile.github,
                timestamp: updateData.createdAt // Update timestamp to latest
            };

            // Apply the updated profile to storage
            storage.getState().applyProfile(updatedProfile);

            if (!hadGitHub && updatedProfile.github?.login) {
                trackGitHubConnected();
            }

            // Handle settings updates (new for profile sync)
            if (accountUpdate.settings?.value) {
                try {
                    const decryptedSettings = await this.encryption.decryptRaw(accountUpdate.settings.value);
                    const parsedSettings = decryptedSettings
                        ? settingsParse(decryptedSettings)
                        : { ...settingsDefaults };

                    // Version compatibility check
                    const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
                    if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                        console.warn(
                            `⚠️ Received settings schema v${settingsSchemaVersion}, ` +
                            `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`
                        );
                    }

                    this.applyServerSettings(parsedSettings, accountUpdate.settings.version, decryptedSettings);
                    log.log(`📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${accountUpdate.settings.version})`);
                } catch (error) {
                    console.error('❌ Failed to process settings update:', error);
                    // Don't crash on settings sync errors, just log
                }
            }
        } else if (updateData.body.t === 'new-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;

            // Brand-new machines (cold onboarding) are delivered via 'new-machine'
            // before any fetchMachines has seen them, so their per-machine
            // encryption isn't initialized yet. The update carries the data
            // encryption key — register it here (mirroring fetchMachines) or every
            // later decrypt for this machine fails and it never lands in storage,
            // leaving the new-session screen unable to start a session until an app
            // restart / socket reconnect triggers a full machine refetch.
            const machineKeysMap = new Map<string, Uint8Array | null>();
            if (machineUpdate.dataEncryptionKey) {
                const decryptedKey = await this.encryption.decryptEncryptionKey(machineUpdate.dataEncryptionKey);
                if (decryptedKey) {
                    machineKeysMap.set(machineId, decryptedKey);
                    this.machineDataKeys.set(machineId, decryptedKey);
                } else {
                    console.error(`Failed to decrypt data encryption key for new machine ${machineId}`);
                    machineKeysMap.set(machineId, null);
                }
            } else {
                machineKeysMap.set(machineId, null);
            }
            await this.encryption.initializeMachines(machineKeysMap);

            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                console.error(`Machine encryption not found for ${machineId} after init - cannot apply new-machine`);
                return;
            }

            // Preserve an existing createdAt if we somehow already know this machine.
            const existing = storage.getState().machines[machineId];
            const newMachine: Machine = {
                id: machineId,
                seq: machineUpdate.seq,
                createdAt: existing?.createdAt ?? machineUpdate.createdAt,
                updatedAt: machineUpdate.updatedAt,
                active: machineUpdate.active,
                activeAt: machineUpdate.activeAt,
                metadata: null,
                metadataVersion: machineUpdate.metadataVersion,
                daemonState: null,
                daemonStateVersion: machineUpdate.daemonStateVersion
            };

            // Decrypt best-effort; still apply the machine on failure so it stays
            // visible/usable (matches fetchMachines' fallback behavior).
            try {
                newMachine.metadata = machineUpdate.metadata
                    ? await machineEncryption.decryptMetadata(machineUpdate.metadataVersion, machineUpdate.metadata)
                    : null;
                newMachine.daemonState = machineUpdate.daemonState
                    ? await machineEncryption.decryptDaemonState(machineUpdate.daemonStateVersion, machineUpdate.daemonState)
                    : null;
            } catch (error) {
                console.error(`Failed to decrypt new machine ${machineId}:`, error);
            }

            storage.getState().applyMachines([newMachine]);
        } else if (updateData.body.t === 'update-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;  // Changed from .id to .machineId
            const machine = storage.getState().machines[machineId];

            // Create or update machine with all required fields
            const updatedMachine: Machine = {
                id: machineId,
                seq: updateData.seq,
                createdAt: machine?.createdAt ?? updateData.createdAt,
                updatedAt: updateData.createdAt,
                active: machineUpdate.active ?? true,
                activeAt: machineUpdate.activeAt ?? updateData.createdAt,
                metadata: machine?.metadata ?? null,
                metadataVersion: machine?.metadataVersion ?? 0,
                daemonState: machine?.daemonState ?? null,
                daemonStateVersion: machine?.daemonStateVersion ?? 0
            };

            // Get machine-specific encryption (might not exist if machine wasn't initialized)
            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                console.error(`Machine encryption not found for ${machineId} - cannot decrypt updates`);
                return;
            }

            // If metadata is provided, decrypt and update it
            const metadataUpdate = machineUpdate.metadata;
            if (metadataUpdate) {
                try {
                    const metadata = await machineEncryption.decryptMetadata(metadataUpdate.version, metadataUpdate.value);
                    updatedMachine.metadata = metadata;
                    updatedMachine.metadataVersion = metadataUpdate.version;
                } catch (error) {
                    console.error(`Failed to decrypt machine metadata for ${machineId}:`, error);
                }
            }

            // If daemonState is provided, decrypt and update it
            const daemonStateUpdate = machineUpdate.daemonState;
            if (daemonStateUpdate) {
                try {
                    const daemonState = await machineEncryption.decryptDaemonState(daemonStateUpdate.version, daemonStateUpdate.value);
                    updatedMachine.daemonState = daemonState;
                    updatedMachine.daemonStateVersion = daemonStateUpdate.version;
                } catch (error) {
                    console.error(`Failed to decrypt machine daemonState for ${machineId}:`, error);
                }
            }

            // Update storage using applyMachines which rebuilds sessionListViewData
            storage.getState().applyMachines([updatedMachine]);
        } else if (updateData.body.t === 'delete-machine') {
            const machineId = updateData.body.machineId;
            log.log(`🗑️ Delete machine update received for ${machineId}`);
            if (!storage.getState().machines[machineId]) {
                log.log(`Machine ${machineId} not in storage, skipping delete`);
            } else {
                storage.getState().deleteMachine(machineId);
                this.encryption.removeMachineEncryption(machineId);
                this.machineDataKeys.delete(machineId);
            }
        } else if (updateData.body.t === 'new-artifact') {
            log.log('📦 Received new-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            try {
                // Decrypt the data encryption key
                const decryptedKey = await this.encryption.decryptEncryptionKey(artifactUpdate.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error(`Failed to decrypt key for new artifact ${artifactId}`);
                    return;
                }
                
                // Store the decrypted key in memory
                this.artifactDataKeys.set(artifactId, decryptedKey);
                
                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(decryptedKey);
                
                // Decrypt header
                const header = await artifactEncryption.decryptHeader(artifactUpdate.header);
                
                // Decrypt body if provided
                let decryptedBody: string | null | undefined = undefined;
                if (artifactUpdate.body && artifactUpdate.bodyVersion !== undefined) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body);
                    decryptedBody = body?.body || null;
                }
                
                // Add to storage
                const decryptedArtifact: DecryptedArtifact = {
                    id: artifactId,
                    title: header?.title || null,
                    body: decryptedBody,
                    headerVersion: artifactUpdate.headerVersion,
                    bodyVersion: artifactUpdate.bodyVersion,
                    seq: artifactUpdate.seq,
                    createdAt: artifactUpdate.createdAt,
                    updatedAt: artifactUpdate.updatedAt,
                    isDecrypted: !!header,
                };
                
                storage.getState().addArtifact(decryptedArtifact);
                log.log(`📦 Added new artifact ${artifactId} to storage`);
            } catch (error) {
                console.error(`Failed to process new artifact ${artifactId}:`, error);
            }
        } else if (updateData.body.t === 'update-artifact') {
            log.log('📦 Received update-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            // Get existing artifact
            const existingArtifact = storage.getState().artifacts[artifactId];
            if (!existingArtifact) {
                console.error(`Artifact ${artifactId} not found in storage`);
                // Fetch all artifacts to sync
                this.artifactsSync.invalidate();
                return;
            }
            
            try {
                // Get the data encryption key from memory
                let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
                if (!dataEncryptionKey) {
                    console.error(`Encryption key not found for artifact ${artifactId}, fetching artifacts`);
                    this.artifactsSync.invalidate();
                    return;
                }
                
                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
                
                // Update artifact with new data  
                const updatedArtifact: DecryptedArtifact = {
                    ...existingArtifact,
                    seq: updateData.seq,
                    updatedAt: updateData.createdAt,
                };
                
                // Decrypt and update header if provided
                if (artifactUpdate.header) {
                    const header = await artifactEncryption.decryptHeader(artifactUpdate.header.value);
                    updatedArtifact.title = header?.title || null;
                    updatedArtifact.sessions = header?.sessions;
                    updatedArtifact.draft = header?.draft;
                    updatedArtifact.headerVersion = artifactUpdate.header.version;
                }
                
                // Decrypt and update body if provided
                if (artifactUpdate.body) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body.value);
                    updatedArtifact.body = body?.body || null;
                    updatedArtifact.bodyVersion = artifactUpdate.body.version;
                }
                
                storage.getState().updateArtifact(updatedArtifact);
                log.log(`📦 Updated artifact ${artifactId} in storage`);
            } catch (error) {
                console.error(`Failed to process artifact update ${artifactId}:`, error);
            }
        } else if (updateData.body.t === 'delete-artifact') {
            log.log('📦 Received delete-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            // Remove from storage
            storage.getState().deleteArtifact(artifactId);
            
            // Remove encryption key from memory
            this.artifactDataKeys.delete(artifactId);
        } else if (updateData.body.t === 'new-feed-post') {
            log.log('📰 Received new-feed-post update');
            const feedUpdate = updateData.body;
            
            // Convert to FeedItem with counter from cursor
            const feedItem: FeedItem = {
                id: feedUpdate.id,
                body: feedUpdate.body,
                cursor: feedUpdate.cursor,
                createdAt: feedUpdate.createdAt,
                repeatKey: feedUpdate.repeatKey,
                counter: parseInt(feedUpdate.cursor.substring(2), 10)
            };
            
            if (feedItem.body.kind !== 'text') return;

            // Apply to storage (will handle repeatKey replacement)
            storage.getState().applyFeedItems([feedItem]);
        }
        } catch (error) {
            if (!(error instanceof SessionWriteCancelled)) throw error;
        } finally {
            this.inFlightSessionRefreshes.delete(write);
            this.pruneSessionDeletionTombstones();
        }
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        // log.log(`🔄 Flushing activity updates for ${updates.size} sessions - acquiring lock`);


        const sessions: Session[] = [];

        for (const [sessionId, update] of updates) {
            const session = storage.getState().sessions[sessionId];
            if (session) {
                sessions.push({
                    ...session,
                    active: update.active,
                    activeAt: update.activeAt,
                    thinking: update.thinking ?? false,
                    thinkingAt: update.activeAt // Always use activeAt for consistency
                });
            }
        }

        if (sessions.length > 0) {
            // console.log('flushing activity updates ' + sessions.length);
            this.applySessions(sessions);
            // log.log(`🔄 Activity updates flushed - updated ${sessions.length} sessions`);
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid ephemeral update received:', validatedUpdate.error);
            console.error('Invalid ephemeral update received:', update);
            return;
        } else {
            // console.log('Ephemeral update received:', update);
        }
        const updateData = validatedUpdate.data;

        // Process activity updates through smart debounce accumulator
        if (updateData.type === 'activity') {
            // console.log('adding activity update ' + updateData.id);
            this.activityAccumulator.addUpdate(updateData);
        }

        // Handle machine activity updates
        if (updateData.type === 'machine-activity') {
            // Update machine's active status and lastActiveAt
            const machine = storage.getState().machines[updateData.id];
            if (machine) {
                const updatedMachine: Machine = {
                    ...machine,
                    active: updateData.active,
                    activeAt: updateData.activeAt
                };
                storage.getState().applyMachines([updatedMachine]);
            }
        }

        // Session-level lifecycle event (Claude finished, needs permission, asks question).
        // This is the same signal that triggers the mobile push — bump browser-tab
        // unread counter on these only, ignore the noisy per-message stream.
        if (updateData.type === 'session-event') {
            notifyUnreadMessage();
            const currentState = storage.getState();
            if (shouldMarkSessionEventUnread(
                this.appState,
                currentState.currentViewingSessionId,
                updateData.sessionId,
            )) {
                currentState.markSessionUnread(updateData.sessionId);
            }
            void maybeScheduleSessionEventLocalNotification(updateData, {
                enabled: this.sessionEventLocalNotificationsEnabled,
            });
        }

        // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    }

    //
    // Apply store
    //

    private applyMessages = (sessionId: string, messages: NormalizedMessage[], latestAppliedSeq?: number) => {
        const result = storage.getState().applyMessages(sessionId, messages, latestAppliedSeq);
        sessionTextStream.observeDurable(sessionId, messages);
        const hasCompletedTurn = messages.some((message) => (
            message.role === 'event'
            && message.content.type === 'ready'
            && message.content.terminal === true
        ));
        let m: Message[] = [];
        for (let messageId of result.changed) {
            const message = storage.getState().sessionMessages[sessionId].messagesMap[messageId];
            if (message) {
                m.push(message);
            }
        }
        if (m.length > 0) {
            voiceHooks.onMessages(sessionId, m);
        }
        if (result.hasReadyEvent) {
            voiceHooks.onReady(sessionId);
        }
        if (messages.some((message) => message.role === 'agent' && !message.isSidechain && message.content.length > 0)) {
            sessionStartupTraceRuntime.markSessionStage(sessionId, 'web.first_agent_event_received');
        }
        if (hasCompletedTurn) {
            sessionStartupTraceRuntime.markSessionStage(sessionId, 'web.turn.completed');
        }
    }

    private applySessions = (
        sessions: HydratedSession[],
        options?: SessionApplyOptions,
        refreshMutationGeneration?: number,
    ) => {
        const incomingById = new Map<string, HydratedSession[]>();
        for (const session of sessions) {
            const incoming = incomingById.get(session.id);
            if (incoming) incoming.push(session);
            else incomingById.set(session.id, [session]);
        }

        const mergedSessions = [...incomingById.entries()].flatMap(([sessionId, incoming]) => {
            const deletedAfterRefresh = options?.replace
                && refreshMutationGeneration !== undefined
                && (this.sessionDeletionMutationGenerations.get(sessionId) ?? 0) > refreshMutationGeneration;
            if (deletedAfterRefresh) return [];

            const existing = storage.getState().sessions[sessionId];
            const merged = mergeHydratedSessions(existing ? [existing, ...incoming] : incoming);
            if (!options?.replace && existing && (merged === existing || (
                merged.seq === existing.seq && merged.updatedAt === existing.updatedAt
                && merged.active === existing.active && merged.activeAt === existing.activeAt
                && merged.thinking === existing.thinking && merged.thinkingAt === existing.thinkingAt
                && (merged.presence === undefined || merged.presence === existing.presence)
                && merged.createdAt === existing.createdAt
                && merged.metadataVersion === existing.metadataVersion
                && merged.agentStateVersion === existing.agentStateVersion
                && JSON.stringify(merged.metadata) === JSON.stringify(existing.metadata)
                && JSON.stringify(merged.agentState) === JSON.stringify(existing.agentState)
            ))) return [];
            return [merged];
        });

        // Foreground snapshots are often identical. Do not rebuild/sort every
        // sidebar list (or notify its subscribers) for an empty incremental merge.
        // An empty replacement still has meaning: it removes missing sessions.
        if (!options?.replace && mergedSessions.length === 0) return;

        if (options?.replace && refreshMutationGeneration !== undefined) {
            const incomingIds = new Set(mergedSessions.map((session) => session.id));
            for (const [sessionId, existing] of Object.entries(storage.getState().sessions)) {
                if (!incomingIds.has(sessionId)
                    && (this.sessionMutationGenerations.get(sessionId) ?? 0) > refreshMutationGeneration) {
                    mergedSessions.push(existing);
                }
            }
        }

        if (!options?.replace && mergedSessions.length > 0) {
            const mutationGeneration = ++this.sessionMutationGeneration;
            for (const session of mergedSessions) {
                this.sessionMutationGenerations.set(session.id, mutationGeneration);
            }
        }
        const removedSessionIds = options?.replace
            ? this.getSessionIdsMissingFromSnapshot(mergedSessions)
            : [];
        const active = storage.getState().getActiveSessions();
        storage.getState().applySessions(mergedSessions, options);
        for (const sessionId of removedSessionIds) {
            this.clearSessionRuntimeState(sessionId);
        }
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);
    }

    private pruneSessionDeletionTombstones() {
        for (const [sessionId, deletionMutationGeneration] of this.sessionDeletionMutationGenerations) {
            const hasOlderRefreshInFlight = [...this.inFlightSessionRefreshes].some(
                (refresh) => refresh.mutationGeneration < deletionMutationGeneration,
            );
            if (!hasOlderRefreshInFlight) {
                this.sessionDeletionMutationGenerations.delete(sessionId);
            }
        }
    }

    private getSessionIdsMissingFromSnapshot(sessions: Array<{ id: string }>): string[] {
        const incomingIds = new Set(sessions.map((session) => session.id));
        return Object.keys(storage.getState().sessions).filter((sessionId) => !incomingIds.has(sessionId));
    }

    private clearSessionRuntimeState(sessionId: string) {
        const owner = this.sessionRouteOwnership.current();
        if (owner?.sessionId === sessionId) this.leaveSessionRoute(owner);
        // The loaded component's later cleanup no longer owns a deleted route.
        if (storage.getState().currentViewingSessionId === sessionId) {
            storage.getState().setCurrentViewingSession(null);
        }
        this.releaseSessionMessageCache(sessionId);
        this.acceptedLocalMessageReceipts.delete(sessionId);
        this.observedLocalMessageIds.delete(sessionId);
        this.encryption?.removeSessionEncryption(sessionId);
        gitStatusSync.clearForSession(sessionId);
        this.sendSync.delete(sessionId);
        this.pendingOutbox.delete(sessionId);
    }

    public removeSessionLocally = (sessionId: string): void => {
        void this.localHistory?.deleteSession(sessionId);
        if (!this.localHistory && this.sessionWarmCacheAccountKey) invalidateLocalHistorySession(this.sessionWarmCacheAccountKey, sessionId);
        const deletionMutationGeneration = ++this.sessionMutationGeneration;
        this.sessionDeletionMutationGenerations.set(sessionId, deletionMutationGeneration);
        const organization = storage.getState().settings.sidebarOrganization;
        const nextOrganization = removeSidebarSession(organization, sessionId);
        if (nextOrganization !== organization) this.applySettings({ sidebarOrganization: nextOrganization });
        storage.getState().deleteSession(sessionId);
        if (this.sessionWarmCacheAccountKey) removeSessionFromWarmCache(this.sessionWarmCacheAccountKey, sessionId);
        this.clearSessionRuntimeState(sessionId);
        this.pruneSessionDeletionTombstones();
    };

    private applySessionDiff = (active: Session[], newActive: Session[]) => {
        let wasActive = new Set(active.map(s => s.id));
        let isActive = new Set(newActive.map(s => s.id));
        for (let s of active) {
            if (!isActive.has(s.id)) {
                voiceHooks.onSessionOffline(s.id, s.metadata ?? undefined);
            }
        }
        for (let s of newActive) {
            if (!wasActive.has(s.id)) {
                voiceHooks.onSessionOnline(s.id, s.metadata ?? undefined);
            }
        }
    }

}

// Global singleton instance
export const sync = new Sync();

//
// Init sequence
//

let isInitialized = false;
export async function syncCreate(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, false);
}

export async function syncRestore(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, true);
}

async function syncInit(credentials: AuthCredentials, restore: boolean) {

    // Initialize sync engine
    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    const encryption = await Encryption.create(secretKey);

    // Initialize tracking
    initializeTracking(encryption.anonID);

    // Initialize socket connection
    const API_ENDPOINT = getServerUrl();
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);

    // Wire socket status to storage
    apiSocket.onStatusChange((status) => {
        storage.getState().setSocketStatus(status);
    });

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}
