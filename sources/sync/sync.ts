import Constants from 'expo-constants';
import { 
    MobileApiClient, 
    MobileSyncCallbacks,
    ConsoleLogger,
    Session as ApiSession,
    Machine as ApiMachine,
    DecryptedMessageContent,
    Settings as ApiSettings,
    encodeBase64,
    decodeBase64,
    encrypt,
    decrypt,
    generateSecretKey
} from '@happy/api-client';
import { deriveKey } from '@/encryption/deriveKey';
import { encodeHex } from '@/encryption/hex';
import { AuthCredentials } from '@/auth/tokenStorage';
import { storage } from './storage';
import { DecryptedMessage, Session, Machine } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { registerPushToken } from './apiPush';
import { Platform, AppState } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { NormalizedMessage, normalizeRawMessage, RawRecord } from './typesRaw';
import { applySettings, Settings, settingsDefaults, settingsParse } from './settings';
import { loadPendingSettings, savePendingSettings } from './persistence';
import { initializeTracking, tracking } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { RevenueCat, RevenueCatInterface, LogLevel, PaywallResult } from './revenueCat';
import { trackPaywallPresented, trackPaywallPurchased, trackPaywallCancelled, trackPaywallRestored, trackPaywallError } from '@/track';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { isMutableTool } from '@/components/tools/knownTools';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { Message } from './typesMessage';
import { apiSocketRpc } from './apiSocketRpc';

class Sync {
    private mobileClient!: MobileApiClient;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    private secretKey!: Uint8Array;
    private messagesSync = new Map<string, InvalidateSync>();
    private sessionReceivedMessages = new Map<string, Set<string>>();
    private purchasesSync: InvalidateSync;
    private activityAccumulator: ActivityUpdateAccumulator;
    encryption: any; // Expose for dev tools
    
    // Methods needed by other parts of app
    refreshMachines = () => {
        // Machines are refreshed automatically by MobileApiClient
    }
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    revenueCatInitialized = false;

    constructor() {
        this.purchasesSync = new InvalidateSync(async () => await this.fetchPurchases());
        this.activityAccumulator = new ActivityUpdateAccumulator((update: any) => {});
    }

