import Constants from 'expo-constants';
import { apiSocket } from '@/sync/apiSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { storage } from './storage';
import { ApiEphemeralUpdateSchema, ApiMessage, ApiUpdateContainerSchema } from './apiTypes';
import type { ApiEphemeralActivityUpdate, ApiUpdateContainer } from './apiTypes';
import { Session, Machine } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { randomUUID, getRandomBytes } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { registerPushToken } from './apiPush';
import { Platform, AppState } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { NormalizedMessage, normalizeRawMessage, RawRecord, ImageContent } from './typesRaw';
import { uploadChatImage } from './uploadChatImage';
import { LocalImage } from '@/components/ImagePreview';
import { applySettings, Settings, settingsDefaults, settingsParse, SUPPORTED_SCHEMA_VERSION } from './settings';
import { Profile, profileParse } from './profile';
import { loadPendingSettings, savePendingSettings, loadSessionLastViewedAt, saveSessionLastViewedAt } from './persistence';
import { initializeTracking, tracking } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { getServerUrl } from './serverConfig';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { projectManager } from './projectManager';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { Message } from './typesMessage';
import { EncryptionCache } from './encryption/encryptionCache';
import { systemPrompt, buildDootaskSystemPrompt } from './prompt/systemPrompt';
import { fetchArtifact, fetchArtifacts, createArtifact, updateArtifact } from './apiArtifacts';
import { DecryptedArtifact, Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from './artifactTypes';
import { ArtifactEncryption } from './encryption/artifactEncryption';
import { getFriendsList, getUserProfile } from './apiFriends';
import { fetchFeed } from './apiFeed';
import { FeedItem } from './feedTypes';
import { UserProfile } from './friendTypes';
import {
    createOpenClawMachine,
    updateOpenClawMachine,
    deleteOpenClawMachine,
    processNewOpenClawMachineEvent,
    processUpdateOpenClawMachineEvent,
} from '../openclaw/storage';
import { resolveModelSelectionForFlavor } from '@/constants/modelCatalog';
import { sessionUpdateMetadataFields } from './ops';

type PermissionMode = NonNullable<Session['permissionMode']>;

/**
 * Tracks when the user last viewed each session (in-memory only).
 * Used by useSessionStatus to decide if taskCompleted should show a blue dot:
 * blue dot shows only when taskCompleted > lastViewedAt.
 */
export const sessionLastViewedAt = loadSessionLastViewedAt();

function markSessionViewed(sessionId: string) {
    const session = storage.getState().sessions[sessionId];
    // Use max(now, taskCompleted) to handle clock skew between CLI and app
    const taskCompleted = session?.agentState?.taskCompleted ?? 0;
    const now = Math.max(Date.now(), taskCompleted);

    // Instant local update (no network latency)
    sessionLastViewedAt.set(sessionId, now);
    saveSessionLastViewedAt(sessionLastViewedAt);

    // Sync to other devices via metadata (throttled to avoid feedback loops)
    if (session?.metadata) {
        const existing = session.metadata.completionDismissedAt ?? 0;
        if (now - existing > 5000) {
            sessionUpdateMetadataFields(
                sessionId,
                session.metadata,
                { completionDismissedAt: now },
                session.metadataVersion
            ).catch(() => {
                // Silently ignore - local state already updated, will retry on next view
            });
        }
    }
}

class Sync {
    // Spawned agents (especially in spawn mode) can take noticeable time to connect.
    private static readonly SESSION_READY_TIMEOUT_MS = 10000;
    // Per-session pacing for websocket new-message updates to avoid autoscroll race.
    private static readonly NEW_MESSAGE_PROCESS_INTERVAL_MS = 800;
    // First load for a session should stay bounded; older history is loaded on demand.
    private static readonly INITIAL_MESSAGES_LIMIT = 100;

    encryption!: Encryption;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private sessionReceivedMessages = new Map<string, Set<string>>();
    private messageSyncTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
    private sessionMessageUpdateQueues = new Map<string, ApiUpdateContainer[]>();
    private sessionMessageQueueRunning = new Set<string>();
    private sessionMessageQueueTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private sessionLastMessageProcessedAt = new Map<string, number>();
    private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
    /** Per-session last-known seq for v3 incremental fetch */
    private sessionLastSeq = new Map<string, number>();
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private friendsSync: InvalidateSync;
    private friendRequestsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private openClawMachinesSync: InvalidateSync;
    private openClawMachineDataKeys = new Map<string, Uint8Array>(); // Store OpenClaw machine data encryption keys
    private activityAccumulator: ActivityUpdateAccumulator;
    private pendingSettings: Partial<Settings> = loadPendingSettings();

    // Track which session the user is currently viewing
    private viewingSessionId: string | null = null;

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;

    constructor() {
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);
        this.friendsSync = new InvalidateSync(this.fetchFriends);
        this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests);
        this.feedSync = new InvalidateSync(this.fetchFeed);
        this.openClawMachinesSync = new InvalidateSync(this.fetchOpenClawMachines);

        const registerPushToken = async () => {
            if (__DEV__) {
                return;
            }
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);
        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        // Refresh data when app becomes active
        AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                log.log('📱 App became active');
                // Refresh lastViewedAt so blue dot won't flash for the session user is viewing
                if (this.viewingSessionId) {
                    markSessionViewed(this.viewingSessionId);
                }
                this.profileSync.invalidate();
                this.machinesSync.invalidate();
                this.openClawMachinesSync.invalidate();
                this.pushTokenSync.invalidate();
                this.sessionsSync.invalidate();
                this.nativeUpdateSync.invalidate();
                log.log('📱 App became active: Invalidating artifacts sync');
                this.artifactsSync.invalidate();
                this.friendsSync.invalidate();
                this.friendRequestsSync.invalidate();
                this.feedSync.invalidate();
                gitStatusSync.invalidateForSessions(Object.keys(storage.getState().sessions));
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
            }
        });
    }

    async create(credentials: AuthCredentials, encryption: Encryption) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();
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
        this.machinesSync.invalidate();
        this.openClawMachinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.artifactsSync.invalidate();
        this.feedSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts');

        // Wait for both sessions and machines to load, then mark as ready
        Promise.all([
            this.sessionsSync.awaitQueue(),
            this.machinesSync.awaitQueue()
        ]).then(() => {
            gitStatusSync.invalidateForSessions(Object.keys(storage.getState().sessions));
            storage.getState().applyReady();
        }).catch((error) => {
            console.error('Failed to load initial data:', error);
        });
    }


    onSessionVisible = (sessionId: string, userInitiated: boolean = false) => {
        // When user navigates into a session, clear the cursor so
        // fetchMessagesV3 runs a fresh bootstrap (latest 100 messages)
        // instead of incrementally catching up from a potentially stale cursor.
        if (userInitiated) {
            this.sessionLastSeq.delete(sessionId);
        }

        let ex = this.messagesSync.get(sessionId);
        if (!ex) {
            ex = new InvalidateSync(() => this.fetchMessagesV3(sessionId));
            this.messagesSync.set(sessionId, ex);
        }
        ex.invalidate();

        // Also invalidate git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();

        // Track which session user is viewing
        if (userInitiated) {
            this.viewingSessionId = sessionId;
        }

        // Notify voice assistant about session visibility (only for user-initiated navigation)
        const session = storage.getState().sessions[sessionId];
        if (session) {
            if (userInitiated) {
                voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
            }
        }

        // Record view time for blue dot (taskCompleted) comparison
        if (userInitiated) {
            markSessionViewed(sessionId);
            // Trigger re-render so blue dot disappears on tablet sidebar
            const s = storage.getState().sessions[sessionId];
            if (s) {
                this.applySessions([{ ...s }]);
            }
        }
    }

    onSessionHidden = () => {
        this.viewingSessionId = null;
        voiceHooks.onSessionBlur();
    }

    private invalidateMessagesSync = (sessionId: string) => {
        let ex = this.messagesSync.get(sessionId);
        if (!ex) {
            ex = new InvalidateSync(() => this.fetchMessagesV3(sessionId));
            this.messagesSync.set(sessionId, ex);
        }
        ex.invalidate();
    }


    private buildSystemPrompt(sessionId: string): string {
        const session = storage.getState().sessions[sessionId];
        const ctx = session?.metadata?.externalContext;
        if (ctx?.source === 'dootask' && ctx.resourceId) {
            return systemPrompt + '\n\n' + buildDootaskSystemPrompt(ctx.resourceId);
        }
        return systemPrompt;
    }

    async sendMessage(sessionId: string, text: string, displayText?: string, images?: LocalImage[], existingLocalId?: string): Promise<{ success: boolean; error?: string; localId: string }> {

        // Get encryption
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) { // Should never happen
            console.error(`Session ${sessionId} not found`);
            return { success: false, error: 'Session encryption not found', localId: '' };
        }

        // Get session data from storage
        const session = storage.getState().sessions[sessionId];
        if (!session) {
            console.error(`Session ${sessionId} not found in storage`);
            return { success: false, error: 'Session not found', localId: '' };
        }

        // Read permission mode from session state
        const permissionMode = session.permissionMode || 'default';

        // Read model mode - default maps to CLI-configured model
        const flavor = session.metadata?.flavor;
        const modelMode = session.modelMode || 'default';

        // Use existing localId for retry, or generate new one
        const localId = existingLocalId || randomUUID();
        const sendStartedAt = Date.now();
        log.log(`[SEND_DEBUG][SYNC] start sid=${sessionId} localId=${localId} textLen=${text.length} images=${images?.length || 0} existingLocalId=${existingLocalId ? 'yes' : 'no'}`);

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

        // Model settings - pass explicit model overrides when selected, otherwise defer to CLI profile/default.
        const { model, reasoningEffort } = resolveModelSelectionForFlavor(flavor, modelMode);
        const fallbackModel: string | null = null;

        // Upload images if present
        let messageContent: { type: 'text'; text: string } | { type: 'mixed'; text: string; images: ImageContent[] };

        if (images && images.length > 0) {
            const uploadedImages: ImageContent[] = [];
            const apiUrl = getServerUrl();
            const token = this.credentials.token;

            for (const img of images) {
                const uploaded = await uploadChatImage(sessionId, img, token, apiUrl);
                uploadedImages.push(uploaded);
            }

            messageContent = {
                type: 'mixed',
                text,
                images: uploadedImages,
            };
        } else {
            messageContent = {
                type: 'text',
                text,
            };
        }

        // Create user message content with metadata
        const content: RawRecord = {
            role: 'user',
            content: messageContent,
            meta: {
                sentFrom,
                permissionMode: permissionMode || 'default',
                model,
                reasoningEffort,
                fallbackModel,
                appendSystemPrompt: this.buildSystemPrompt(sessionId),
                ...(displayText && { displayText }) // Add displayText if provided
            }
        };
        const encryptedRawRecord = await encryption.encryptRawRecord(content);

        // Prepare normalized message for later use
        const createdAt = Date.now();
        const normalizedMessage = normalizeRawMessage(localId, localId, createdAt, content);

        const ready = await this.waitForAgentReady(sessionId);
        if (!ready) {
            log.log(`Session ${sessionId} not ready after timeout, sending anyway`);
        }

        // Send via v3 HTTP API
        try {
            const API_ENDPOINT = getServerUrl();
            const response = await fetch(
                `${API_ENDPOINT}/v3/sessions/${sessionId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        messages: [{
                            content: encryptedRawRecord,
                            localId
                        }]
                    })
                }
            );

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                log.log(`[SEND_DEBUG][SYNC] fail sid=${sessionId} localId=${localId} via=v3-http status=${response.status} error=${errorText}`);
                return { success: false, error: `Send failed: ${response.status}`, localId };
            }

            // Apply optimistic message to local storage
            if (normalizedMessage) {
                this.applyMessages(sessionId, [normalizedMessage]);
            }

            // Update seq tracking from response (advisory — don't fail if JSON is malformed)
            try {
                const responseData = await response.json();
                if (responseData.messages?.length > 0) {
                    const maxSeq = Math.max(...responseData.messages.map((m: any) => m.seq));
                    const currentSeq = this.sessionLastSeq.get(sessionId) ?? 0;
                    if (maxSeq > currentSeq) {
                        this.sessionLastSeq.set(sessionId, maxSeq);
                    }
                }
            } catch {
                // Seq tracking is best-effort; v3 re-fetch will resync if needed
            }

            log.log(`[SEND_DEBUG][SYNC] success sid=${sessionId} localId=${localId} via=v3-http elapsedMs=${Date.now() - sendStartedAt}`);
            return { success: true, localId };
        } catch (error) {
            log.log(`[SEND_DEBUG][SYNC] fail sid=${sessionId} localId=${localId} via=v3-exception error=${error instanceof Error ? error.message : 'Unknown error'}`);
            return { success: false, error: error instanceof Error ? error.message : 'Unknown error', localId };
        }
    }

    async changePermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> {
        try {
            await apiSocket.sessionRPC<boolean, { mode: PermissionMode }>(
                sessionId,
                'permission-mode-changed',
                { mode }
            );
            return true;
        } catch (error) {
            log.log(`Failed to change permission mode for ${sessionId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    applySettings = (delta: Partial<Settings>) => {
        storage.getState().applySettingsLocal(delta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...delta };
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

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
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

        const API_ENDPOINT = getServerUrl();
        const response = await fetch(`${API_ENDPOINT}/v1/sessions`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch sessions: ${response.status}`);
        }

        const data = await response.json();
        const sessions = data.sessions as Array<{
            id: string;
            tag: string;
            seq: number;
            metadata: string;
            metadataVersion: number;
            agentState: string | null;
            agentStateVersion: number;
            dataEncryptionKey: string | null;
            active: boolean;
            activeAt: number;
            createdAt: number;
            updatedAt: number;
            lastMessage: ApiMessage | null;
        }>;

        // Initialize all session encryptions first
        const sessionKeys = new Map<string, Uint8Array | null>();
        for (const session of sessions) {
            if (session.dataEncryptionKey) {
                let decrypted = await this.encryption.decryptEncryptionKey(session.dataEncryptionKey);
                if (!decrypted) {
                    console.error(`Failed to decrypt data encryption key for session ${session.id}`);
                    continue;
                }
                sessionKeys.set(session.id, decrypted);
            } else {
                sessionKeys.set(session.id, null);
            }
        }
        await this.encryption.initializeSessions(sessionKeys);

        // Decrypt sessions
        let decryptedSessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[] = [];
        for (const session of sessions) {
            // Get session encryption (should always exist after initialization)
            const sessionEncryption = this.encryption.getSessionEncryption(session.id);
            if (!sessionEncryption) {
                console.error(`Session encryption not found for ${session.id} - this should never happen`);
                continue;
            }

            // Decrypt metadata using session-specific encryption
            let metadata = await sessionEncryption.decryptMetadata(session.metadataVersion, session.metadata);

            // Decrypt agent state using session-specific encryption
            let agentState = await sessionEncryption.decryptAgentState(session.agentStateVersion, session.agentState);

            const existingSession = storage.getState().sessions[session.id];

            // Put it all together.
            // Keep local thinking state during refresh to avoid online<->thinking flicker.
            const processedSession = {
                ...session,
                thinking: existingSession?.thinking ?? false,
                thinkingAt: existingSession?.thinkingAt ?? 0,
                metadata,
                agentState
            };
            decryptedSessions.push(processedSession);
        }

        // Apply to storage
        this.applySessions(decryptedSessions);
        log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} sessions`);

    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    public getCredentials() {
        return this.credentials;
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
                'Content-Type': 'application/json'
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

        // First, collect and decrypt encryption keys for all machines
        const machineKeysMap = new Map<string, Uint8Array | null>();
        for (const machine of machines) {
            if (machine.dataEncryptionKey) {
                const decryptedKey = await this.encryption.decryptEncryptionKey(machine.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error(`Failed to decrypt data encryption key for machine ${machine.id}`);
                    continue;
                }
                machineKeysMap.set(machine.id, decryptedKey);
                this.machineDataKeys.set(machine.id, decryptedKey);
            } else {
                machineKeysMap.set(machine.id, null);
            }
        }

        // Initialize machine encryptions
        await this.encryption.initializeMachines(machineKeysMap);

        // Process all machines first, then update state once
        const decryptedMachines: Machine[] = [];

        for (const machine of machines) {
            // Get machine-specific encryption (might exist from previous initialization)
            const machineEncryption = this.encryption.getMachineEncryption(machine.id);
            if (!machineEncryption) {
                console.error(`Machine encryption not found for ${machine.id} - this should never happen`);
                continue;
            }

            try {

                // Use machine-specific encryption (which handles fallback internally)
                const metadata = machine.metadata
                    ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                    : null;

                const daemonState = machine.daemonState
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
                // Still add the machine with null metadata
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

        // Replace entire machine state with fetched machines
        storage.getState().applyMachines(decryptedMachines, true);
        log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
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

    private fetchOpenClawMachines = async () => {
        if (!this.credentials) return;

        console.log('🤖 Sync: Fetching OpenClaw machines...');
        const API_ENDPOINT = getServerUrl();
        const response = await fetch(`${API_ENDPOINT}/v1/openclaw/machines`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.error(`Failed to fetch OpenClaw machines: ${response.status}`);
            return;
        }

        const rawMachines = await response.json() as Array<{
            id: string;
            type: string;
            happyMachineId: string | null;
            directConfig: string | null;
            metadata: string;
            metadataVersion: number;
            pairingData: string | null;
            dataEncryptionKey: string | null;
            seq: number;
            createdAt: number;
            updatedAt: number;
        }>;
        console.log(`🤖 Sync: Fetched ${rawMachines.length} OpenClaw machines from server`);

        // Decrypt and process machines
        const decryptedMachines: Array<{
            id: string;
            type: 'happy' | 'direct';
            happyMachineId: string | null;
            gatewayToken: string | null;
            directConfig: any | null;
            metadata: any | null;
            metadataVersion: number;
            pairingData: any | null;
            seq: number;
            createdAt: number;
            updatedAt: number;
        }> = [];

        for (const raw of rawMachines) {
            try {
                // Decrypt the data encryption key if present
                let dataKey: Uint8Array | null = null;
                if (raw.dataEncryptionKey) {
                    dataKey = await this.encryption.decryptEncryptionKey(raw.dataEncryptionKey);
                    if (dataKey) {
                        this.openClawMachineDataKeys.set(raw.id, dataKey);
                    }
                }

                if (!dataKey) {
                    console.error(`No data encryption key for OpenClaw machine ${raw.id}`);
                    continue;
                }

                // Create encryptor for decrypting fields
                const encryptor = await this.encryption.openEncryption(dataKey);

                // Decrypt fields
                let metadata: any | null = null;
                if (raw.metadata) {
                    const decoded = decodeBase64(raw.metadata);
                    const results = await encryptor.decrypt([decoded]);
                    metadata = results[0];
                }

                let directConfig: any | null = null;
                if (raw.directConfig) {
                    const decoded = decodeBase64(raw.directConfig);
                    const results = await encryptor.decrypt([decoded]);
                    directConfig = results[0];
                }

                let pairingData: any | null = null;
                if (raw.pairingData) {
                    const decoded = decodeBase64(raw.pairingData);
                    const results = await encryptor.decrypt([decoded]);
                    pairingData = results[0];
                }

                decryptedMachines.push({
                    id: raw.id,
                    type: raw.type as 'happy' | 'direct',
                    happyMachineId: raw.happyMachineId,
                    gatewayToken: null, // Stored locally only, not synced
                    directConfig,
                    metadata,
                    metadataVersion: raw.metadataVersion,
                    pairingData,
                    seq: raw.seq,
                    createdAt: raw.createdAt,
                    updatedAt: raw.updatedAt,
                });
            } catch (error) {
                console.error(`Failed to decrypt OpenClaw machine ${raw.id}:`, error);
            }
        }

        storage.getState().applyOpenClawMachines(decryptedMachines, true);
        log.log(`🤖 fetchOpenClawMachines completed - processed ${decryptedMachines.length} machines`);
    }

    /**
     * Create a new OpenClaw machine
     */
    public async createOpenClawMachine(params: {
        type: 'happy' | 'direct';
        happyMachineId?: string;
        directConfig?: { url: string; token?: string };
        metadata: { name: string; gatewayToken?: string };
        pairingData?: { deviceId: string; publicKey: string; privateKey: string };
    }): Promise<string> {
        if (!this.credentials || !this.encryption) {
            throw new Error('Not authenticated');
        }

        const encryptionAdapter = {
            decryptWithKey: async (encryptedData: string, key: Uint8Array): Promise<unknown> => {
                const encryptor = await this.encryption.openEncryption(key);
                const decoded = decodeBase64(encryptedData);
                const results = await encryptor.decrypt([decoded]);
                return results[0];
            },
            encryptWithKey: async (data: unknown, key: Uint8Array): Promise<string> => {
                const encryptor = await this.encryption.openEncryption(key);
                const results = await encryptor.encrypt([data]);
                return encodeBase64(results[0]);
            },
            decryptEncryptionKey: async (encryptedKey: string): Promise<Uint8Array | null> => {
                return this.encryption.decryptEncryptionKey(encryptedKey);
            },
            generateDataKey: async () => {
                // Generate 256-bit key for AES-256
                const key = getRandomBytes(32);
                const encryptedKey = await this.encryption.encryptEncryptionKey(key);
                return { key, encryptedKey: encodeBase64(encryptedKey, 'base64') };
            },
        };

        const machine = await createOpenClawMachine(
            this.credentials,
            encryptionAdapter,
            {
                type: params.type,
                happyMachineId: params.happyMachineId,
                directConfig: params.directConfig,
                metadata: params.metadata,
                pairingData: params.pairingData,
            }
        );

        if (machine) {
            storage.getState().applyOpenClawMachines([machine]);
            log.log(`🤖 Created OpenClaw machine ${machine.id}`);
            return machine.id;
        }

        throw new Error('Failed to create OpenClaw machine');
    }

    /**
     * Update a OpenClaw machine's metadata and/or direct config
     */
    public async updateOpenClawMachine(
        machineId: string,
        updates: {
            name?: string;
            gatewayToken?: string;
            directConfig?: { url: string; password?: string };
        }
    ): Promise<void> {
        if (!this.credentials || !this.encryption) {
            throw new Error('Not authenticated');
        }

        // Get current machine from storage
        const currentMachine = storage.getState().openClawMachines[machineId];
        if (!currentMachine) {
            throw new Error('Machine not found');
        }

        // Get data encryption key
        const dataKey = this.openClawMachineDataKeys.get(machineId);
        if (!dataKey) {
            throw new Error('Encryption key not found for machine');
        }

        const encryptionAdapter = {
            decryptWithKey: async (encryptedData: string, key: Uint8Array): Promise<unknown> => {
                const encryptor = await this.encryption.openEncryption(key);
                const decoded = decodeBase64(encryptedData);
                const results = await encryptor.decrypt([decoded]);
                return results[0];
            },
            encryptWithKey: async (data: unknown, key: Uint8Array): Promise<string> => {
                const encryptor = await this.encryption.openEncryption(key);
                const results = await encryptor.encrypt([data]);
                return encodeBase64(results[0]);
            },
            decryptEncryptionKey: async (encryptedKey: string): Promise<Uint8Array | null> => {
                return this.encryption.decryptEncryptionKey(encryptedKey);
            },
            generateDataKey: async () => {
                const key = getRandomBytes(32);
                const encryptedKey = await this.encryption.encryptEncryptionKey(key);
                return { key, encryptedKey: encodeBase64(encryptedKey, 'base64') };
            },
        };

        // Build updated metadata if name or gatewayToken is provided
        const updatedMetadata = (updates.name !== undefined || updates.gatewayToken !== undefined) ? {
            ...currentMachine.metadata,
            name: updates.name ?? currentMachine.metadata?.name ?? '',
            gatewayToken: updates.gatewayToken !== undefined ? (updates.gatewayToken || undefined) : currentMachine.metadata?.gatewayToken,
        } : undefined;

        // Build updated directConfig if provided
        const updatedDirectConfig = updates.directConfig !== undefined ? {
            url: updates.directConfig.url,
            password: updates.directConfig.password,
        } : undefined;

        const updatedMachine = await updateOpenClawMachine(
            this.credentials,
            encryptionAdapter,
            machineId,
            dataKey,
            currentMachine.metadataVersion,
            {
                metadata: updatedMetadata,
                directConfig: updatedDirectConfig,
            }
        );

        if (updatedMachine) {
            storage.getState().applyOpenClawMachines([updatedMachine]);
            log.log(`🤖 Updated OpenClaw machine ${machineId}`);
        } else {
            throw new Error('Failed to update OpenClaw machine');
        }
    }

    /**
     * Delete a OpenClaw machine
     */
    public async deleteOpenClawMachine(machineId: string): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        const success = await deleteOpenClawMachine(this.credentials, machineId);

        if (success) {
            storage.getState().removeOpenClawMachine(machineId);
            this.openClawMachineDataKeys.delete(machineId);
            log.log(`🤖 Deleted OpenClaw machine ${machineId}`);
        } else {
            throw new Error('Failed to delete OpenClaw machine');
        }
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
            
            // Collect user IDs from friend-related feed items
            const userIds = new Set<string>();
            allItems.forEach(item => {
                if (item.body && (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')) {
                    userIds.add(item.body.uid);
                }
            });
            
            // Fetch missing users
            if (userIds.size > 0) {
                await this.assumeUsers(Array.from(userIds));
            }
            
            // Filter out items where user is not found (404)
            const users = storage.getState().users;
            const compatibleItems = allItems.filter(item => {
                // Keep text items
                if (item.body.kind === 'text') return true;
                
                // For friend-related items, check if user exists and is not null (404)
                if (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted') {
                    const userProfile = users[item.body.uid];
                    // Keep item only if user exists and is not null
                    return userProfile !== null && userProfile !== undefined;
                }
                
                return true;
            });
            
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
                let version = storage.getState().settingsVersion;
                let settings = applySettings(storage.getState().settings, this.pendingSettings);
                const response = await fetch(`${API_ENDPOINT}/v1/account/settings`, {
                    method: 'POST',
                    body: JSON.stringify({
                        settings: await this.encryption.encryptRaw(settings),
                        expectedVersion: version ?? 0
                    }),
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'Content-Type': 'application/json'
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
                    this.pendingSettings = {};
                    savePendingSettings({});
                    break;
                }
                if (data.error === 'version-mismatch') {
                    // Parse server settings
                    const serverSettings = data.currentSettings
                        ? settingsParse(await this.encryption.decryptRaw(data.currentSettings))
                        : { ...settingsDefaults };

                    // Merge: server base + our pending changes (our changes win)
                    const mergedSettings = applySettings(serverSettings, this.pendingSettings);

                    // Update local storage with merged result at server's version
                    storage.getState().applySettings(mergedSettings, data.currentVersion);

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
                'Content-Type': 'application/json'
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
        let parsedSettings: Settings;
        if (data.settings) {
            parsedSettings = settingsParse(await this.encryption.decryptRaw(data.settings));
        } else {
            parsedSettings = { ...settingsDefaults };
        }

        // Log
        console.log('settings', JSON.stringify({
            settings: parsedSettings,
            version: data.settingsVersion
        }));

        // Apply settings to storage
        storage.getState().applySettings(parsedSettings, data.settingsVersion);

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
                'Content-Type': 'application/json'
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
                console.log(`[fetchNativeUpdate] Request failed: ${response.status}`);
                return;
            }

            const data = await response.json();
            console.log('[fetchNativeUpdate] Data:', data);

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
            console.log('[fetchNativeUpdate] Error:', error);
            storage.getState().applyNativeUpdateStatus(null);
        }
    }

    private decryptAndNormalizeMessages = async (
        sessionId: string,
        apiMessages: ApiMessage[],
        encryption: { decryptMessages: (messages: ApiMessage[]) => Promise<any[]> },
    ): Promise<NormalizedMessage[]> => {
        // Collect existing messages for dedup
        let existingMessages = this.sessionReceivedMessages.get(sessionId);
        if (!existingMessages) {
            existingMessages = new Set<string>();
            this.sessionReceivedMessages.set(sessionId, existingMessages);
        }

        // Filter out existing messages and prepare for batch decryption
        const messagesToDecrypt: ApiMessage[] = [];
        for (const msg of [...apiMessages].reverse()) {
            if (!existingMessages.has(msg.id)) {
                messagesToDecrypt.push(msg);
            }
        }

        // Batch decrypt all messages at once
        const start = Date.now();
        const decryptedMessages = await encryption.decryptMessages(messagesToDecrypt);

        // Process decrypted messages
        const normalizedMessages: NormalizedMessage[] = [];
        for (let i = 0; i < decryptedMessages.length; i++) {
            const decrypted = decryptedMessages[i];
            if (decrypted) {
                existingMessages.add(decrypted.id);
                const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                if (normalized) {
                    normalizedMessages.push(normalized);
                }
            }
        }
        console.log('Batch decrypted and normalized messages in', Date.now() - start, 'ms');

        return normalizedMessages;
    }

    private fetchMessagesV3 = async (sessionId: string) => {
        if (!this.credentials) return;

        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            log.log(`💬 fetchMessagesV3: Session encryption not ready for ${sessionId}, will retry`);
            throw new Error(`Session encryption not ready for ${sessionId}`);
        }

        const currentCursor = this.sessionLastSeq.get(sessionId);
        if (currentCursor === undefined) {
            // Bootstrap with latest page only to avoid loading very large histories at once.
            // v3 with no after_seq/before_seq returns latest messages in desc order.
            const API_ENDPOINT = getServerUrl();
            const response = await fetch(
                `${API_ENDPOINT}/v3/sessions/${sessionId}/messages?limit=${Sync.INITIAL_MESSAGES_LIMIT}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch initial messages: ${response.status}`);
            }

            const data = await response.json();
            const apiMessages = data.messages as ApiMessage[];
            const hasMoreOlder: boolean = data.hasMore ?? false;

            if (apiMessages.length > 0) {
                const normalizedMessages = await this.decryptAndNormalizeMessages(sessionId, apiMessages, encryption);
                this.applyMessages(sessionId, normalizedMessages);

                const maxSeq = Math.max(...apiMessages.map((m) => m.seq));
                this.sessionLastSeq.set(sessionId, maxSeq);
            } else {
                this.sessionLastSeq.set(sessionId, 0);
            }

            storage.getState().applyMessagesLoaded(sessionId);

            const minSeq = apiMessages.length > 0
                ? Math.min(...apiMessages.map((m) => m.seq))
                : null;
            storage.getState().setSessionPagination(sessionId, minSeq, hasMoreOlder);

            log.log(`💬 fetchMessagesV3 bootstrap completed for session ${sessionId}, lastSeq=${this.sessionLastSeq.get(sessionId) ?? 0}`);
            return;
        }

        let afterSeq = currentCursor;
        let hasMore = true;

        while (hasMore) {
            const API_ENDPOINT = getServerUrl();
            const response = await fetch(
                `${API_ENDPOINT}/v3/sessions/${sessionId}/messages?after_seq=${afterSeq}&limit=100`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch v3 messages: ${response.status}`);
            }

            const data = await response.json();
            const messages = data.messages as ApiMessage[];
            hasMore = data.hasMore ?? false;

            if (messages.length > 0) {
                const normalizedMessages = await this.decryptAndNormalizeMessages(sessionId, messages, encryption);
                this.applyMessages(sessionId, normalizedMessages);

                const maxSeq = Math.max(...messages.map((m: any) => m.seq));
                this.sessionLastSeq.set(sessionId, maxSeq);
                afterSeq = maxSeq;
            } else {
                hasMore = false;
            }
        }

        storage.getState().applyMessagesLoaded(sessionId);

        // If we got here, cursor-based incremental sync is active and older pagination
        // state should already be established by the initial bootstrap load.
        const sessionState = storage.getState().sessionMessages[sessionId];
        if (sessionState && sessionState.oldestSeq === null) {
            storage.getState().setSessionPagination(sessionId, 1, false);
        }

        log.log(`💬 fetchMessagesV3 completed for session ${sessionId}, lastSeq=${this.sessionLastSeq.get(sessionId) ?? 0}`);
    }

    fetchOlderMessages = async (sessionId: string) => {
        const sessionState = storage.getState().sessionMessages[sessionId];
        if (!sessionState || !sessionState.hasMore || sessionState.oldestSeq === null) {
            return;
        }

        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            return;
        }

        try {
            const before = sessionState.oldestSeq;
            const API_ENDPOINT = getServerUrl();
            const response = await fetch(
                `${API_ENDPOINT}/v3/sessions/${sessionId}/messages?before_seq=${before}&limit=${Sync.INITIAL_MESSAGES_LIMIT}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch older messages: ${response.status}`);
            }

            const data = await response.json();
            const apiMessages = data.messages as ApiMessage[];
            const hasMore: boolean = data.hasMore ?? false;

            // Decrypt and normalize
            const normalizedMessages = await this.decryptAndNormalizeMessages(sessionId, apiMessages, encryption);

            // Apply to storage (merge logic handles dedup and sorting)
            this.applyMessages(sessionId, normalizedMessages);

            // Update pagination cursor
            const minSeq = apiMessages.length > 0
                ? Math.min(...apiMessages.map(m => m.seq))
                : sessionState.oldestSeq;
            storage.getState().setSessionPagination(sessionId, minSeq, hasMore);

            log.log(`💬 fetchOlderMessages completed for session ${sessionId} - loaded ${normalizedMessages.length} older messages, hasMore=${hasMore}`);
        } catch (error) {
            console.error(`Failed to fetch older messages for session ${sessionId}:`, error);
        }
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
            console.log('Failed to get push token for push notification!');
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
            log.log('🔌 Socket reconnected');
            this.sessionsSync.invalidate();
            this.machinesSync.invalidate();
            log.log('🔌 Socket reconnected: Invalidating artifacts sync');
            this.artifactsSync.invalidate();
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();
            this.feedSync.invalidate();
            const sessionsData = storage.getState().sessionsData;
            if (sessionsData) {
                for (const item of sessionsData) {
                    if (typeof item !== 'string') {
                        this.messagesSync.get(item.id)?.invalidate();
                    }
                }
            }
        });

        // Always refresh git status on ANY socket connect (including recovered connections).
        // onReconnected skips recovered connections (socket.recovered=true), but git status
        // local sync state (InvalidateSync, retry counters) may be stuck and needs resetting.
        apiSocket.onStatusChange((status) => {
            if (status === 'connected') {
                gitStatusSync.invalidateForSessions(Object.keys(storage.getState().sessions));
            }
        });
    }

    private handleUpdate = async (update: unknown) => {
        console.log('🔄 Sync: handleUpdate called with:', JSON.stringify(update).substring(0, 300));
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('❌ Sync: Invalid update received:', validatedUpdate.error);
            console.error('❌ Sync: Invalid update data:', update);
            return;
        }
        const updateData = validatedUpdate.data;
        console.log(`🔄 Sync: Validated update type: ${updateData.body.t}`);

        if (updateData.body.t === 'new-message') {
            const sid = updateData.body.sid;
            const incomingSeq = updateData.body.message?.seq;
            const currentLastSeq = this.sessionLastSeq.get(sid);

            if (currentLastSeq !== undefined && incomingSeq !== undefined) {
                if (incomingSeq <= currentLastSeq) {
                    // Already seen this seq (e.g. echo of our own send), just apply for dedup
                    this.enqueueSessionMessageUpdate(updateData);
                } else if (incomingSeq === currentLastSeq + 1) {
                    // Fast path: seq is contiguous, apply directly and bump seq
                    this.sessionLastSeq.set(sid, incomingSeq);
                    this.enqueueSessionMessageUpdate(updateData);
                } else {
                    // Gap detected: do NOT bump sessionLastSeq — keep the old
                    // cursor so fetchMessagesV3 starts from the last known seq
                    // and fills the gap (current+1..incoming-1).
                    this.enqueueSessionMessageUpdate(updateData);
                    this.invalidateMessagesSync(sid);
                }
            } else {
                // First message or no seq tracking yet — keep cursor unset so
                // fetchMessagesV3 can run bounded bootstrap (latest page only).
                this.enqueueSessionMessageUpdate(updateData);
                this.invalidateMessagesSync(sid);
            }

        } else if (updateData.body.t === 'new-session') {
            log.log('🆕 New session update received');
            this.sessionsSync.invalidate();
        } else if (updateData.body.t === 'delete-session') {
            log.log('🗑️ Delete session update received');
            const sessionId = updateData.body.sid;

            // Remove session from storage
            storage.getState().deleteSession(sessionId);

            // Remove encryption keys from memory
            this.encryption.removeSessionEncryption(sessionId);

            // Remove from project manager
            projectManager.removeSession(sessionId);

            // Clear any cached git status
            gitStatusSync.clearForSession(sessionId);

            log.log(`🗑️ Session ${sessionId} deleted from local storage`);
        } else if (updateData.body.t === 'update-session') {
            const session = storage.getState().sessions[updateData.body.id];
            if (session) {
                // Get session encryption
                const sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
                if (!sessionEncryption) {
                    console.error(`Session encryption not found for ${updateData.body.id} - this should never happen`);
                    return;
                }

                const agentState = updateData.body.agentState && sessionEncryption
                    ? await sessionEncryption.decryptAgentState(updateData.body.agentState.version, updateData.body.agentState.value)
                    : session.agentState;
                const metadata = updateData.body.metadata && sessionEncryption
                    ? await sessionEncryption.decryptMetadata(updateData.body.metadata.version, updateData.body.metadata.value)
                    : session.metadata;

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
                    seq: updateData.seq
                }]);

                // If user is viewing this session, keep lastViewedAt fresh
                // so incoming taskCompleted doesn't show a blue dot
                if (this.viewingSessionId === updateData.body.id) {
                    markSessionViewed(updateData.body.id);
                }

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
                    if (!wasControlledByUser && isNowControlledByUser) {
                        log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                        this.onSessionVisible(updateData.body.id);
                    }
                }
            }
        } else if (updateData.body.t === 'update-account') {
            const accountUpdate = updateData.body;
            const currentProfile = storage.getState().profile;

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

            // Handle settings updates (new for profile sync)
            if (accountUpdate.settings?.value) {
                try {
                    const decryptedSettings = await this.encryption.decryptRaw(accountUpdate.settings.value);
                    const parsedSettings = settingsParse(decryptedSettings);

                    // Version compatibility check
                    const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
                    if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                        console.warn(
                            `⚠️ Received settings schema v${settingsSchemaVersion}, ` +
                            `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`
                        );
                    }

                    storage.getState().applySettings(parsedSettings, accountUpdate.settings.version);
                    log.log(`📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${accountUpdate.settings.version})`);
                } catch (error) {
                    console.error('❌ Failed to process settings update:', error);
                    // Don't crash on settings sync errors, just log
                }
            }
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
        } else if (updateData.body.t === 'relationship-updated') {
            log.log('👥 Received relationship-updated update');
            const relationshipUpdate = updateData.body;
            
            // Apply the relationship update to storage
            storage.getState().applyRelationshipUpdate({
                fromUserId: relationshipUpdate.fromUserId,
                toUserId: relationshipUpdate.toUserId,
                status: relationshipUpdate.status,
                action: relationshipUpdate.action,
                fromUser: relationshipUpdate.fromUser,
                toUser: relationshipUpdate.toUser,
                timestamp: relationshipUpdate.timestamp
            });
            
            // Invalidate friends data to refresh with latest changes
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();
            this.feedSync.invalidate();
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
            
            // Check if we need to fetch user for friend-related items
            if (feedItem.body && (feedItem.body.kind === 'friend_request' || feedItem.body.kind === 'friend_accepted')) {
                await this.assumeUsers([feedItem.body.uid]);
                
                // Check if user fetch failed (404) - don't store item if user not found
                const users = storage.getState().users;
                const userProfile = users[feedItem.body.uid];
                if (userProfile === null || userProfile === undefined) {
                    // User was not found or 404, don't store this item
                    log.log(`📰 Skipping feed item ${feedItem.id} - user ${feedItem.body.uid} not found`);
                    return;
                }
            }
            
            // Apply to storage (will handle repeatKey replacement)
            storage.getState().applyFeedItems([feedItem]);
        } else if (updateData.body.t === 'new-openclaw-machine') {
            log.log('🤖 Received new-openclaw-machine update');
            const openClawUpdate = updateData.body;

            try {
                // Create encryption adapter for processing using openEncryption
                const createEncryptionAdapter = async (key: Uint8Array) => {
                    const encryptor = await this.encryption.openEncryption(key);
                    return {
                        decryptWithKey: async (encryptedData: string, _key: Uint8Array): Promise<unknown> => {
                            const decoded = decodeBase64(encryptedData);
                            const results = await encryptor.decrypt([decoded]);
                            return results[0];
                        },
                        encryptWithKey: async (data: unknown, _key: Uint8Array): Promise<string> => {
                            const results = await encryptor.encrypt([data]);
                            return encodeBase64(results[0]);
                        },
                        decryptEncryptionKey: async (encryptedKey: string): Promise<Uint8Array | null> => {
                            return this.encryption.decryptEncryptionKey(encryptedKey);
                        },
                        generateDataKey: async () => {
                            throw new Error('Not needed for receiving events');
                        },
                    };
                };

                // First decrypt the data encryption key
                if (!openClawUpdate.dataEncryptionKey) {
                    console.error('No data encryption key for new OpenClaw machine');
                    return;
                }

                const dataKey = await this.encryption.decryptEncryptionKey(openClawUpdate.dataEncryptionKey);
                if (!dataKey) {
                    console.error('Failed to decrypt data encryption key for new OpenClaw machine');
                    return;
                }

                const encryptionAdapter = await createEncryptionAdapter(dataKey);
                const machine = await processNewOpenClawMachineEvent(openClawUpdate, encryptionAdapter);
                if (machine) {
                    // Store the data encryption key
                    this.openClawMachineDataKeys.set(machine.id, dataKey);

                    storage.getState().applyOpenClawMachines([machine]);
                    log.log(`🤖 Added new OpenClaw machine ${machine.id} to storage`);
                }
            } catch (error) {
                console.error('Failed to process new OpenClaw machine:', error);
            }
        } else if (updateData.body.t === 'update-openclaw-machine') {
            log.log('🤖 Received update-openclaw-machine update');
            const openClawUpdate = updateData.body;
            const machineId = openClawUpdate.machineId;

            // Get existing machine
            const existingMachine = storage.getState().openClawMachines[machineId];
            if (!existingMachine) {
                console.error(`OpenClaw machine ${machineId} not found in storage`);
                // Fetch all machines to sync
                this.openClawMachinesSync.invalidate();
                return;
            }

            // Get the data encryption key from memory
            const dataKey = this.openClawMachineDataKeys.get(machineId);
            if (!dataKey) {
                console.error(`Encryption key not found for OpenClaw machine ${machineId}, fetching machines`);
                this.openClawMachinesSync.invalidate();
                return;
            }

            try {
                // Create encryption adapter using openEncryption
                const encryptor = await this.encryption.openEncryption(dataKey);
                const encryptionAdapter = {
                    decryptWithKey: async (encryptedData: string, _key: Uint8Array): Promise<unknown> => {
                        const decoded = decodeBase64(encryptedData);
                        const results = await encryptor.decrypt([decoded]);
                        return results[0];
                    },
                    encryptWithKey: async (data: unknown, _key: Uint8Array): Promise<string> => {
                        const results = await encryptor.encrypt([data]);
                        return encodeBase64(results[0]);
                    },
                    decryptEncryptionKey: async (encryptedKey: string): Promise<Uint8Array | null> => {
                        return this.encryption.decryptEncryptionKey(encryptedKey);
                    },
                    generateDataKey: async () => {
                        throw new Error('Not needed for receiving events');
                    },
                };

                const updatedMachine = await processUpdateOpenClawMachineEvent(
                    openClawUpdate,
                    existingMachine,
                    encryptionAdapter,
                    dataKey
                );

                storage.getState().applyOpenClawMachines([updatedMachine]);
                log.log(`🤖 Updated OpenClaw machine ${machineId} in storage`);
            } catch (error) {
                console.error(`Failed to process OpenClaw machine update ${machineId}:`, error);
            }
        } else if (updateData.body.t === 'delete-openclaw-machine') {
            log.log('🤖 Received delete-openclaw-machine update');
            const openClawUpdate = updateData.body;
            const machineId = openClawUpdate.machineId;

            // Remove from storage
            storage.getState().removeOpenClawMachine(machineId);

            // Remove encryption key from memory
            this.openClawMachineDataKeys.delete(machineId);

            log.log(`🤖 Deleted OpenClaw machine ${machineId} from storage`);
        }
    }

    private enqueueSessionMessageUpdate = (updateData: ApiUpdateContainer) => {
        if (updateData.body.t !== 'new-message') {
            return;
        }
        const sid = updateData.body.sid;
        const queue = this.sessionMessageUpdateQueues.get(sid);
        if (queue) {
            queue.push(updateData);
        } else {
            this.sessionMessageUpdateQueues.set(sid, [updateData]);
        }
        if (!this.sessionMessageQueueRunning.has(sid)) {
            void this.processSessionMessageQueue(sid);
        }
    }

    private processSessionMessageQueue = async (sessionId: string) => {
        if (this.sessionMessageQueueRunning.has(sessionId)) {
            return;
        }
        this.sessionMessageQueueRunning.add(sessionId);
        try {
            while (true) {
                const queue = this.sessionMessageUpdateQueues.get(sessionId);
                const next = queue?.shift();
                if (!next) {
                    this.sessionMessageUpdateQueues.delete(sessionId);
                    break;
                }

                // Enforce minimum interval since last processed message
                const lastProcessedAt = this.sessionLastMessageProcessedAt.get(sessionId) ?? 0;
                const elapsed = Date.now() - lastProcessedAt;
                if (elapsed < Sync.NEW_MESSAGE_PROCESS_INTERVAL_MS) {
                    await new Promise<void>((resolve) => {
                        const existingTimer = this.sessionMessageQueueTimers.get(sessionId);
                        if (existingTimer) {
                            clearTimeout(existingTimer);
                        }
                        const delay = Sync.NEW_MESSAGE_PROCESS_INTERVAL_MS - elapsed;
                        const timer = setTimeout(() => {
                            this.sessionMessageQueueTimers.delete(sessionId);
                            resolve();
                        }, delay);
                        this.sessionMessageQueueTimers.set(sessionId, timer);
                    });
                }

                await this.applyNewMessageUpdate(next);
                this.sessionLastMessageProcessedAt.set(sessionId, Date.now());
            }
        } finally {
            this.sessionMessageQueueRunning.delete(sessionId);
            const timer = this.sessionMessageQueueTimers.get(sessionId);
            if (timer) {
                clearTimeout(timer);
                this.sessionMessageQueueTimers.delete(sessionId);
            }
            if ((this.sessionMessageUpdateQueues.get(sessionId)?.length ?? 0) > 0) {
                void this.processSessionMessageQueue(sessionId);
            }
        }
    }

    private applyNewMessageUpdate = async (updateData: ApiUpdateContainer) => {
        if (updateData.body.t !== 'new-message') {
            return;
        }

        // Get encryption
        const encryption = this.encryption.getSessionEncryption(updateData.body.sid);
        if (!encryption) { // Should never happen
            console.error(`Session ${updateData.body.sid} not found`);
            this.fetchSessions(); // Just fetch sessions again
            return;
        }

        // Decrypt message
        let lastMessage: NormalizedMessage | null = null;
        if (updateData.body.message) {
            const decrypted = await encryption.decryptMessage(updateData.body.message);
            if (decrypted) {
                lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);

                // Check for task lifecycle events to update thinking state
                // This ensures UI updates even if volatile activity updates are lost
                const rawContent = decrypted.content as { role?: string; content?: { type?: string; data?: { type?: string } } } | null;
                const contentType = rawContent?.content?.type;
                const dataType = rawContent?.content?.data?.type;

                // Debug logging to trace lifecycle events
                if (dataType === 'task_complete' || dataType === 'turn_aborted' || dataType === 'task_started') {
                    console.log(`🔄 [Sync] Lifecycle event detected: contentType=${contentType}, dataType=${dataType}`);
                }

                const isTaskComplete =
                    ((contentType === 'acp' || contentType === 'codex') &&
                        (dataType === 'task_complete' || dataType === 'turn_aborted'));

                const isTaskStarted =
                    ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started');

                if (isTaskComplete || isTaskStarted) {
                    console.log(`🔄 [Sync] Updating thinking state: isTaskComplete=${isTaskComplete}, isTaskStarted=${isTaskStarted}`);
                }

                // Update session
                const session = storage.getState().sessions[updateData.body.sid];
                if (session) {
                    this.applySessions([{
                        ...session,
                        updatedAt: updateData.createdAt,
                        seq: updateData.seq,
                        // Update thinking state based on task lifecycle events
                        ...(isTaskComplete ? { thinking: false } : {}),
                        ...(isTaskStarted ? { thinking: true } : {})
                    }]);
                } else {
                    // Fetch sessions again if we don't have this session
                    this.fetchSessions();
                }

                // Update messages
                if (lastMessage) {
                    console.log('🔄 Sync: Applying message:', JSON.stringify(lastMessage));
                    this.applyMessages(updateData.body.sid, [lastMessage]);
                    let hasMutableTool = false;
                    if (lastMessage.role === 'agent' && lastMessage.content[0] && lastMessage.content[0].type === 'tool-result') {
                        hasMutableTool = storage.getState().isMutableToolCall(updateData.body.sid, lastMessage.content[0].tool_use_id);
                    }
                    if (hasMutableTool) {
                        gitStatusSync.invalidate(updateData.body.sid);
                    }
                }
            }
        }

        // Ping session
        this.onSessionVisible(updateData.body.sid);
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

        if (updateData.type === 'message-syncing') {
            const sessionId = updateData.id;
            const existing = this.messageSyncTimeouts.get(sessionId);
            if (existing) {
                clearTimeout(existing);
            }
            storage.getState().setSessionMessageSyncing(sessionId, true);
            storage.getState().clearSessionMessages(sessionId);
            this.sessionReceivedMessages.delete(sessionId);
            // Reset seq cursor so the subsequent re-fetch starts from seq 0
            // and retrieves all messages, not just those after the old cursor.
            this.sessionLastSeq.delete(sessionId);

            const timeout = setTimeout(() => {
                this.messageSyncTimeouts.delete(sessionId);
                storage.getState().setSessionMessageSyncing(sessionId, false);
                this.invalidateMessagesSync(sessionId);
            }, 30000);
            this.messageSyncTimeouts.set(sessionId, timeout);
        }

        if (updateData.type === 'message-synced') {
            const sessionId = updateData.id;
            const existing = this.messageSyncTimeouts.get(sessionId);
            if (existing) {
                clearTimeout(existing);
                this.messageSyncTimeouts.delete(sessionId);
            }
            storage.getState().setSessionMessageSyncing(sessionId, false);
            this.invalidateMessagesSync(sessionId);
        }

        if (updateData.type === 'message-errored') {
            const sessionId = updateData.id;
            const existing = this.messageSyncTimeouts.get(sessionId);
            if (existing) {
                clearTimeout(existing);
                this.messageSyncTimeouts.delete(sessionId);
            }
            storage.getState().setSessionMessageSyncing(sessionId, false);
            this.invalidateMessagesSync(sessionId);
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
        log.log(`[SEND_DEBUG][SOCKET] status=${status}`);
        storage.getState().setSocketStatus(status);
    });

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}
