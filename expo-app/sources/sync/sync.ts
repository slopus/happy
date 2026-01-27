import Constants from 'expo-constants';
import { apiSocket } from '@/sync/apiSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { storage } from './storage';
import { ApiMessage } from './apiTypes';
import type { ApiEphemeralActivityUpdate } from './apiTypes';
import { Session, Machine, type Metadata } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { randomUUID } from '@/platform/randomUUID';
import * as Notifications from 'expo-notifications';
import { registerPushToken } from './apiPush';
import { Platform, AppState } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { NormalizedMessage, normalizeRawMessage, RawRecord } from './typesRaw';
import { applySettings, Settings, settingsDefaults, settingsParse, SUPPORTED_SCHEMA_VERSION } from './settings';
import { Profile } from './profile';
import { loadPendingSettings, savePendingSettings } from './persistence';
import { initializeTracking, tracking } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { RevenueCat, LogLevel, PaywallResult } from './revenueCat';
import { trackPaywallPresented, trackPaywallPurchased, trackPaywallCancelled, trackPaywallRestored, trackPaywallError } from '@/track';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { projectManager } from './projectManager';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { Message } from './typesMessage';
import { EncryptionCache } from './encryption/encryptionCache';
import { systemPrompt } from './prompt/systemPrompt';
import { nowServerMs } from './time';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/registryCore';
import { computePendingActivityAt } from './unread';
import { computeNextReadStateV1 } from './readStateV1';
import { updateSessionMetadataWithRetry as updateSessionMetadataWithRetryRpc, type UpdateMetadataAck } from './updateSessionMetadataWithRetry';
import type { DecryptedArtifact } from './artifactTypes';
import { getFriendsList, getUserProfile } from './apiFriends';
import { FeedItem } from './feedTypes';
import { UserProfile } from './friendTypes';
import { initializeTodoSync } from '../-zen/model/ops';
import { buildOutgoingMessageMeta } from './messageMeta';
import { HappyError } from '@/utils/errors';
import { dbgSettings, isSettingsSyncDebugEnabled, summarizeSettings, summarizeSettingsDelta } from './debugSettings';
import { deriveSettingsSecretsKey, decryptSecretValue, encryptSecretString, sealSecretsDeep } from './secretSettings';
import { deleteMessageQueueV1DiscardedItem, deleteMessageQueueV1Item, discardMessageQueueV1Item, enqueueMessageQueueV1Item, restoreMessageQueueV1DiscardedItem, updateMessageQueueV1Item } from './messageQueueV1';
import { decodeMessageQueueV1ToPendingMessages, reconcilePendingMessagesFromMetadata } from './messageQueueV1Pending';
import { didControlReturnToMobile } from './controlledByUserTransitions';
import { chooseSubmitMode } from './submitMode';
import type { SavedSecret } from './settings';
import { scheduleDebouncedPendingSettingsFlush } from './engine/pendingSettings';
import { syncSettings as syncSettingsEngine } from './engine/settings';
import {
    createArtifactViaApi,
    fetchAndApplyArtifactsList,
    fetchArtifactWithBodyFromApi,
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
    updateArtifactViaApi,
} from './engine/artifacts';
import { fetchAndApplyFeed, handleNewFeedPostUpdate, handleRelationshipUpdatedSocketUpdate, handleTodoKvBatchUpdate } from './engine/feed';
import { fetchAndApplyProfile, handleUpdateAccountSocketUpdate } from './engine/account';
import { buildMachineFromMachineActivityEphemeralUpdate, buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines } from './engine/machines';
import {
    buildUpdatedSessionFromSocketUpdate,
    fetchAndApplySessions,
    fetchAndApplyMessages,
    handleDeleteSessionSocketUpdate,
    handleNewMessageSocketUpdate,
    repairInvalidReadStateV1 as repairInvalidReadStateV1Engine,
} from './engine/sessions';
import { handleSocketReconnected, parseEphemeralUpdate, parseUpdateContainer } from './engine/socket';

class Sync {
    // Spawned agents (especially in spawn mode) can take noticeable time to connect.
    private static readonly SESSION_READY_TIMEOUT_MS = 10000;

    encryption!: Encryption;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private sessionReceivedMessages = new Map<string, Set<string>>();
    private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    private readStateV1RepairAttempted = new Set<string>();
    private readStateV1RepairInFlight = new Set<string>();
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private friendsSync: InvalidateSync;
    private friendRequestsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private todosSync: InvalidateSync;
    private activityAccumulator: ActivityUpdateAccumulator;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    private pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingSettingsDirty = false;
    revenueCatInitialized = false;
    private settingsSecretsKey: Uint8Array | null = null;

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;
    private machinesRefreshInFlight: Promise<void> | null = null;
    private lastMachinesRefreshAt = 0;

    constructor() {
        dbgSettings('Sync.constructor: loaded pendingSettings', {
            pendingKeys: Object.keys(this.pendingSettings).sort(),
        });
        const onSuccess = () => {
            storage.getState().clearSyncError();
            storage.getState().setLastSyncAt(Date.now());
        };
        const onError = (e: any) => {
            const message = e instanceof Error ? e.message : String(e);
            const retryable = !(e instanceof HappyError && e.canTryAgain === false);
            const kind: 'auth' | 'config' | 'network' | 'server' | 'unknown' =
                e instanceof HappyError && e.kind ? e.kind : 'unknown';
            storage.getState().setSyncError({ message, retryable, kind, at: Date.now() });
        };

        const onRetry = (info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number }) => {
            const ex = storage.getState().syncError;
            if (!ex) return;
            storage.getState().setSyncError({ ...ex, failuresCount: info.failuresCount, nextRetryAt: info.nextRetryAt });
        };

