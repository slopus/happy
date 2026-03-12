import Constants from 'expo-constants';
import { apiSocket } from '@/sync/apiSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { storage, getSession } from './storage';
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
import { signContentPublicKey } from './directShareEncryption';
import { uploadContentPublicKey, fetchSharedSessions as apiFetchSharedSessions } from './apiSharing';
import { gitStatusSync } from './gitStatusSync';
import { projectManager } from './projectManager';
import { AsyncLock } from '@/utils/lock';
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
import { shouldInvalidateGitStatusOnActivityTransition } from './gitStatusRefreshPolicy';

type PermissionMode = NonNullable<Session['permissionMode']>;

type SessionMessageDispatchTask = {
    reason: string;
    generation: number;
    run: () => Promise<void> | void;
    resolve: () => void;
};

type PreparedNewMessageUpdate = {
    updateData: ApiUpdateContainer;
    lastMessage: NormalizedMessage | null;
    isTaskComplete: boolean;
    isTaskStarted: boolean;
};

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

    // Sync to other devices via metadata (throttled to avoid feedback loops).
    // Skip for inactive sessions: the server-side metadata update triggers
    // Prisma @updatedAt which would re-sort the session to the top of the
    // inactive list. Local-only update is sufficient for blue dot dismissal.
    if (session?.metadata && session.active) {
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
    // Per-session pacing for all message-list updates to avoid autoscroll races across websocket and fetch paths.
    private static readonly MESSAGE_LIST_DISPATCH_INTERVAL_MS = 400;
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
    private sessionMessageDispatchQueues = new Map<string, SessionMessageDispatchTask[]>();
    private sessionMessageDispatchRunning = new Set<string>();
    private sessionMessageDispatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private sessionMessageDispatchGeneration = new Map<string, number>();
    private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
    /** Per-session last-known seq for v3 incremental fetch */
    private sessionLastSeq = new Map<string, number>();
    /** Callbacks to run before applying a sent message (keyed by localId).
     *  Ensures input is cleared before message appears, regardless of whether
     *  the HTTP response or WebSocket echo arrives first. */
    private pendingSendCallbacks = new Map<string, () => void>();
    /** Per-session lock to serialize fetchMessagesV3 and websocket message application */
    private sessionMessageLocks = new Map<string, AsyncLock>();
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
    private feedFullRefresh = false;
    private sharedSessionsSync: InvalidateSync;
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
        this.sharedSessionsSync = new InvalidateSync(this.fetchSharedSessions);
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
                this.sharedSessionsSync.invalidate();
                gitStatusSync.invalidateForSessions([...Object.keys(storage.getState().sessions), ...Object.keys(storage.getState().sharedSessions)]);

                // DooTask token refresh (throttled to 1h)
                const dootaskProfile = storage.getState().dootaskProfile;
                if (dootaskProfile && this.credentials) {
                    const lastChecked = dootaskProfile.lastCheckedAt
                        ? new Date(dootaskProfile.lastCheckedAt).getTime()
                        : 0;
                    const now = Date.now();
                    const ONE_HOUR = 60 * 60 * 1000;
                    if (now - lastChecked >= ONE_HOUR) {
                        // Refresh token via DooTask API
                        fetch(`${dootaskProfile.serverUrl}/api/users/token/expire?refresh=1`, {
                            method: 'GET',
                            headers: { 'Content-Type': 'application/json', 'dootask-token': dootaskProfile.token },
                        }).then(res => res.json()).then((json: any) => {
                            if (json.ret !== 1) throw new Error('refresh failed');
                            const newToken: string | null = json.data?.token ?? null;
                            const updatedProfile = {
                                ...dootaskProfile,
                                lastCheckedAt: new Date().toISOString(),
                                tokenExpiredAt: json.data?.expired_at ?? null,
                                tokenRemainingSeconds: json.data?.remaining_seconds ?? null,
                                ...(newToken ? { token: newToken } : {}),
                            };
                            storage.getState().setDootaskProfile(updatedProfile);

                            // Sync new token to server if refreshed
                            if (newToken && this.credentials) {
                                fetch(`${getServerUrl()}/v1/connect/dootask`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${this.credentials.token}`,
                                    },
                                    body: JSON.stringify({
                                        serverUrl: updatedProfile.serverUrl,
                                        token: updatedProfile.token,
                                        userId: updatedProfile.userId,
                                        username: updatedProfile.username,
                                        avatar: updatedProfile.avatar,
                                    }),
                                }).catch(() => {});
                            }
                        }).catch(() => {
                            // No-op: keep existing data, retry on next foreground resume
                        });
                    }
                }
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

        // Upload content public key for direct sharing (fire-and-forget)
        this.#uploadContentPublicKey().catch(() => {});
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();

        // Upload content public key for direct sharing (fire-and-forget)
        this.#uploadContentPublicKey().catch(() => {});
    }

    async #uploadContentPublicKey() {
        if (!this.credentials || !this.encryption) return;
        const seed = decodeBase64(this.credentials.secret, 'base64url');
        const publicKey = this.encryption.contentDataKey; // X25519 public key
        const sig = await signContentPublicKey(publicKey, seed);
        await uploadContentPublicKey(
            this.credentials,
            encodeBase64(publicKey, 'base64'),
            encodeBase64(sig, 'base64')
        );
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
        this.sharedSessionsSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts');

        // Wait for both sessions and machines to load, then mark as ready
        Promise.all([
            this.sessionsSync.awaitQueue(),
            this.machinesSync.awaitQueue()
        ]).then(() => {
            gitStatusSync.invalidateForSessions([...Object.keys(storage.getState().sessions), ...Object.keys(storage.getState().sharedSessions)]);
            storage.getState().applyReady();

            // Restore DooTask profile from server if not available locally
            if (!storage.getState().dootaskProfile && this.credentials) {
                const endpoint = getServerUrl();
                const token = this.credentials.token;
                fetch(`${endpoint}/v1/connect/dootask`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${token}` },
                }).then(res => {
                    if (!res.ok) return null;
                    return res.json();
                }).then(json => {
                    const profile = json?.profile;
                    log.log(`🔗 DooTask: Server restore: ${profile ? 'found' : 'null'}`);
                    if (profile && !storage.getState().dootaskProfile) {
                        storage.getState().setDootaskProfile({
                            serverUrl: profile.serverUrl,
                            token: profile.token,
                            userId: profile.userId,
                            username: profile.username,
                            avatar: profile.avatar,
                            tokenExpiredAt: null,
                            tokenRemainingSeconds: null,
                            lastCheckedAt: null,
                        });
                    }
                }).catch(() => {});
            }
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

        // Also invalidate git status sync for this session.
        // Uses gitStatusSync.invalidate() (not getSync().invalidate()) to also reset
        // the retry counter, ensuring recovery after transient failures.
        gitStatusSync.invalidate(sessionId);

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

    async sendMessage(sessionId: string, text: string, displayText?: string, images?: LocalImage[], existingLocalId?: string, onBeforeApply?: () => void): Promise<{ success: boolean; error?: string; localId: string }> {

        // Get encryption
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) { // Should never happen
            console.error(`Session ${sessionId} not found`);
            return { success: false, error: 'Session encryption not found', localId: '' };
        }

        // Get session data from storage (check both owned and shared sessions)
        const session = getSession(sessionId);
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
        if (normalizedMessage) {
            const profile = storage.getState().profile;
            normalizedMessage.sentBy = this.serverID;
            normalizedMessage.sentByName = profile.firstName || null;
        }

        // Check if session is active before sending
        const sessionState = getSession(sessionId);
        if (sessionState && !sessionState.active) {
            log.log(`Session ${sessionId} is not active, sending anyway`);
        }

        // Register onBeforeApply so the WebSocket echo path can also trigger it.
        // Whichever path (HTTP response or WebSocket) reaches applyMessages first
        // will invoke and remove the callback, ensuring input clears before the
        // message appears in the list.
        if (onBeforeApply) {
            this.pendingSendCallbacks.set(localId, onBeforeApply);
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
                            localId,
                            trackCliDelivery: true
                        }]
                    })
                }
            );

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                log.log(`[SEND_DEBUG][SYNC] fail sid=${sessionId} localId=${localId} via=v3-http status=${response.status} error=${errorText}`);
                this.pendingSendCallbacks.delete(localId);
                return { success: false, error: `Send failed: ${response.status}`, localId };
            }

            // Invoke pending callback if WebSocket echo hasn't already consumed it
            const pending = this.pendingSendCallbacks.get(localId);
            if (pending) {
                this.pendingSendCallbacks.delete(localId);
                pending();
            }

            // Apply message to local storage through the unified dispatcher
            if (normalizedMessage) {
                const msg = normalizedMessage;
                void this.enqueueSessionMessageDispatch(sessionId, 'sendMessage:local-ack', async () => {
                    this.applyMessages(sessionId, [msg]);
                });
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
            this.pendingSendCallbacks.delete(localId);
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
            isShared?: boolean;
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
                this.sessionDataKeys.set(session.id, decrypted);
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

    private fetchSharedSessions = async () => {
        if (!this.credentials || !this.encryption) return;

        const sharedSessions = await apiFetchSharedSessions(this.credentials);
        log.log(`📥 fetchSharedSessions: received ${sharedSessions.length} shared sessions`);

        // Decrypt data keys and initialize session encryptions
        const sessionKeys = new Map<string, Uint8Array | null>();
        for (const ss of sharedSessions) {
            if (ss.encryptedDataKey) {
                try {
                    const decrypted = await this.encryption.decryptEncryptionKey(ss.encryptedDataKey);
                    if (decrypted) {
                        sessionKeys.set(ss.sessionId, decrypted);
                        this.sessionDataKeys.set(ss.sessionId, decrypted);
                    } else {
                        console.error(`Failed to decrypt data key for shared session ${ss.sessionId}`);
                    }
                } catch (error) {
                    console.error(`Error decrypting data key for shared session ${ss.sessionId}:`, error);
                }
            }
        }
        await this.encryption.initializeSessions(sessionKeys);

        // Decrypt metadata for each shared session
        const decryptedSessions: Session[] = [];
        for (const ss of sharedSessions) {
            const sessionEncryption = this.encryption.getSessionEncryption(ss.sessionId);
            if (!sessionEncryption) {
                console.error(`Session encryption not found for shared session ${ss.sessionId}`);
                continue;
            }

            const metadata = ss.metadata
                ? await sessionEncryption.decryptMetadata(ss.metadataVersion, ss.metadata)
                : null;

            const agentState = ss.agentState
                ? await sessionEncryption.decryptAgentState(ss.agentStateVersion, ss.agentState)
                : null;

            decryptedSessions.push({
                id: ss.sessionId,
                seq: ss.seq,
                createdAt: ss.createdAt,
                updatedAt: ss.updatedAt,
                active: ss.active,
                activeAt: ss.activeAt,
                metadata,
                metadataVersion: ss.metadataVersion,
                agentState,
                agentStateVersion: ss.agentStateVersion,
                thinking: false,
                thinkingAt: 0,
                presence: ss.active ? "online" : ss.activeAt,
                owner: ss.sharedBy.id,
                ownerProfile: {
                    id: ss.sharedBy.id,
                    username: ss.sharedBy.username ?? '',
                    firstName: ss.sharedBy.firstName ?? '',
                    lastName: ss.sharedBy.lastName,
                    avatar: ss.sharedBy.avatar,
                },
                accessLevel: ss.accessLevel,
            });
        }

        storage.getState().applySharedSessions(decryptedSessions);
        log.log(`📥 fetchSharedSessions completed - processed ${decryptedSessions.length} shared sessions`);
    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    public refreshFriends = () => {
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.feedSync.invalidate();
    }

    public refreshInbox = async () => {
        this.feedFullRefresh = true;
        await Promise.all([
            this.feedSync.invalidateAndAwait(),
            this.friendsSync.invalidateAndAwait(),
            this.friendRequestsSync.invalidateAndAwait(),
        ]);
    }

    public getCredentials() {
        return this.credentials;
    }

    /**
     * Get the decrypted data encryption key for a session.
     * Returns null if the key hasn't been fetched/decrypted yet.
     */
    public getSessionDataKey(sessionId: string): Uint8Array | null {
        const key = this.sessionDataKeys.get(sessionId);
        if (!key) return null;
        return new Uint8Array(key);
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
            // Full refresh mode: treat as fresh load (ignore existing cursors)
            const isFullRefresh = this.feedFullRefresh;
            this.feedFullRefresh = false;

            log.log('📰 Fetching feed...' + (isFullRefresh ? ' (full refresh)' : ''));
            const state = storage.getState();
            const existingItems = state.feedItems;
            const head = isFullRefresh ? null : state.feedHead;

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
                const existingIds = new Set(allItems.map(i => i.id));
                response.items.forEach(item => {
                    if (!existingIds.has(item.id)) {
                        allItems.push(item);
                    }
                });
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
            
            // Full refresh replaces all items; incremental merges new ones
            if (isFullRefresh) {
                storage.getState().replaceFeedItems(compatibleItems);
            } else {
                storage.getState().applyFeedItems(compatibleItems);
            }
            log.log(`📰 fetchFeed completed - loaded ${compatibleItems.length} compatible items (${allItems.length - compatibleItems.length} filtered)${isFullRefresh ? ' (replaced)' : ''}`);
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
                    normalized.sentBy = decrypted.sentBy;
                    normalized.sentByName = decrypted.sentByName;
                    const deliveryIssue = messagesToDecrypt[i]?.deliveryIssue;
                    if (deliveryIssue?.status === 'error') {
                        normalized.deliveryError = deliveryIssue.reason || 'unknown_error';
                    }
                    normalizedMessages.push(normalized);
                }
            }
        }
        console.log('Batch decrypted and normalized messages in', Date.now() - start, 'ms');

        return normalizedMessages;
    }

    private getSessionMessageLock(sessionId: string): AsyncLock {
        let lock = this.sessionMessageLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncLock();
            this.sessionMessageLocks.set(sessionId, lock);
        }
        return lock;
    }

    private fetchMessagesV3 = async (sessionId: string) => {
        if (!this.credentials) return;

        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            log.log(`💬 fetchMessagesV3: Session encryption not ready for ${sessionId}, will retry`);
            throw new Error(`Session encryption not ready for ${sessionId}`);
        }

        const lock = this.getSessionMessageLock(sessionId);
        await lock.inLock(async () => {
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
                const normalizedMessages = apiMessages.length > 0
                    ? await this.decryptAndNormalizeMessages(sessionId, apiMessages, encryption)
                    : [];

                if (apiMessages.length > 0) {
                    const maxSeq = Math.max(...apiMessages.map((m) => m.seq));
                    this.sessionLastSeq.set(sessionId, Math.max(this.sessionLastSeq.get(sessionId) ?? 0, maxSeq));
                } else if (!this.sessionLastSeq.has(sessionId)) {
                    this.sessionLastSeq.set(sessionId, 0);
                }

                const minSeq = apiMessages.length > 0
                    ? Math.min(...apiMessages.map((m) => m.seq))
                    : null;

                await this.enqueueSessionMessageDispatch(sessionId, 'fetchMessagesV3:bootstrap', async () => {
                    if (normalizedMessages.length > 0) {
                        this.applyMessages(sessionId, normalizedMessages);
                    }
                    storage.getState().applyMessagesLoaded(sessionId);
                    storage.getState().setSessionPagination(sessionId, minSeq, hasMoreOlder);
                });

                log.log(`💬 fetchMessagesV3 bootstrap completed for session ${sessionId}, lastSeq=${this.sessionLastSeq.get(sessionId) ?? 0}`);
                return;
            }

            let afterSeq = currentCursor;
            let hasMore = true;
            const pendingNormalizedMessages: NormalizedMessage[] = [];

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
                    pendingNormalizedMessages.push(...normalizedMessages);

                    const maxSeq = Math.max(...messages.map((m: any) => m.seq));
                    this.sessionLastSeq.set(sessionId, Math.max(this.sessionLastSeq.get(sessionId) ?? 0, maxSeq));
                    afterSeq = maxSeq;
                } else {
                    hasMore = false;
                }
            }

            await this.enqueueSessionMessageDispatch(sessionId, 'fetchMessagesV3:incremental', async () => {
                for (const msg of pendingNormalizedMessages) {
                    if (msg.localId) {
                        const pending = this.pendingSendCallbacks.get(msg.localId);
                        if (pending) {
                            this.pendingSendCallbacks.delete(msg.localId);
                            pending();
                        }
                    }
                }

                if (pendingNormalizedMessages.length > 0) {
                    this.applyMessages(sessionId, pendingNormalizedMessages);
                }

                storage.getState().applyMessagesLoaded(sessionId);

                // If we got here, cursor-based incremental sync is active and older pagination
                // state should already be established by the initial bootstrap load.
                const sessionState = storage.getState().sessionMessages[sessionId];
                if (sessionState && sessionState.oldestSeq === null) {
                    storage.getState().setSessionPagination(sessionId, 1, false);
                }
            });

            log.log(`💬 fetchMessagesV3 completed for session ${sessionId}, lastSeq=${this.sessionLastSeq.get(sessionId) ?? 0}`);
        });
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

            // Update pagination together with the queued list update
            const minSeq = apiMessages.length > 0
                ? Math.min(...apiMessages.map(m => m.seq))
                : sessionState.oldestSeq;
            await this.enqueueSessionMessageDispatch(sessionId, 'fetchOlderMessages', async () => {
                if (normalizedMessages.length > 0) {
                    this.applyMessages(sessionId, normalizedMessages);
                }
                storage.getState().setSessionPagination(sessionId, minSeq, hasMore);
            });

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
                gitStatusSync.invalidateForSessions([...Object.keys(storage.getState().sessions), ...Object.keys(storage.getState().sharedSessions)]);
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
            this.sessionDataKeys.delete(sessionId);

            // Remove from project manager
            projectManager.removeSession(sessionId);

            // Clear any cached git status
            gitStatusSync.clearForSession(sessionId);

            // Clear message sync state
            this.messagesSync.delete(sessionId);
            this.sessionLastSeq.delete(sessionId);
            this.sessionMessageLocks.delete(sessionId);
            this.sessionMessageUpdateQueues.delete(sessionId);
            this.sessionMessageQueueRunning.delete(sessionId);
            this.resetSessionMessageDispatch(sessionId);

            log.log(`🗑️ Session ${sessionId} deleted from local storage`);
        } else if (updateData.body.t === 'update-session') {
            const sessionId = updateData.body.id;
            const isShared = !!storage.getState().sharedSessions[sessionId];
            const session = storage.getState().sessions[sessionId]
                ?? storage.getState().sharedSessions[sessionId];
            if (session) {
                // Get session encryption
                const sessionEncryption = this.encryption.getSessionEncryption(sessionId);
                if (!sessionEncryption) {
                    console.error(`Session encryption not found for ${sessionId} - this should never happen`);
                    return;
                }

                const agentState = updateData.body.agentState && sessionEncryption
                    ? await sessionEncryption.decryptAgentState(updateData.body.agentState.version, updateData.body.agentState.value)
                    : session.agentState;
                const metadata = updateData.body.metadata && sessionEncryption
                    ? await sessionEncryption.decryptMetadata(updateData.body.metadata.version, updateData.body.metadata.value)
                    : session.metadata;

                const updatedSession = {
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
                };

                if (isShared) {
                    storage.getState().addSharedSession(updatedSession);
                    // Re-process messages when agentState changes so permission buttons appear
                    if (updateData.body.agentState && storage.getState().sessionMessages[sessionId]?.isLoaded) {
                        void this.enqueueSessionMessageDispatch(sessionId, 'update-session:shared-agent-state', async () => {
                            storage.getState().applyMessages(sessionId, []);
                        });
                    }
                } else {
                    this.applySessions([updatedSession]);
                }

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
        } else if (updateData.body.t === 'new-machine') {
            // Re-fetch all machines to pick up the newly registered device
            this.machinesSync.invalidate();
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
                // Machine encryption not initialized yet (e.g. machine just registered,
                // fetchMachines still in progress). Re-fetch to pick up the full state.
                this.machinesSync.invalidate();
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
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();

            // When relationship is cleared (rejected/cancelled), remove stale feed items locally
            if (updateData.body.status === 'none') {
                const uid = updateData.body.uid;
                const feedItems = storage.getState().feedItems;
                const itemToRemove = feedItems.find(item =>
                    (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')
                    && item.body.uid === uid
                );
                if (itemToRemove) {
                    storage.getState().removeFeedItem(itemToRemove.id);
                }
            }

            this.feedSync.invalidate();
        } else if (updateData.body.t === 'session-shared') {
            log.log('Received session-shared update');
            const { sessionId, sharedBy, accessLevel, encryptedDataKey, createdAt } = updateData.body;

            // Decrypt the shared session's data encryption key
            let decryptedDataKey: Uint8Array | null = null;
            if (encryptedDataKey) {
                try {
                    decryptedDataKey = await this.encryption.decryptEncryptionKey(encryptedDataKey);
                    if (!decryptedDataKey) {
                        console.error(`Failed to decrypt data key for shared session ${sessionId}`);
                    }
                } catch (error) {
                    console.error(`Error decrypting data key for shared session ${sessionId}:`, error);
                }
            }

            // Initialize session encryption if we have the key
            if (decryptedDataKey) {
                this.sessionDataKeys.set(sessionId, decryptedDataKey);
                await this.encryption.initializeSessions(new Map([[sessionId, decryptedDataKey]]));
            }

            // Add to shared sessions in storage
            storage.getState().addSharedSession({
                id: sessionId,
                seq: 0,
                createdAt,
                updatedAt: createdAt,
                active: false,
                activeAt: createdAt,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: createdAt,
                owner: sharedBy.id,
                ownerProfile: {
                    id: sharedBy.id,
                    username: sharedBy.username ?? '',
                    firstName: sharedBy.firstName ?? '',
                    lastName: sharedBy.lastName,
                    avatar: typeof sharedBy.avatar === 'string' ? sharedBy.avatar : null,
                },
                accessLevel,
            });

            // Refresh shared sessions to get metadata from server
            this.sharedSessionsSync.invalidate();

        } else if (updateData.body.t === 'session-share-updated') {
            log.log('Received session-share-updated');
            const { sessionId, accessLevel } = updateData.body;
            storage.getState().updateSharedSessionAccessLevel(sessionId, accessLevel);

        } else if (updateData.body.t === 'session-share-revoked') {
            log.log('Received session-share-revoked');
            const { sessionId } = updateData.body;
            storage.getState().removeSharedSession(sessionId);

        } else if (updateData.body.t === 'public-share-created') {
            log.log('Received public-share-created');
            const { sessionId } = updateData.body;
            // Optimistically mark session as shared
            const session = storage.getState().sessions[sessionId];
            if (session) {
                storage.getState().applySessions([{ ...session, isShared: true }]);
            }

        } else if (updateData.body.t === 'public-share-updated') {
            log.log('Received public-share-updated');

        } else if (updateData.body.t === 'public-share-deleted') {
            log.log('Received public-share-deleted');
            // Re-fetch sessions to determine accurate isShared state
            this.sessionsSync.invalidate();

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
                repeatKey: feedUpdate.repeatKey ?? null,
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
                if (!queue || queue.length === 0) {
                    this.sessionMessageUpdateQueues.delete(sessionId);
                    break;
                }

                const batch = queue.splice(0, queue.length);
                await this.applyNewMessageUpdates(sessionId, batch);
            }
        } finally {
            this.sessionMessageQueueRunning.delete(sessionId);
            if ((this.sessionMessageUpdateQueues.get(sessionId)?.length ?? 0) > 0) {
                void this.processSessionMessageQueue(sessionId);
            }
        }
    }

    private resetSessionMessageDispatch = (sessionId: string) => {
        const queue = this.sessionMessageDispatchQueues.get(sessionId);
        if (queue) {
            for (const task of queue) {
                task.resolve();
            }
            this.sessionMessageDispatchQueues.delete(sessionId);
        }

        // Don't clear an in-flight delay timer here: processSessionMessageDispatchQueue may
        // already be awaiting it. Let the timer resolve naturally, then generation-check skip
        // any stale work and continue with the fresh queue state.
        this.sessionMessageDispatchGeneration.set(sessionId, (this.sessionMessageDispatchGeneration.get(sessionId) ?? 0) + 1);
    }

    private enqueueSessionMessageDispatch = (
        sessionId: string,
        reason: string,
        run: () => Promise<void> | void,
    ): Promise<void> => {
        const generation = this.sessionMessageDispatchGeneration.get(sessionId) ?? 0;

        return new Promise<void>((resolve) => {
            const queue = this.sessionMessageDispatchQueues.get(sessionId);
            const task: SessionMessageDispatchTask = {
                reason,
                generation,
                run,
                resolve,
            };

            if (queue) {
                queue.push(task);
            } else {
                this.sessionMessageDispatchQueues.set(sessionId, [task]);
            }

            if (!this.sessionMessageDispatchRunning.has(sessionId)) {
                void this.processSessionMessageDispatchQueue(sessionId);
            }
        });
    }

    private waitForSessionMessageDispatchInterval = (sessionId: string) => {
        return new Promise<void>((resolve) => {
            const existingTimer = this.sessionMessageDispatchTimers.get(sessionId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const timer = setTimeout(() => {
                this.sessionMessageDispatchTimers.delete(sessionId);
                resolve();
            }, Sync.MESSAGE_LIST_DISPATCH_INTERVAL_MS);

            this.sessionMessageDispatchTimers.set(sessionId, timer);
        });
    }

    private processSessionMessageDispatchQueue = async (sessionId: string) => {
        if (this.sessionMessageDispatchRunning.has(sessionId)) {
            return;
        }

        this.sessionMessageDispatchRunning.add(sessionId);
        let first = true;

        try {
            while (true) {
                const queue = this.sessionMessageDispatchQueues.get(sessionId);
                const next = queue?.shift();
                if (!next) {
                    this.sessionMessageDispatchQueues.delete(sessionId);
                    break;
                }

                if (!first) {
                    await this.waitForSessionMessageDispatchInterval(sessionId);
                }
                first = false;

                const currentGeneration = this.sessionMessageDispatchGeneration.get(sessionId) ?? 0;
                if (next.generation !== currentGeneration) {
                    next.resolve();
                    continue;
                }

                try {
                    await next.run();
                } catch (error) {
                    console.error(`Failed to run session message dispatch (${next.reason}) for ${sessionId}:`, error);
                } finally {
                    next.resolve();
                }
            }
        } finally {
            this.sessionMessageDispatchRunning.delete(sessionId);
            const timer = this.sessionMessageDispatchTimers.get(sessionId);
            if (timer) {
                clearTimeout(timer);
                this.sessionMessageDispatchTimers.delete(sessionId);
            }
            if ((this.sessionMessageDispatchQueues.get(sessionId)?.length ?? 0) > 0) {
                void this.processSessionMessageDispatchQueue(sessionId);
            }
        }
    }

    private applyNewMessageUpdates = async (sessionId: string, updates: ApiUpdateContainer[]) => {
        if (updates.length === 0) {
            return;
        }

        // Get encryption
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) { // Should never happen
            console.error(`Session ${sessionId} not found`);
            this.fetchSessions(); // Just fetch sessions again
            return;
        }

        const preparedUpdates: PreparedNewMessageUpdate[] = [];

        for (const updateData of updates) {
            if (updateData.body.t !== 'new-message' || updateData.body.sid !== sessionId) {
                continue;
            }

            // Decrypt message (outside lock — idempotent and potentially slow)
            let lastMessage: NormalizedMessage | null = null;
            let isTaskComplete = false;
            let isTaskStarted = false;
            if (updateData.body.message) {
                const decrypted = await encryption.decryptMessage(updateData.body.message);
                if (decrypted) {
                    lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                    if (lastMessage) {
                        lastMessage.sentBy = decrypted.sentBy;
                        lastMessage.sentByName = decrypted.sentByName;
                        if (updateData.body.message.deliveryIssue?.status === 'error') {
                            lastMessage.deliveryError = updateData.body.message.deliveryIssue.reason || 'unknown_error';
                        }
                    }

                    // Check for task lifecycle events to update thinking state
                    // This ensures UI updates even if volatile activity updates are lost
                    const rawContent = decrypted.content as { role?: string; content?: { type?: string; data?: { type?: string } } } | null;
                    const contentType = rawContent?.content?.type;
                    const dataType = rawContent?.content?.data?.type;

                    // Debug logging to trace lifecycle events
                    if (dataType === 'task_complete' || dataType === 'turn_aborted' || dataType === 'task_started') {
                        console.log(`🔄 [Sync] Lifecycle event detected: contentType=${contentType}, dataType=${dataType}`);
                    }

                    isTaskComplete =
                        ((contentType === 'acp' || contentType === 'codex') &&
                            (dataType === 'task_complete' || dataType === 'turn_aborted'));

                    isTaskStarted =
                        ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started');

                    if (isTaskComplete || isTaskStarted) {
                        console.log(`🔄 [Sync] Updating thinking state: isTaskComplete=${isTaskComplete}, isTaskStarted=${isTaskStarted}`);
                    }
                }
            }

            if (lastMessage !== null || isTaskComplete || isTaskStarted) {
                preparedUpdates.push({
                    updateData,
                    lastMessage,
                    isTaskComplete,
                    isTaskStarted,
                });
            }
        }

        // Enqueue message-list updates through the unified dispatcher (serialized with fetchMessagesV3)
        if (preparedUpdates.length > 0) {
            const lock = this.getSessionMessageLock(sessionId);
            await lock.inLock(async () => {
                await this.enqueueSessionMessageDispatch(sessionId, `websocket:new-message-batch:${preparedUpdates.length}`, async () => {
                    const latestUpdate = preparedUpdates[preparedUpdates.length - 1].updateData;
                    let thinkingUpdate: boolean | null = null;
                    for (const prepared of preparedUpdates) {
                        if (prepared.isTaskStarted) {
                            thinkingUpdate = true;
                        }
                        if (prepared.isTaskComplete) {
                            thinkingUpdate = false;
                        }
                    }

                    // Update session metadata (updatedAt, seq, thinking state)
                    const session = storage.getState().sessions[sessionId];
                    if (session) {
                        this.applySessions([{
                            ...session,
                            updatedAt: latestUpdate.createdAt,
                            seq: latestUpdate.seq,
                            ...(thinkingUpdate === false ? { thinking: false } : {}),
                            ...(thinkingUpdate === true ? { thinking: true } : {})
                        }]);
                    } else {
                        this.fetchSessions();
                    }

                    const messagesToApply = preparedUpdates
                        .map((prepared) => prepared.lastMessage)
                        .filter((message): message is NormalizedMessage => message !== null);

                    for (const message of messagesToApply) {
                        // If this is an echo of our own send, invoke the pending callback
                        // (e.g. clear input) before the message appears in the list.
                        if (message.localId) {
                            const pending = this.pendingSendCallbacks.get(message.localId);
                            if (pending) {
                                this.pendingSendCallbacks.delete(message.localId);
                                pending();
                            }
                        }
                    }

                    if (messagesToApply.length > 0) {
                        console.log(`🔄 Sync: Applying websocket batch (${messagesToApply.length} messages) for session ${sessionId}`);
                        this.applyMessages(sessionId, messagesToApply);

                        let hasMutableTool = false;
                        for (const message of messagesToApply) {
                            if (message.role === 'agent' && message.content[0] && message.content[0].type === 'tool-result') {
                                hasMutableTool = storage.getState().isMutableToolCall(sessionId, message.content[0].tool_use_id);
                                if (hasMutableTool) {
                                    break;
                                }
                            }
                        }
                        if (hasMutableTool) {
                            gitStatusSync.invalidate(sessionId);
                        }
                    }
                });
            });
        }

        // Ping session once per websocket batch
        this.onSessionVisible(sessionId);
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        // log.log(`🔄 Flushing activity updates for ${updates.size} sessions - acquiring lock`);

        const sessions: Session[] = [];
        const recoveredSessionIds: string[] = [];
        const state = storage.getState();

        for (const [sessionId, update] of updates) {
            const session = state.sessions[sessionId];
            if (session) {
                if (shouldInvalidateGitStatusOnActivityTransition(session.active, update.active)) {
                    recoveredSessionIds.push(sessionId);
                }
                sessions.push({
                    ...session,
                    active: update.active,
                    activeAt: update.activeAt,
                    thinking: update.thinking ?? false,
                    thinkingAt: update.activeAt // Always use activeAt for consistency
                });
            } else if (state.sharedSessions[sessionId]) {
                // Update shared session activity
                state.updateSharedSessionActivity(
                    sessionId,
                    update.active,
                    update.activeAt,
                    update.thinking ?? false
                );
            }
        }

        if (sessions.length > 0) {
            // console.log('flushing activity updates ' + sessions.length);
            this.applySessions(sessions);
            for (const sessionId of recoveredSessionIds) {
                gitStatusSync.invalidate(sessionId);
            }
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
            this.resetSessionMessageDispatch(sessionId);
            this.sessionMessageUpdateQueues.delete(sessionId);
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

        if (updateData.type === 'message-delivery-error') {
            storage.getState().setMessageDeliveryError(
                updateData.sid,
                updateData.messageId,
                updateData.localId ?? null,
                updateData.error
            );
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
            } else if (updateData.active) {
                // Machine not in store yet (e.g. just registered) — re-fetch all machines
                this.machinesSync.invalidate();
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
