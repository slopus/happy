import Constants from 'expo-constants';
import { apiSocket } from '@/sync/apiSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { ApiEncryption } from '@/sync/apiEncryption';
import { storage } from './storage';
import { ApiEphemeralUpdateSchema, ApiMessage, ApiUpdateContainerSchema } from './apiTypes';
import { DecryptedMessage, Session } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { registerPushToken } from './apiPush';
import { Platform, AppState } from 'react-native';
import { NormalizedMessage, normalizeRawMessage, RawRecord } from './typesRaw';
import { decodeBase64 } from '@/auth/base64';
import { SessionEncryption } from './apiSessionEncryption';
import { applySettings, Settings, settingsDefaults, settingsParse } from './settings';
import { loadPendingSettings, savePendingSettings } from './persistence';
import { initializeTracking, tracking } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { RevenueCat, LogLevel, PaywallResult } from './revenueCat';
import { trackPaywallPresented, trackPaywallPurchased, trackPaywallCancelled, trackPaywallRestored, trackPaywallError } from '@/track';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';

class Sync {

    encryption!: ApiEncryption;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private sessionEncryption = new Map<string, SessionEncryption>();
    private sessionReceivedMessages = new Map<string, Set<string>>();
    private settingsSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    revenueCatInitialized = false;