        this.sessionsSync = new InvalidateSync(this.fetchSessions, { onError, onSuccess, onRetry });
        this.settingsSync = new InvalidateSync(this.syncSettings, { onError, onSuccess, onRetry });
        this.profileSync = new InvalidateSync(this.fetchProfile, { onError, onSuccess, onRetry });
        this.purchasesSync = new InvalidateSync(this.syncPurchases, { onError, onSuccess, onRetry });
        this.machinesSync = new InvalidateSync(this.fetchMachines, { onError, onSuccess, onRetry });
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);
        this.friendsSync = new InvalidateSync(this.fetchFriends);
        this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests);
        this.feedSync = new InvalidateSync(this.fetchFeed);
        this.todosSync = new InvalidateSync(this.fetchTodos);

        const registerPushToken = async () => {
            if (__DEV__) {
                return;
            }
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);
        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        // Listen for app state changes to refresh purchases
        AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                log.log('📱 App became active');
                this.purchasesSync.invalidate();
                this.profileSync.invalidate();
                this.machinesSync.invalidate();
                this.pushTokenSync.invalidate();
                this.sessionsSync.invalidate();
                this.nativeUpdateSync.invalidate();
                log.log('📱 App became active: Invalidating artifacts sync');
                this.artifactsSync.invalidate();
                this.friendsSync.invalidate();
                this.friendRequestsSync.invalidate();
                this.feedSync.invalidate();
                this.todosSync.invalidate();
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
                // Reliability: ensure we persist any pending settings immediately when backgrounding.
                // This avoids losing last-second settings changes if the OS suspends the app.
                try {
                    if (this.pendingSettingsFlushTimer) {
                        clearTimeout(this.pendingSettingsFlushTimer);
                        this.pendingSettingsFlushTimer = null;
                    }
                    savePendingSettings(this.pendingSettings);
                } catch {
                    // ignore
                }
            }
        });
    }

    private schedulePendingSettingsFlush = () => {
        scheduleDebouncedPendingSettingsFlush({
            getTimer: () => this.pendingSettingsFlushTimer,
            setTimer: (timer) => {
                this.pendingSettingsFlushTimer = timer;
            },
            markDirty: () => {
                this.pendingSettingsDirty = true;
            },
            consumeDirty: () => {
                if (!this.pendingSettingsDirty) {
                    return false;
                }
                this.pendingSettingsDirty = false;
                return true;
            },
            flush: () => {
                // Persist pending settings for crash/restart safety.
                savePendingSettings(this.pendingSettings);
                // Trigger server sync (can be retried later).
                this.settingsSync.invalidate();
            },
            delayMs: 900,
        });
    };

    async create(credentials: AuthCredentials, encryption: Encryption) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        // Derive a stable per-account key for field-level secret settings.
        // This is separate from the outer settings blob encryption.
        try {
            const secretKey = decodeBase64(credentials.secret, 'base64url');
            if (secretKey.length === 32) {
                this.settingsSecretsKey = await deriveSettingsSecretsKey(secretKey);
            }
        } catch {
            this.settingsSecretsKey = null;
        }
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();

        // Await purchases sync to have fresh purchases
        await this.purchasesSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        try {
            const secretKey = decodeBase64(credentials.secret, 'base64url');
            if (secretKey.length === 32) {
                this.settingsSecretsKey = await deriveSettingsSecretsKey(secretKey);
            }
        } catch {
            this.settingsSecretsKey = null;
        }
        await this.#init();
    }

    /**
     * Encrypt a secret value into an encrypted-at-rest container.
     * Used for transient persistence (e.g. local drafts) where plaintext must never be stored.
     */
    public encryptSecretValue(value: string): import('./secretSettings').SecretString | null {
        const v = typeof value === 'string' ? value.trim() : '';
        if (!v) return null;
        if (!this.settingsSecretsKey) return null;
        return { _isSecretValue: true, encryptedValue: encryptSecretString(v, this.settingsSecretsKey) };
    }

    /**
     * Generic secret-string decryption helper for settings-like objects.
     * Prefer this over adding per-field helpers unless a field needs special handling.
     */
    public decryptSecretValue(input: import('./secretSettings').SecretString | null | undefined): string | null {
        return decryptSecretValue(input, this.settingsSecretsKey);
    }

    async #init() {

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
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.purchasesSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.artifactsSync.invalidate();
        this.feedSync.invalidate();
        this.todosSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts and todos');

        // Wait for both sessions and machines to load, then mark as ready
        Promise.all([
            this.sessionsSync.awaitQueue(),
            this.machinesSync.awaitQueue()
        ]).then(() => {
            storage.getState().applyReady();
        }).catch((error) => {
            console.error('Failed to load initial data:', error);
        });
    }


    onSessionVisible = (sessionId: string) => {
        let ex = this.messagesSync.get(sessionId);
        if (!ex) {
            ex = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, ex);
        }
        ex.invalidate();

        // Also invalidate git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();

        // Notify voice assistant about session visibility
        const session = storage.getState().sessions[sessionId];
        if (session) {
            voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
        }
    }


    async sendMessage(sessionId: string, text: string, displayText?: string) {
        storage.getState().markSessionOptimisticThinking(sessionId);

        // Get encryption
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) { // Should never happen
            storage.getState().clearSessionOptimisticThinking(sessionId);
            console.error(`Session ${sessionId} not found`);
            return;
        }

        // Get session data from storage
        const session = storage.getState().sessions[sessionId];
        if (!session) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            console.error(`Session ${sessionId} not found in storage`);
            return;
        }

        try {
            // Read permission mode from session state
            const permissionMode = session.permissionMode || 'default';
            
            // Read model mode - default is agent-specific (Gemini needs an explicit default)
            const flavor = session.metadata?.flavor;
            const agentId = resolveAgentIdFromFlavor(flavor);
            const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');

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

            const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;
            // Create user message content with metadata
            const content: RawRecord = {
                role: 'user',
                content: {
                    type: 'text',
                    text
                },
                meta: buildOutgoingMessageMeta({
                    sentFrom,
                    permissionMode: permissionMode || 'default',
                    model,
                    appendSystemPrompt: systemPrompt,
                    displayText,
                })
            };
            const encryptedRawRecord = await encryption.encryptRawRecord(content);

            // Add to messages - normalize the raw record
            const createdAt = nowServerMs();
            const normalizedMessage = normalizeRawMessage(localId, localId, createdAt, content);
            if (normalizedMessage) {
                this.applyMessages(sessionId, [normalizedMessage]);
            }

            const ready = await this.waitForAgentReady(sessionId);
            if (!ready) {
                log.log(`Session ${sessionId} not ready after timeout, sending anyway`);
            }

            // Send message with optional permission mode and source identifier
            apiSocket.send('message', {
                sid: sessionId,
                message: encryptedRawRecord,
                localId,
                sentFrom,
                permissionMode: permissionMode || 'default'
            });
        } catch (e) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
    }

    async abortSession(sessionId: string): Promise<void> {
        await apiSocket.sessionRPC(sessionId, 'abort', {
            reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
        });
    }

    async submitMessage(sessionId: string, text: string, displayText?: string): Promise<void> {
        const configuredMode = storage.getState().settings.sessionMessageSendMode;
        const session = storage.getState().sessions[sessionId] ?? null;
        const mode = chooseSubmitMode({ configuredMode, session });

        if (mode === 'interrupt') {
            try { await this.abortSession(sessionId); } catch { }
            await this.sendMessage(sessionId, text, displayText);
            return;
        }
        if (mode === 'server_pending') {
            await this.enqueuePendingMessage(sessionId, text, displayText);
            return;
        }
        await this.sendMessage(sessionId, text, displayText);
    }

    private async updateSessionMetadataWithRetry(sessionId: string, updater: (metadata: Metadata) => Metadata): Promise<void> {
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            throw new Error(`Session ${sessionId} not found`);
        }

        await updateSessionMetadataWithRetryRpc<Metadata>({
            sessionId,
            getSession: () => {
                const s = storage.getState().sessions[sessionId];
                if (!s?.metadata) return null;
                return { metadataVersion: s.metadataVersion, metadata: s.metadata };
            },
            refreshSessions: async () => {
                await this.refreshSessions();
            },
            encryptMetadata: async (metadata) => encryption.encryptMetadata(metadata),
            decryptMetadata: async (version, encrypted) => encryption.decryptMetadata(version, encrypted),
            emitUpdateMetadata: async (payload) => apiSocket.emitWithAck<UpdateMetadataAck>('update-metadata', payload),
            applySessionMetadata: ({ metadataVersion, metadata }) => {
                const currentSession = storage.getState().sessions[sessionId];
                if (!currentSession) return;
                this.applySessions([{
                    ...currentSession,
                    metadata,
                    metadataVersion,
                }]);
            },
            updater,
            maxAttempts: 8,
        });
    }

    private repairInvalidReadStateV1 = async (params: { sessionId: string; sessionSeqUpperBound: number }): Promise<void> => {
        await repairInvalidReadStateV1Engine({
            sessionId: params.sessionId,
            sessionSeqUpperBound: params.sessionSeqUpperBound,
            attempted: this.readStateV1RepairAttempted,
            inFlight: this.readStateV1RepairInFlight,
            getSession: (sessionId) => storage.getState().sessions[sessionId],
            updateSessionMetadataWithRetry: (sessionId, updater) => this.updateSessionMetadataWithRetry(sessionId, updater),
            now: nowServerMs,
        });
    }

    async markSessionViewed(sessionId: string, opts?: { sessionSeq?: number; pendingActivityAt?: number }): Promise<void> {
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata) return;

        const sessionSeq = opts?.sessionSeq ?? session.seq ?? 0;
        const pendingActivityAt = opts?.pendingActivityAt ?? computePendingActivityAt(session.metadata);
        const existing = session.metadata.readStateV1;
        const existingSeq = existing?.sessionSeq ?? 0;
        const needsRepair = existingSeq > sessionSeq;

        const early = computeNextReadStateV1({
            prev: existing,
            sessionSeq,
            pendingActivityAt,
            now: nowServerMs(),
        });
        if (!needsRepair && !early.didChange) return;

        await this.updateSessionMetadataWithRetry(sessionId, (metadata) => {
            const result = computeNextReadStateV1({
                prev: metadata.readStateV1,
                sessionSeq,
                pendingActivityAt,
                now: nowServerMs(),
            });
            if (!result.didChange) return metadata;
            return { ...metadata, readStateV1: result.next };
        });
    }

    async fetchPendingMessages(sessionId: string): Promise<void> {
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            storage.getState().applyPendingLoaded(sessionId);
            storage.getState().applyDiscardedPendingMessages(sessionId, []);
            return;
        }

        const session = storage.getState().sessions[sessionId];
        if (!session) {
            storage.getState().applyPendingLoaded(sessionId);
            storage.getState().applyDiscardedPendingMessages(sessionId, []);
            return;
        }

        const decoded = await decodeMessageQueueV1ToPendingMessages({
            messageQueueV1: session.metadata?.messageQueueV1,
            messageQueueV1Discarded: session.metadata?.messageQueueV1Discarded,
            decryptRaw: (encrypted) => encryption.decryptRaw(encrypted),
        });

        const existingPendingState = storage.getState().sessionPending[sessionId];
        const reconciled = reconcilePendingMessagesFromMetadata({
            messageQueueV1: session.metadata?.messageQueueV1,
            messageQueueV1Discarded: session.metadata?.messageQueueV1Discarded,
            decodedPending: decoded.pending,
            decodedDiscarded: decoded.discarded,
            existingPending: existingPendingState?.messages ?? [],
            existingDiscarded: existingPendingState?.discarded ?? [],
        });

        storage.getState().applyPendingMessages(sessionId, reconciled.pending);
        storage.getState().applyDiscardedPendingMessages(sessionId, reconciled.discarded);
    }

    async enqueuePendingMessage(sessionId: string, text: string, displayText?: string): Promise<void> {
        storage.getState().markSessionOptimisticThinking(sessionId);

        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw new Error(`Session ${sessionId} not found`);
        }

        const session = storage.getState().sessions[sessionId];
        if (!session) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw new Error(`Session ${sessionId} not found in storage`);
        }

        const permissionMode = session.permissionMode || 'default';
        const flavor = session.metadata?.flavor;
        const agentId = resolveAgentIdFromFlavor(flavor);
        const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');
        const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;

        const localId = randomUUID();

        let sentFrom: string;
        if (Platform.OS === 'web') {
            sentFrom = 'web';
        } else if (Platform.OS === 'android') {
            sentFrom = 'android';
        } else if (Platform.OS === 'ios') {
            sentFrom = isRunningOnMac() ? 'mac' : 'ios';
        } else {
            sentFrom = 'web';
        }

        const content: RawRecord = {
            role: 'user',
            content: {
                type: 'text',
                text
            },
            meta: buildOutgoingMessageMeta({
                sentFrom,
                permissionMode: permissionMode || 'default',
                model,
                appendSystemPrompt: systemPrompt,
                displayText,
            }),
        };

        const createdAt = nowServerMs();
        const updatedAt = createdAt;
        const encryptedRawRecord = await encryption.encryptRawRecord(content);

        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt,
            updatedAt,
            text,
            displayText,
            rawRecord: content,
        });

        try {
            await this.updateSessionMetadataWithRetry(sessionId, (metadata) => enqueueMessageQueueV1Item(metadata, {
                localId,
                message: encryptedRawRecord,
                createdAt,
                updatedAt,
            }));
        } catch (e) {
            storage.getState().removePendingMessage(sessionId, localId);
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
    }

    async updatePendingMessage(sessionId: string, pendingId: string, text: string): Promise<void> {
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const existing = storage.getState().sessionPending[sessionId]?.messages?.find((m) => m.id === pendingId);
        if (!existing) {
            throw new Error('Pending message not found');
        }

        const content: RawRecord = existing.rawRecord ? {
            ...(existing.rawRecord as any),
            content: {
                type: 'text',
                text
            },
        } : {
            role: 'user',
            content: { type: 'text', text },
            meta: {
                appendSystemPrompt: systemPrompt,
            }
        };

        const encryptedRawRecord = await encryption.encryptRawRecord(content);
        const updatedAt = nowServerMs();

        await this.updateSessionMetadataWithRetry(sessionId, (metadata) => updateMessageQueueV1Item(metadata, {
            localId: pendingId,
            message: encryptedRawRecord,
            createdAt: existing.createdAt,
            updatedAt,
        }));

        storage.getState().upsertPendingMessage(sessionId, {
            ...existing,
            text,
            updatedAt,
            rawRecord: content,
        });
    }

    async deletePendingMessage(sessionId: string, pendingId: string): Promise<void> {
        await this.updateSessionMetadataWithRetry(sessionId, (metadata) => deleteMessageQueueV1Item(metadata, pendingId));
        storage.getState().removePendingMessage(sessionId, pendingId);
    }

    async discardPendingMessage(
        sessionId: string,
        pendingId: string,
        opts?: { reason?: 'switch_to_local' | 'manual' }
    ): Promise<void> {
        const discardedAt = nowServerMs();
        await this.updateSessionMetadataWithRetry(sessionId, (metadata) => discardMessageQueueV1Item(metadata, {
            localId: pendingId,
            discardedAt,
            discardedReason: opts?.reason ?? 'manual',
        }));
        await this.fetchPendingMessages(sessionId);
    }

    async restoreDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        await this.updateSessionMetadataWithRetry(sessionId, (metadata) =>
            restoreMessageQueueV1DiscardedItem(metadata, { localId: pendingId, now: nowServerMs() })
        );
        await this.fetchPendingMessages(sessionId);
    }

    async deleteDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        await this.updateSessionMetadataWithRetry(sessionId, (metadata) => deleteMessageQueueV1DiscardedItem(metadata, pendingId));
        await this.fetchPendingMessages(sessionId);
    }

    applySettings = (delta: Partial<Settings>) => {
        // Seal secret settings fields before any persistence.
        delta = sealSecretsDeep(delta, this.settingsSecretsKey);
        // Avoid no-op writes. Settings writes cause:
        // - local persistence writes
        // - pending delta persistence
        // - a server POST (eventually)
        //
        // So we must not write when nothing actually changed.
        const currentSettings = storage.getState().settings;
        const deltaEntries = Object.entries(delta) as Array<[keyof Settings, unknown]>;
        const hasRealChange = deltaEntries.some(([key, next]) => {
            const prev = (currentSettings as any)[key];
            if (Object.is(prev, next)) return false;

            // Keep this O(1) and UI-friendly:
            // - For objects/arrays/records, rely on reference changes.
            // - Settings updates should always replace values immutably.
            const prevIsObj = prev !== null && typeof prev === 'object';
            const nextIsObj = next !== null && typeof next === 'object';
            if (prevIsObj || nextIsObj) {
                return prev !== next;
            }
            return true;
        });
        if (!hasRealChange) {
            dbgSettings('applySettings skipped (no-op delta)', {
                delta: summarizeSettingsDelta(delta),
                base: summarizeSettings(currentSettings, { version: storage.getState().settingsVersion }),
            });
            return;
        }

        if (isSettingsSyncDebugEnabled()) {
            const stack = (() => {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const s = (new Error('settings-sync trace') as any)?.stack;
                    return typeof s === 'string' ? s.split('\n').slice(0, 10).join('\n') : null;
                } catch {
                    return null;
                }
            })();
            const st = storage.getState();
            dbgSettings('applySettings called', {
                delta: summarizeSettingsDelta(delta),
                base: summarizeSettings(st.settings, { version: st.settingsVersion }),
                stack,
            });
        }
        storage.getState().applySettingsLocal(delta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...delta };
        dbgSettings('applySettings: pendingSettings updated', {
            pendingKeys: Object.keys(this.pendingSettings).sort(),
        });

        // Sync PostHog opt-out state if it was changed
        if (tracking && 'analyticsOptOut' in delta) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        this.schedulePendingSettingsFlush();
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

    presentPaywall = async (): Promise<{ success: boolean; purchased?: boolean; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                const error = 'RevenueCat not initialized';
                trackPaywallError(error);
                return { success: false, error };
            }

            // Track paywall presentation
            trackPaywallPresented();

            // Present the paywall
            const result = await RevenueCat.presentPaywall();

            // Handle the result
            switch (result) {
                case PaywallResult.PURCHASED:
                    trackPaywallPurchased();
                    // Refresh customer info after purchase
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.RESTORED:
                    trackPaywallRestored();
                    // Refresh customer info after restore
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.CANCELLED:
                    trackPaywallCancelled();
                    return { success: true, purchased: false };
                case PaywallResult.NOT_PRESENTED:
                    // Don't track error for NOT_PRESENTED as it's a platform limitation
                    return { success: false, error: 'Paywall not available on this platform' };
                case PaywallResult.ERROR:
                default:
                    const errorMsg = 'Failed to present paywall';
                    trackPaywallError(errorMsg);
                    return { success: false, error: errorMsg };
            }
        } catch (error: any) {
            const errorMessage = error.message || 'Failed to present paywall';
            trackPaywallError(errorMessage);
            return { success: false, error: errorMessage };
        }
    }

    async assumeUsers(userIds: string[]): Promise<void> {
        if (!this.credentials || userIds.length === 0) return;
        
        const state = storage.getState();
        // Filter out users we already have in cache (including null for 404s)
        const missingIds = userIds.filter(id => !(id in state.users));
        
        if (missingIds.length === 0) return;
        
        log.log(`👤 Fetching ${missingIds.length} missing users...`);
        
        // Fetch missing users in parallel
        const results = await Promise.all(
            missingIds.map(async (id) => {
                try {
                    const profile = await getUserProfile(this.credentials!, id);
                    return { id, profile };  // profile is null if 404
                } catch (error) {
                    console.error(`Failed to fetch user ${id}:`, error);
                    return { id, profile: null };  // Treat errors as 404
                }
            })
        );
        
        // Convert to Record<string, UserProfile | null>
        const usersMap: Record<string, UserProfile | null> = {};
        results.forEach(({ id, profile }) => {
            usersMap[id] = profile;
        });
        
        storage.getState().applyUsers(usersMap);
        log.log(`👤 Applied ${results.length} users to cache (${results.filter(r => r.profile).length} found, ${results.filter(r => !r.profile).length} not found)`);
    }

    //
    // Private
    //

    private fetchSessions = async () => {
        if (!this.credentials) return;
        await fetchAndApplySessions({
            credentials: this.credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            applySessions: (sessions) => this.applySessions(sessions),
            repairInvalidReadStateV1: (params) => this.repairInvalidReadStateV1(params),
            log,
        });
    }

    /**
     * Export the per-session data key for UI-assisted resume (dataKey mode only).
     * Returns null when the session uses legacy encryption or the key is unavailable.
     */
    public getSessionEncryptionKeyBase64ForResume(sessionId: string): string | null {
        const key = this.sessionDataKeys.get(sessionId);
        if (!key) return null;
        return encodeBase64(key, 'base64');
    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public retryNow = () => {
        try {
            storage.getState().clearSyncError();
            apiSocket.disconnect();
            apiSocket.connect();
        } catch {
            // ignore
        }
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.machinesSync.invalidate();
        this.purchasesSync.invalidate();
        this.artifactsSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.feedSync.invalidate();
        this.todosSync.invalidate();
    }

    public refreshMachinesThrottled = async (params?: { staleMs?: number; force?: boolean }) => {
        if (!this.credentials) return;
        const staleMs = params?.staleMs ?? 30_000;
        const force = params?.force ?? false;
        const now = Date.now();

        if (!force && (now - this.lastMachinesRefreshAt) < staleMs) {
            return;
        }

        if (this.machinesRefreshInFlight) {
            return this.machinesRefreshInFlight;
        }

        this.machinesRefreshInFlight = this.fetchMachines()
            .then(() => {
                this.lastMachinesRefreshAt = Date.now();
            })
            .finally(() => {
                this.machinesRefreshInFlight = null;
            });

        return this.machinesRefreshInFlight;
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        await fetchAndApplyArtifactsList({
            credentials: this.credentials,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            applyArtifacts: (artifacts) => storage.getState().applyArtifacts(artifacts),
        });
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;

        return await fetchArtifactWithBodyFromApi({
            credentials: this.credentials,
            artifactId,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
        });
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

        return await createArtifactViaApi({
            credentials: this.credentials,
            title,
            body,
            sessions,
            draft,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            addArtifact: (artifact) => storage.getState().addArtifact(artifact),
        });
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

        await updateArtifactViaApi({
            credentials: this.credentials,
            artifactId,
            title,
            body,
            sessions,
            draft,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            getArtifact: (id) => storage.getState().artifacts[id],
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
        });
    }

    private fetchMachines = async () => {
        if (!this.credentials) return;

        await fetchAndApplyMachines({
            credentials: this.credentials,
            encryption: this.encryption,
            machineDataKeys: this.machineDataKeys,
            applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace),
        });
    }

    private fetchFriends = async () => {
        if (!this.credentials) return;
        
        try {
            log.log('👥 Fetching friends list...');
            const friendsList = await getFriendsList(this.credentials);
            storage.getState().applyFriends(friendsList);
            log.log(`👥 fetchFriends completed - processed ${friendsList.length} friends`);
        } catch (error) {
            console.error('Failed to fetch friends:', error);
            // Silently handle error - UI will show appropriate state
        }
    }

    private fetchFriendRequests = async () => {
        // Friend requests are now included in the friends list with status='pending'
        // This method is kept for backward compatibility but does nothing
        log.log('👥 fetchFriendRequests called - now handled by fetchFriends');
    }

    private fetchTodos = async () => {
        if (!this.credentials) return;

        try {
            log.log('📝 Fetching todos...');
            await initializeTodoSync(this.credentials);
            log.log('📝 Todos loaded');
        } catch (error) {
            log.log('📝 Failed to fetch todos:');
        }
    }

    private applyTodoSocketUpdates = async (changes: any[]) => {
        if (!this.credentials || !this.encryption) return;

        const currentState = storage.getState();
        const todoState = currentState.todoState;
        if (!todoState) {
            // No todo state yet, just refetch
            this.todosSync.invalidate();
            return;
        }

        const { todos, undoneOrder, doneOrder, versions } = todoState;
        let updatedTodos = { ...todos };
        let updatedVersions = { ...versions };
        let indexUpdated = false;
        let newUndoneOrder = undoneOrder;
        let newDoneOrder = doneOrder;

        // Process each change
        for (const change of changes) {
            try {
                const key = change.key;
                const version = change.version;

                // Update version tracking
                updatedVersions[key] = version;

                if (change.value === null) {
                    // Item was deleted
                    if (key.startsWith('todo.') && key !== 'todo.index') {
                        const todoId = key.substring(5); // Remove 'todo.' prefix
                        delete updatedTodos[todoId];
                        newUndoneOrder = newUndoneOrder.filter(id => id !== todoId);
                        newDoneOrder = newDoneOrder.filter(id => id !== todoId);
                    }
                } else {
                    // Item was added or updated
                    const decrypted = await this.encryption.decryptRaw(change.value);

                    if (key === 'todo.index') {
                        // Update the index
                        const index = decrypted as any;
                        newUndoneOrder = index.undoneOrder || [];
                        newDoneOrder = index.completedOrder || []; // Map completedOrder to doneOrder
                        indexUpdated = true;
                    } else if (key.startsWith('todo.')) {
                        // Update a todo item
                        const todoId = key.substring(5);
                        if (todoId && todoId !== 'index') {
                            updatedTodos[todoId] = decrypted as any;
                        }
                    }
                }
            } catch (error) {
                console.error(`Failed to process todo change for key ${change.key}:`, error);
            }
        }

        // Apply the updated state
        storage.getState().applyTodos({
            todos: updatedTodos,
            undoneOrder: newUndoneOrder,
            doneOrder: newDoneOrder,
            versions: updatedVersions
        });

        log.log('📝 Applied todo socket updates successfully');
    }

    private fetchFeed = async () => {
        if (!this.credentials) return;
        await fetchAndApplyFeed({
            credentials: this.credentials,
            getFeedItems: () => storage.getState().feedItems,
            getFeedHead: () => storage.getState().feedHead,
            assumeUsers: (userIds) => this.assumeUsers(userIds),
            getUsers: () => storage.getState().users,
            applyFeedItems: (items) => storage.getState().applyFeedItems(items),
            log,
        });
    }

    private syncSettings = async () => {
        if (!this.credentials) return;
        await syncSettingsEngine({
            credentials: this.credentials,
            encryption: this.encryption,
            pendingSettings: this.pendingSettings,
            clearPendingSettings: () => {
                this.pendingSettings = {};
                savePendingSettings({});
            },
        });
    }

    private fetchProfile = async () => {
        if (!this.credentials) return;
        await fetchAndApplyProfile({
            credentials: this.credentials,
            applyProfile: (profile) => storage.getState().applyProfile(profile),
        });
    }

    private fetchNativeUpdate = async () => {
        try {
            // Skip in development
            if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !Constants.expoConfig?.version) {
                return;
            }
            if (Platform.OS === 'ios' && !Constants.expoConfig?.ios?.bundleIdentifier) {
                return;
            }
            if (Platform.OS === 'android' && !Constants.expoConfig?.android?.package) {
                return;
            }

            const serverUrl = getServerUrl();

            // Get platform and app identifiers
            const platform = Platform.OS;
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);

            const response = await fetch(`${serverUrl}/v1/version`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    platform,
                    version,
                    app_id: appId,
                }),
            });

            if (!response.ok) {
                log.log(`[fetchNativeUpdate] Request failed: ${response.status}`);
                return;
            }

            const data = await response.json();

            // Apply update status to storage
            if (data.update_required && data.update_url) {
                storage.getState().applyNativeUpdateStatus({
                    available: true,
                    updateUrl: data.update_url
                });
            } else {
                storage.getState().applyNativeUpdateStatus({
                    available: false
                });
            }
        } catch (error) {
            console.error('[fetchNativeUpdate] Error:', error);
            storage.getState().applyNativeUpdateStatus(null);
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

    private fetchMessages = async (sessionId: string) => {
        await fetchAndApplyMessages({
            sessionId,
            getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
            request: (path) => apiSocket.request(path),
            sessionReceivedMessages: this.sessionReceivedMessages,
            applyMessages: (sid, messages) => this.applyMessages(sid, messages),
            markMessagesLoaded: (sid) => storage.getState().applyMessagesLoaded(sid),
            log,
        });
    }

    private registerPushToken = async () => {
        log.log('registerPushToken');
        // Only register on mobile platforms
        if (Platform.OS === 'web') {
            return;
        }

        // Request permission
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        log.log('existingStatus: ' + JSON.stringify(existingStatus));

        if (existingStatus !== 'granted') {
            const { status } = await Notifications.requestPermissionsAsync();
            finalStatus = status;
        }
        log.log('finalStatus: ' + JSON.stringify(finalStatus));

        if (finalStatus !== 'granted') {
            log.log('Failed to get push token for push notification!');
            return;
        }

        // Get push token
        const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;

        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        log.log('tokenData: ' + JSON.stringify(tokenData));

        // Register with server
        try {
            await registerPushToken(this.credentials, tokenData.data);
            log.log('Push token registered successfully');
        } catch (error) {
            log.log('Failed to register push token: ' + JSON.stringify(error));
        }
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));

        // Subscribe to connection state changes
        apiSocket.onReconnected(() => {
            handleSocketReconnected({
                log,
                invalidateSessions: () => this.sessionsSync.invalidate(),
                invalidateMachines: () => this.machinesSync.invalidate(),
                invalidateArtifacts: () => this.artifactsSync.invalidate(),
                invalidateFriends: () => this.friendsSync.invalidate(),
                invalidateFriendRequests: () => this.friendRequestsSync.invalidate(),
                invalidateFeed: () => this.feedSync.invalidate(),
                getSessionsData: () => storage.getState().sessionsData,
                invalidateMessagesForSession: (sessionId) => this.messagesSync.get(sessionId)?.invalidate(),
                invalidateGitStatusForSession: (sessionId) => gitStatusSync.invalidate(sessionId),
            });
        });
    }

    private handleUpdate = async (update: unknown) => {
        const updateData = parseUpdateContainer(update);
        if (!updateData) return;

        if (updateData.body.t === 'new-message') {
            await handleNewMessageSocketUpdate({
                updateData,
                getSessionEncryption: (sessionId) => this.encryption.getSessionEncryption(sessionId),
                getSession: (sessionId) => storage.getState().sessions[sessionId],
                applySessions: (sessions) => this.applySessions(sessions),
                fetchSessions: () => this.fetchSessions(),
                applyMessages: (sessionId, messages) => this.applyMessages(sessionId, messages),
                isMutableToolCall: (sessionId, toolUseId) => storage.getState().isMutableToolCall(sessionId, toolUseId),
                invalidateGitStatus: (sessionId) => gitStatusSync.invalidate(sessionId),
                onSessionVisible: (sessionId) => this.onSessionVisible(sessionId),
            });

        } else if (updateData.body.t === 'new-session') {
            log.log('🆕 New session update received');
            this.sessionsSync.invalidate();
        } else if (updateData.body.t === 'delete-session') {
            log.log('🗑️ Delete session update received');
            handleDeleteSessionSocketUpdate({
                sessionId: updateData.body.sid,
                deleteSession: (sessionId) => storage.getState().deleteSession(sessionId),
                removeSessionEncryption: (sessionId) => this.encryption.removeSessionEncryption(sessionId),
                removeProjectManagerSession: (sessionId) => projectManager.removeSession(sessionId),
                clearGitStatusForSession: (sessionId) => gitStatusSync.clearForSession(sessionId),
                log,
            });
        } else if (updateData.body.t === 'update-session') {
            const session = storage.getState().sessions[updateData.body.id];
            if (session) {
                // Get session encryption
                const sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
                if (!sessionEncryption) {
                    console.error(`Session encryption not found for ${updateData.body.id} - this should never happen`);
                    return;
                }

                const { nextSession, agentState } = await buildUpdatedSessionFromSocketUpdate({
                    session,
                    updateBody: updateData.body,
                    updateSeq: updateData.seq,
                    updateCreatedAt: updateData.createdAt,
                    sessionEncryption,
                });

                this.applySessions([nextSession]);

                // Invalidate git status when agent state changes (files may have been modified)
                if (updateData.body.agentState) {
                    gitStatusSync.invalidate(updateData.body.id);

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
                    if (didControlReturnToMobile(wasControlledByUser, isNowControlledByUser)) {
                        log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                        this.onSessionVisible(updateData.body.id);
                    }
                }
            }
        } else if (updateData.body.t === 'update-account') {
            const accountUpdate = updateData.body;
            const currentProfile = storage.getState().profile;

            await handleUpdateAccountSocketUpdate({
                accountUpdate,
                updateCreatedAt: updateData.createdAt,
                currentProfile,
                encryption: this.encryption,
                applyProfile: (profile) => storage.getState().applyProfile(profile),
                applySettings: (settings, version) => storage.getState().applySettings(settings, version),
                log,
            });
        } else if (updateData.body.t === 'update-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;  // Changed from .id to .machineId
            const machine = storage.getState().machines[machineId];

            const updatedMachine = await buildUpdatedMachineFromSocketUpdate({
                machineUpdate,
                updateSeq: updateData.seq,
                updateCreatedAt: updateData.createdAt,
                existingMachine: machine,
                getMachineEncryption: (id) => this.encryption.getMachineEncryption(id),
            });
            if (!updatedMachine) return;

            // Update storage using applyMachines which rebuilds sessionListViewData
            storage.getState().applyMachines([updatedMachine]);
        } else if (updateData.body.t === 'relationship-updated') {
            log.log('👥 Received relationship-updated update');
            const relationshipUpdate = updateData.body;

            handleRelationshipUpdatedSocketUpdate({
                relationshipUpdate,
                applyRelationshipUpdate: (update) => storage.getState().applyRelationshipUpdate(update),
                invalidateFriends: () => this.friendsSync.invalidate(),
                invalidateFriendRequests: () => this.friendRequestsSync.invalidate(),
                invalidateFeed: () => this.feedSync.invalidate(),
            });
        } else if (updateData.body.t === 'new-artifact') {
            log.log('📦 Received new-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;

            await handleNewArtifactSocketUpdate({
                artifactId,
                dataEncryptionKey: artifactUpdate.dataEncryptionKey,
                header: artifactUpdate.header,
                headerVersion: artifactUpdate.headerVersion,
                body: artifactUpdate.body,
                bodyVersion: artifactUpdate.bodyVersion,
                seq: artifactUpdate.seq,
                createdAt: artifactUpdate.createdAt,
                updatedAt: artifactUpdate.updatedAt,
                encryption: this.encryption,
                artifactDataKeys: this.artifactDataKeys,
                addArtifact: (artifact) => storage.getState().addArtifact(artifact),
                log,
            });
        } else if (updateData.body.t === 'update-artifact') {
            log.log('📦 Received update-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;

            await handleUpdateArtifactSocketUpdate({
                artifactId,
                seq: updateData.seq,
                createdAt: updateData.createdAt,
                header: artifactUpdate.header,
                body: artifactUpdate.body,
                artifactDataKeys: this.artifactDataKeys,
                getExistingArtifact: (id) => storage.getState().artifacts[id],
                updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
                invalidateArtifactsSync: () => this.artifactsSync.invalidate(),
                log,
            });
        } else if (updateData.body.t === 'delete-artifact') {
            log.log('📦 Received delete-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;

            handleDeleteArtifactSocketUpdate({
                artifactId,
                deleteArtifact: (id) => storage.getState().deleteArtifact(id),
                artifactDataKeys: this.artifactDataKeys,
            });
        } else if (updateData.body.t === 'new-feed-post') {
            log.log('📰 Received new-feed-post update');
            const feedUpdate = updateData.body;

            await handleNewFeedPostUpdate({
                feedUpdate,
                assumeUsers: (userIds) => this.assumeUsers(userIds),
                getUsers: () => storage.getState().users,
                applyFeedItems: (items) => storage.getState().applyFeedItems(items),
                log,
            });
        } else if (updateData.body.t === 'kv-batch-update') {
            log.log('📝 Received kv-batch-update');
            const kvUpdate = updateData.body;

            await handleTodoKvBatchUpdate({
                kvUpdate,
                applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
                invalidateTodosSync: () => this.todosSync.invalidate(),
                log,
            });
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
            this.applySessions(sessions);
            // log.log(`🔄 Activity updates flushed - updated ${sessions.length} sessions`);
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        const updateData = parseEphemeralUpdate(update);
        if (!updateData) return;

        // Process activity updates through smart debounce accumulator
        if (updateData.type === 'activity') {
            this.activityAccumulator.addUpdate(updateData);
        }

        // Handle machine activity updates
        if (updateData.type === 'machine-activity') {
            // Update machine's active status and lastActiveAt
            const machine = storage.getState().machines[updateData.id];
            if (machine) {
                const updatedMachine: Machine = buildMachineFromMachineActivityEphemeralUpdate({ machine, updateData });
                storage.getState().applyMachines([updatedMachine]);
            }
        }

        // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    }

    //
    // Apply store
    //

    private applyMessages = (sessionId: string, messages: NormalizedMessage[]) => {
        const result = storage.getState().applyMessages(sessionId, messages);
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
    }

    private applySessions = (sessions: (Omit<Session, "presence"> & {
        presence?: "online" | number;
    })[]) => {
        const active = storage.getState().getActiveSessions();
        storage.getState().applySessions(sessions);
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);
    }

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

    /**
     * Waits for the CLI agent to be ready by watching agentStateVersion.
     *
     * When a session is created, agentStateVersion starts at 0. Once the CLI
     * connects and sends its first state update (via updateAgentState()), the
     * version becomes > 0. This serves as a reliable signal that the CLI's
     * WebSocket is connected and ready to receive messages.
     */
    private waitForAgentReady(sessionId: string, timeoutMs: number = Sync.SESSION_READY_TIMEOUT_MS): Promise<boolean> {
        const startedAt = Date.now();

        return new Promise((resolve) => {
            const done = (ready: boolean, reason: string) => {
                clearTimeout(timeout);
                unsubscribe();
                const duration = Date.now() - startedAt;
                log.log(`Session ${sessionId} ${reason} after ${duration}ms`);
                resolve(ready);
            };

            const check = () => {
                const s = storage.getState().sessions[sessionId];
                if (s && s.agentStateVersion > 0) {
                    done(true, `ready (agentStateVersion=${s.agentStateVersion})`);
                }
            };

            const timeout = setTimeout(() => done(false, 'ready wait timed out'), timeoutMs);
            const unsubscribe = storage.subscribe(check);
            check(); // Check current state immediately
        });
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
    apiSocket.onError((error) => {
        if (!error) {
            storage.getState().setSocketError(null);
            return;
        }
        const msg = error.message || 'Connection error';
        storage.getState().setSocketError(msg);

        // Prefer explicit status if provided by the socket error (depends on server implementation).
        const status = (error as any)?.data?.status;
        const statusNum = typeof status === 'number' ? status : null;
        const kind: 'auth' | 'config' | 'network' | 'server' | 'unknown' =
            statusNum === 401 || statusNum === 403 ? 'auth' : 'unknown';
        const retryable = kind !== 'auth';

        storage.getState().setSyncError({ message: msg, retryable, kind, at: Date.now() });
    });

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}