    async init(credentials: AuthCredentials) {
        this.credentials = credentials;
        
        // Get server URL from config
        const serverUrl = getServerUrl();
        
        // Decode secret key
        this.secretKey = decodeBase64(credentials.secret, 'base64url');
        if (this.secretKey.length !== 32) {
            throw new Error(`Invalid secret key length: ${this.secretKey.length}, expected 32`);
        }
        
        // Derive anonymous ID for analytics (matching original implementation)
        this.anonID = encodeHex((await deriveKey(this.secretKey, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();
        
        // Create callbacks for MobileApiClient
        const callbacks: MobileSyncCallbacks = {
            encryptToBase64: (data: unknown, secret: Uint8Array): string => {
                return encodeBase64(encrypt(data, secret));
            },
            
            decryptFromBase64: (data: string, secret: Uint8Array): unknown => {
                return decrypt(decodeBase64(data), secret);
            },
            
            applySessions: (sessions: ApiSession[]) => {
                // Convert API sessions to storage sessions
                const storageSessions = sessions.map(s => this.convertApiSessionToStorage(s));
                storage.getState().applySessions(storageSessions);
            },
            
            applyMessages: (sessionId: string, messages: DecryptedMessageContent[]) => {
                // Convert API messages to normalized messages for storage
                const normalizedMessages: NormalizedMessage[] = [];
                messages.forEach((msg, idx) => {
                    const messageId = randomUUID();
                    const rawRecord: RawRecord = msg as RawRecord;
                    const normalized = normalizeRawMessage(messageId, messageId, Date.now() + idx, rawRecord);
                    if (normalized) {
                        normalizedMessages.push(normalized);
                    }
                });
                storage.getState().applyMessages(sessionId, normalizedMessages);
            },
            
            applyMachines: (machines: ApiMachine[]) => {
                // Convert API machines to storage machines
                const storageMachines = machines.map(m => this.convertApiMachineToStorage(m));
                storage.getState().applyMachines(storageMachines);
            },
            
            applySettings: (settings: ApiSettings, version: number) => {
                // Apply settings through existing settings system
                const parsedSettings = settingsParse(settings);
                storage.getState().applySettings(parsedSettings, version);
                
                // Clear pending settings
                this.pendingSettings = {};
                savePendingSettings({});
                
                // Sync analytics opt-out
                if (tracking) {
                    if (parsedSettings.analyticsOptOut) {
                        tracking.optOut();
                    } else {
                        tracking.optIn();
                    }
                }
            },
            
            onAppStateChange: (handler: (state: string) => void) => {
                const sub = AppState.addEventListener('change', handler);
                return () => sub.remove();
            },
            
            getPushToken: async () => {
                if (Platform.OS === 'web') return null;
                
                try {
                    const { status } = await Notifications.getPermissionsAsync();
                    if (status !== 'granted') return null;
                    
                    const token = await Notifications.getExpoPushTokenAsync({
                        projectId: Constants.expoConfig?.extra?.eas?.projectId
                    });
                    return token.data;
                } catch (error) {
                    console.log('Failed to get push token:', error);
                    return null;
                }
            },
            
            log: (message: string) => console.log(message)
        };
        
        // Create MobileApiClient
        this.mobileClient = new MobileApiClient({
            endpoint: serverUrl,
            token: credentials.token,
            secret: this.secretKey,
            callbacks,
            logger: new ConsoleLogger()
        });
        
        // Connect and start syncing
        await this.mobileClient.connect();
        
        // Initialize RPC wrapper with the socket
        // @ts-ignore - getSocket method exists but not in types yet
        const socket = (this.mobileClient as any).getSocket?.();
        if (socket) {
            apiSocketRpc.initialize(socket, this.secretKey);
        }
        
        // Store encryption for dev tools
        this.encryption = { secretKey: this.secretKey };
        
        // Initialize tracking with user ID from token
        const serverID = parseToken(credentials.token);
        this.serverID = serverID;
        // Use anonymous ID for tracking
        initializeTracking(this.anonID);
        
        // Initialize RevenueCat if on mobile
        if (Platform.OS !== 'web') {
            this.initRevenueCat(serverID);
        }
        
        // Initial sync happens automatically through MobileApiClient
    }

    private convertApiSessionToStorage(apiSession: ApiSession): Session {
        // Convert from API Session type to storage Session type
        // API Session provides these fields directly
        return {
            id: apiSession.id,
            seq: apiSession.seq,
            createdAt: apiSession.createdAt,
            updatedAt: apiSession.updatedAt,
            metadata: apiSession.metadata,
            metadataVersion: apiSession.metadataVersion,
            agentState: apiSession.agentState,
            agentStateVersion: apiSession.agentStateVersion,
            // Mobile-specific fields with proper defaults
            active: apiSession.active ?? false,
            activeAt: apiSession.activeAt ?? 0,
            thinking: false,
            thinkingAt: 0,
            presence: "online"
        };
    }

    private convertApiMessageToStorage(apiMsg: DecryptedMessageContent, sessionId: string, index: number): DecryptedMessage {
        // Convert from API message to storage message
        const messageId = randomUUID();
        return {
            id: messageId,
            localId: messageId,
            sessionId,
            content: apiMsg,
            createdAt: Date.now(),
            seq: index
        } as DecryptedMessage;
    }

    private convertApiMachineToStorage(apiMachine: ApiMachine): Machine {
        // Direct mapping as types should be compatible
        return apiMachine as Machine;
    }

    onSessionVisible = (sessionId: string) => {
        // Notify the API client about session visibility
        this.mobileClient.onSessionVisible(sessionId);
        
        // Create messages sync if doesn't exist
        if (!this.messagesSync.has(sessionId)) {
            const sync = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, sync);
        }
        this.messagesSync.get(sessionId)?.invalidate();
        
        // Also invalidate git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();
        
        // Notify voice assistant about session visibility
        const session = storage.getState().sessions[sessionId];
        if (session) {
            voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
        }
    }

    private async fetchMessages(sessionId: string) {
        // Messages are fetched automatically by MobileApiClient
        // This is kept for compatibility but the actual fetching happens in the client
    }

    sendMessage(sessionId: string, text: string) {
        const session = storage.getState().sessions[sessionId];
        if (!session) {
            console.error(`Session ${sessionId} not found in storage`);
            return;
        }

        // Read permission mode and model mode from session state
        const permissionMode = session.permissionMode || 'default';
        const modelMode = session.modelMode || 'default';

        // Determine sentFrom based on platform
        let sentFrom: string;
        if (Platform.OS === 'web') {
            sentFrom = 'web';
        } else if (Platform.OS === 'android') {
            sentFrom = 'android';
        } else if (Platform.OS === 'ios') {
            sentFrom = isRunningOnMac() ? 'mac' : 'ios';
        } else {
            sentFrom = 'web'; // fallback
        }

        // Send message through API client
        this.mobileClient.sendMessage(sessionId, text, {
            sentFrom,
            permissionMode,
            modelMode: modelMode === 'default' ? undefined : modelMode
        });
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

        // Sync settings through API client
        this.mobileClient.updateSettings(delta as ApiSettings);
    }

    refreshPurchases = () => {
        this.purchasesSync.invalidate();
    }

    private async fetchPurchases() {
        if (!this.revenueCatInitialized || Platform.OS === 'web') {
            return;
        }

        try {
            const customerInfo = await RevenueCat.getCustomerInfo();
            storage.getState().applyPurchases(customerInfo);
        } catch (error) {
            console.log('Failed to fetch purchases:', error);
        }
    }

    purchaseProduct = async (productId: string): Promise<{ success: boolean; error?: string }> => {
        try {
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            const products = await RevenueCat.getProducts([productId]);
            if (products.length === 0) {
                return { success: false, error: `Product '${productId}' not found` };
            }

            const product = products[0];
            const { customerInfo } = await RevenueCat.purchaseStoreProduct(product);
            storage.getState().applyPurchases(customerInfo);

            return { success: true };
        } catch (error: any) {
            if (error.userCancelled) {
                return { success: false, error: 'Purchase cancelled' };
            }
            return { success: false, error: error.message || 'Purchase failed' };
        }
    }

    getOfferings = async (): Promise<{ success: boolean; offerings?: any; error?: string }> => {
        try {
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            const offerings = await RevenueCat.getOfferings();
            return { success: true, offerings };
        } catch (error: any) {
            return { success: false, error: error.message || 'Failed to get offerings' };
        }
    }

    presentPaywall = async (): Promise<PaywallResult> => {
        try {
            if (!this.revenueCatInitialized) {
                return PaywallResult.NOT_INITIALIZED;
            }

            trackPaywallPresented();
            const presentPaywall = (RevenueCat as RevenueCatInterface).presentPaywall;
            const result = presentPaywall ? await presentPaywall() : PaywallResult.NOT_PRESENTED;

            if (result === PaywallResult.PURCHASED) {
                trackPaywallPurchased();
                this.refreshPurchases();
            } else if (result === PaywallResult.CANCELLED) {
                trackPaywallCancelled();
            } else if (result === PaywallResult.RESTORED) {
                trackPaywallRestored();
                this.refreshPurchases();
            } else if (result === PaywallResult.ERROR) {
                trackPaywallError('Paywall presentation error');
            }

            return result;
        } catch (error: any) {
            const errorMessage = error.message ?? 'Unknown error';
            trackPaywallError(errorMessage);
            console.error('Failed to present paywall:', error);
            return PaywallResult.ERROR;
        }
    }

    restorePurchases = async (): Promise<{ success: boolean; error?: string }> => {
        try {
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            await RevenueCat.syncPurchases();
            const customerInfo = await RevenueCat.getCustomerInfo();
            storage.getState().applyPurchases(customerInfo);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message || 'Failed to restore purchases' };
        }
    }

    private initRevenueCat(userId: string) {
        try {
            if (Platform.OS === 'ios') {
                RevenueCat.configure({
                    apiKey: config.revenueCat.iosApiKey,
                    appUserID: userId
                });
            } else if (Platform.OS === 'android') {
                RevenueCat.configure({
                    apiKey: config.revenueCat.androidApiKey,
                    appUserID: userId
                });
            }

            RevenueCat.setLogLevel(LogLevel.DEBUG);
            this.revenueCatInitialized = true;
            this.refreshPurchases();
        } catch (error) {
            console.log('Failed to initialize RevenueCat:', error);
        }
    }

    disconnect() {
        this.mobileClient?.disconnect();
    }
}

export const sync = new Sync();

// Legacy exports for compatibility
export const syncCreate = sync.init.bind(sync);
export const syncRestore = sync.init.bind(sync);