    constructor() {
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.purchasesSync = new InvalidateSync(this.syncPurchases);
        
        // Listen for app state changes to refresh purchases
        AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                this.purchasesSync.invalidate();
            }
        });
    }

    async create(credentials: AuthCredentials, encryption: ApiEncryption) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await purchases sync to have fresh purchases
        await this.purchasesSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: ApiEncryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
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
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.purchasesSync.invalidate();

        // Register push token
        this.registerPushToken();
    }


    onSessionVisible = (sessionId: string) => {
        let ex = this.messagesSync.get(sessionId);
        if (!ex) {
            ex = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, ex);
        }
        ex.invalidate();
    }

    sendMessage(sessionId: string, text: string) {

        // Get encryption
        const encryption = this.sessionEncryption.get(sessionId);
        if (!encryption) { // Should never happen
            console.error(`Session ${sessionId} not found`);
            return;
        }

        // Generate local ID
        const localId = randomUUID();

        // Create user message content
        const content: RawRecord = {
            role: 'user',
            content: {
                type: 'text',
                text
            }
        };
        const encryptedRawRecord = encryption.encryptRawRecord(content);

        // Add to messages
        storage.getState().applyMessages(sessionId, [{
            id: localId,
            createdAt: Date.now(),
            seq: null,
            localId: localId,
            content
        }]);

        // Send message
        apiSocket.send('message', { sid: sessionId, message: encryptedRawRecord, localId });
    }

    applySettings = (delta: Partial<Settings>) => {
        console.log('applySettings', delta);
        storage.getState().applySettingsLocal(delta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...delta };
        savePendingSettings(this.pendingSettings);
        console.log('pendingSettings', this.pendingSettings);

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
            agentState: string | null;
            active: boolean;
            activeAt: number;
            createdAt: number;
            updatedAt: number;
            lastMessage: ApiMessage | null;
        }>;

        // Decrypt sessions
        let decryptedSessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[] = [];
        for (const session of sessions) {

            //
            // Load decrypted metadata
            //

            let metadata = this.encryption.decryptMetadata(session.metadata);

            //
            // Create encryption
            //

            let encryption: SessionEncryption;
            if (!this.sessionEncryption.has(session.id)) {
                if (metadata?.encryption) {
                    encryption = new SessionEncryption(session.id, this.encryption.secretKey, { type: 'aes-gcm-256', key: decodeBase64(metadata.encryption.key) });
                } else {
                    encryption = new SessionEncryption(session.id, this.encryption.secretKey, { type: 'libsodium' });
                }
                this.sessionEncryption.set(session.id, encryption);
            } else {
                encryption = this.sessionEncryption.get(session.id)!;
            }

            //
            // Decrypt last message
            //

            let lastMessage: NormalizedMessage | null = null;
            if (session.lastMessage) {
                const decrypted = encryption.decryptMessage(session.lastMessage);
                if (decrypted) {
                    lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                }
            }

            //
            // Decrypt agent state
            //

            let agentState = this.encryption.decryptAgentState(session.agentState);

            //
            // Put it all together
            //

            const processedSession = {
                ...session,
                thinking: false,
                thinkingAt: 0,
                metadata,
                agentState,
                lastMessage
            };
            decryptedSessions.push(processedSession);
        }

        // Apply to storage
        storage.getState().applySessions(decryptedSessions);
    }

    private syncSettings = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        // Apply pending settings
        if (Object.keys(this.pendingSettings).length > 0) {

            while (true) {
                let version = storage.getState().settingsVersion;
                let settings = applySettings(storage.getState().settings, this.pendingSettings);

                console.log('applyPendingSettings', this.pendingSettings);
                const response = await fetch(`${API_ENDPOINT}/v1/account/settings`, {
                    method: 'POST',
                    body: JSON.stringify({
                        settings: this.encryption.encryptRaw(settings),
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
                    break;
                }
                if (data.error === 'version-mismatch') {
                    let parsedSettings: Settings;
                    if (data.currentSettings) {
                        parsedSettings = settingsParse(this.encryption.decryptRaw(data.currentSettings));
                    } else {
                        parsedSettings = { ...settingsDefaults };
                    }

                    // Log
                    console.log('settings', JSON.stringify({
                        settings: parsedSettings,
                        version: data.currentVersion
                    }));

                    // Apply settings to storage
                    storage.getState().applySettings(parsedSettings, data.currentVersion);

                    // Sync PostHog opt-out state with settings
                    if (tracking) {
                        if (parsedSettings.analyticsOptOut) {
                            tracking.optOut();
                        } else {
                            tracking.optIn();
                        }
                    }

                } else {
                    throw new Error(`Failed to sync settings: ${data.error}`);
                }

                // Wait 1 second
                await new Promise(resolve => setTimeout(resolve, 1000));
                break;
            }
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
            parsedSettings = settingsParse(this.encryption.decryptRaw(data.settings));
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

    private fetchMessages = async (sessionId: string) => {

        // Get encryption
        const encryption = this.sessionEncryption.get(sessionId);
        if (!encryption) { // Should never happen
            console.error(`Session ${sessionId} not found`);
            return;
        }

        // Request
        const response = await apiSocket.request(`/v1/sessions/${sessionId}/messages`);
        const data = await response.json();

        // Collect existing messages
        let eixstingMessages = this.sessionReceivedMessages.get(sessionId);
        if (!eixstingMessages) {
            eixstingMessages = new Set<string>();
            this.sessionReceivedMessages.set(sessionId, eixstingMessages);
        }

        // Decrypt messages
        let start = Date.now();
        let messages: DecryptedMessage[] = [];
        for (const msg of [...data.messages as ApiMessage[]].reverse()) {
            if (eixstingMessages.has(msg.id)) {
                continue;
            }
            let m = encryption.decryptMessage(msg);
            if (m) {
                eixstingMessages.add(m.id);
                messages.push(m);
            }
        }
        console.log('Decrypted messages in', Date.now() - start, 'ms');
        // console.log('messages', JSON.stringify(messages));

        // Apply to storage
        storage.getState().applyMessages(sessionId, messages);
    }

    private registerPushToken = async () => {
        // Only register on mobile platforms
        if (Platform.OS === 'web') {
            return;
        }

        try {
            // Request permission
            const { status: existingStatus } = await Notifications.getPermissionsAsync();
            let finalStatus = existingStatus;

            if (existingStatus !== 'granted') {
                const { status } = await Notifications.requestPermissionsAsync();
                finalStatus = status;
            }

            if (finalStatus !== 'granted') {
                console.log('Failed to get push token for push notification!');
                return;
            }

            // Get push token
            const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
            const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });

            // Register with server
            await registerPushToken(this.credentials, tokenData.data);
            console.log('Push token registered successfully');
        } catch (error) {
            console.error('Failed to register push token:', error);
        }
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));

        // Subscribe to connection state changes
        apiSocket.onReconnected(() => {
            this.sessionsSync.invalidate();
            const sessionsData = storage.getState().sessionsData;
            if (sessionsData) {
                for (const item of sessionsData) {
                    if (typeof item !== 'string') {
                        this.messagesSync.get(item.id)?.invalidate();
                    }
                }
            }
        });

        // Recalculate online sessions every second (for 30-second disconnect timeout)
        setInterval(() => {
            storage.getState().recalculateOnline();
        }, 1000);
    }

    private handleUpdate = (update: unknown) => {
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid update received:', validatedUpdate.error);
            console.error('Invalid update received:', update);
            return;
        }
        const updateData = validatedUpdate.data;

        if (updateData.body.t === 'new-message') {

            // Get encryption
            const encryption = this.sessionEncryption.get(updateData.body.sid);
            if (!encryption) { // Should never happen
                console.error(`Session ${updateData.body.sid} not found`);
                this.fetchSessions(); // Just fetch sessions again
                return;
            }

            // Decrypt message
            let lastMessage: NormalizedMessage | null = null;
            if (updateData.body.message) {
                const decrypted = encryption.decryptMessage(updateData.body.message);
                if (decrypted) {
                    lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);

                    // Update session
                    const session = storage.getState().sessions[updateData.body.sid];
                    if (session) {
                        storage.getState().applySessions([{
                            ...session,
                            lastMessage,
                            updatedAt: updateData.createdAt,
                            seq: updateData.seq
                        }])
                    } else {
                        // Fetch sessions again if we don't have this session
                        this.fetchSessions();
                    }

                    // Update messages
                    if (lastMessage) {
                        storage.getState().applyMessages(updateData.body.sid, [decrypted]);
                    }
                }
            }

            // Ping session
            this.onSessionVisible(updateData.body.sid);

        } else if (updateData.body.t === 'new-session') {
            this.fetchSessions(); // Just fetch sessions again
        } else if (updateData.body.t === 'update-session') {
            const session = storage.getState().sessions[updateData.body.id];
            if (session) {
                storage.getState().applySessions([{
                    ...session,
                    agentState: this.encryption.decryptAgentState(updateData.body.agentState?.value),
                    metadata: updateData.body.metadata ?
                        this.encryption.decryptMetadata(updateData.body.metadata.value) :
                        session.metadata,
                    updatedAt: updateData.createdAt,
                    seq: updateData.seq
                }])
            }
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid ephemeral update received:', validatedUpdate.error);
            console.error('Invalid ephemeral update received:', update);
            return;
        }
        const updateData = validatedUpdate.data;

        // Only process activity updates
        if (updateData.type !== 'activity') {
            return;
        }

        const session = storage.getState().sessions[updateData.id];
        if (session) {
            storage.getState().applySessions([{
                ...session,
                active: updateData.active,
                activeAt: updateData.activeAt,
                thinking: updateData.thinking ?? false,
                thinkingAt: updateData.activeAt // Always use activeAt for consistency
            }])
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
    const encryption = await ApiEncryption.create(credentials.secret);

    // Initialize tracking
    initializeTracking(encryption.anonID);

    // Initialize socket connection
    const API_ENDPOINT = getServerUrl();
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}