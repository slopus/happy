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
} from 'happy-api-client';
import { deriveKey } from '@/encryption/deriveKey';
import { encodeHex } from '@/encryption/hex';
import { AuthCredentials } from '@/auth/tokenStorage';
import { storage } from './storage';
import { DecryptedMessage, Session, Machine } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
// import { SessionListViewDataRebuilder } from './reducer/rebuilders';
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
import { EncryptionCache } from './encryptionCache';
import { randomUUID } from 'expo-crypto';

class Sync {
    private mobileClient!: MobileApiClient;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    private secretKey!: Uint8Array;
    public encryptionCache = new EncryptionCache();
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
                if (normalizedMessages.length > 0) {
                    this.applyMessages(sessionId, normalizedMessages);
                }
            },
            
            applyMachines: (machines: ApiMachine[]) => {
                // Convert API machines to storage machines
                const storageMachines: Machine[] = machines.map(m => ({
                    id: m.id,
                    seq: m.seq,
                    createdAt: m.createdAt,
                    updatedAt: m.updatedAt,
                    active: m.active,
                    activeAt: m.activeAt,
                    metadata: m.metadata,
                    metadataVersion: m.metadataVersion,
                    daemonState: m.daemonState,
                    daemonStateVersion: m.daemonStateVersion
                }));
                storage.getState().applyMachines(storageMachines, true);
            },
            
            applySettings: (settings: ApiSettings | null, version: number) => {
                const parsedSettings = settings ? settingsParse(settings) : { ...settingsDefaults };
                storage.getState().applySettings(parsedSettings, version);
                
                // Sync PostHog opt-out state with settings
                if (tracking) {
                    if (parsedSettings.analyticsOptOut) {
                        tracking.optOut();
                    } else {
                        tracking.optIn();
                    }
                }
            },
            
            onSessionUpdate: (sessionId: string, agentState: any, metadata: any) => {
                const session = storage.getState().sessions[sessionId];
                if (session && (agentState || metadata)) {
                    gitStatusSync.invalidate(sessionId);
                    
                    // Check for new permission requests
                    if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
                        const requestIds = Object.keys(agentState.requests);
                        const firstRequest = agentState.requests[requestIds[0]];
                        const toolName = firstRequest?.tool;
                        voiceHooks.onPermissionRequested(sessionId, requestIds[0], toolName, firstRequest?.arguments);
                    }
                }
            },
            
            onConnectionChange: (connected: boolean) => {
                storage.getState().setSocketStatus(connected ? 'connected' : 'disconnected');
                
                if (connected) {
                    // Invalidate git status for all sessions on reconnection
                    const sessionsData = storage.getState().sessionsData;
                    if (sessionsData) {
                        for (const item of sessionsData) {
                            if (typeof item !== 'string') {
                                this.messagesSync.get(item.id)?.invalidate();
                                gitStatusSync.invalidate(item.id);
                            }
                        }
                    }
                }
            }
        };
        
        // Create and initialize MobileApiClient with encryptionCache
        this.mobileClient = new MobileApiClient({
            endpoint: serverUrl,
            token: credentials.token,
            secret: this.secretKey,
            callbacks,
            logger: new ConsoleLogger()
        });
        
        // Connect to server
        await this.mobileClient.connect();
        
        // Store encryption helper for compatibility
        this.encryption = {
            secretKey: this.secretKey,
            encryptRaw: (data: unknown) => encodeBase64(encrypt(data, this.secretKey)),
            decryptRaw: (data: string) => decrypt(decodeBase64(data), this.secretKey),
            clearSessionCache: (sessionId: string) => this.encryptionCache.clearSessionCache(sessionId),
            clearAllCache: () => this.encryptionCache.clearAll ? this.encryptionCache.clearAll() : undefined,
            getCacheStats: () => this.encryptionCache.getStats()
        };
        
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
        // Mark as ready after initial load
        storage.getState().applyReady();
    }

    private convertApiSessionToStorage(apiSession: ApiSession): Session {
        // Convert from API Session type to storage Session type
        // API Session provides these fields directly
        return {
            id: apiSession.id,
            seq: apiSession.seq,
            createdAt: apiSession.createdAt,
            updatedAt: apiSession.updatedAt,
            active: apiSession.active ?? false,
            activeAt: apiSession.activeAt ?? Date.now(),
            metadata: apiSession.metadata,
            metadataVersion: apiSession.metadataVersion,
            agentState: apiSession.agentState,
            agentStateVersion: apiSession.agentStateVersion,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline' as any,
            draft: null,
            permissionMode: null,
            modelMode: null
        };
    }

    private applyMessages(sessionId: string, messages: NormalizedMessage[]) {
        storage.getState().applyMessages(sessionId, messages);
        
        // Check for mutable tool calls
        for (const msg of messages) {
            if (msg.role === 'agent' && msg.content[0]?.type === 'tool-result') {
                const hasMutableTool = storage.getState().isMutableToolCall(sessionId, msg.content[0].tool_use_id);
                if (hasMutableTool) {
                    gitStatusSync.invalidate(sessionId);
                }
            }
        }
    }

    private fetchPurchases = async () => {
        // This will be called by purchasesSync InvalidateSync
        if (!this.revenueCatInitialized) {
            return;
        }
        
        try {
            await RevenueCat.syncPurchases();
            const customerInfo = await RevenueCat.getCustomerInfo();
            storage.getState().applyPurchases(customerInfo);
        } catch (error) {
            console.error('Failed to fetch purchases:', error);
        }
    }

    refreshPurchases = () => {
        this.purchasesSync.invalidate();
    }

    async presentPaywall(): Promise<PaywallResult> {
        try {
            if (!this.revenueCatInitialized) {
                console.error('RevenueCat not initialized');
                return PaywallResult.ERROR;
            }

            // Track that paywall was presented
            trackPaywallPresented();

            const paywallResult = await RevenueCat.presentPaywall();

            // Handle the result
            switch (paywallResult) {
                case PaywallResult.PURCHASED:
                    trackPaywallPurchased();
                    
                    // Fetch latest customer info to update entitlements
                    const customerInfo = await RevenueCat.getCustomerInfo();
                    storage.getState().applyPurchases(customerInfo);
                    
                    return PaywallResult.PURCHASED;
                    
                case PaywallResult.RESTORED:
                    trackPaywallRestored();
                    
                    // Fetch latest customer info after restore
                    const restoredInfo = await RevenueCat.getCustomerInfo();
                    storage.getState().applyPurchases(restoredInfo);
                    
                    return PaywallResult.RESTORED;
                    
                case PaywallResult.CANCELLED:
                    trackPaywallCancelled();
                    return PaywallResult.CANCELLED;
                    
                case PaywallResult.ERROR:
                default:
                    trackPaywallError('Unknown error');
                    return PaywallResult.ERROR;
            }
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

    purchaseProduct = async (productId: string): Promise<{ success: boolean; error?: string }> => {
        try {
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Get product first, then purchase it
            const products = await RevenueCat.getProducts([productId]);
            if (products && products.length > 0) {
                const purchaseResult = await RevenueCat.purchaseStoreProduct(products[0]);
                if (purchaseResult) {
                    // Refresh customer info after purchase
                    const customerInfo = await RevenueCat.getCustomerInfo();
                    storage.getState().applyPurchases(customerInfo);
                    return { success: true };
                }
            }
            return { success: false, error: 'Product not found' };
        } catch (error: any) {
            return { success: false, error: error.message || 'Failed to purchase product' };
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

    onSessionVisible(sessionId: string) {
        // Initialize messages sync for this session if not already done
        if (!this.messagesSync.has(sessionId)) {
            this.messagesSync.set(sessionId, new InvalidateSync(async () => {
                // Messages are fetched automatically by MobileApiClient
            }));
        }
    }

    sendDraft(sessionId: string, draft: string | null) {
        // TODO: Implement draft sending through RPC or REST API
        // this.mobileClient.sendSessionUpdate(sessionId, { draft });
    }

    async sendMessage(sessionId: string, message: Message) {
        // Encrypt and send message through socket
        const encrypted = this.encryption.encryptRaw(message);
        if (this.mobileClient.getSocket()) {
            this.mobileClient.getSocket()!.emit('message', { 
                sid: sessionId, 
                message: encrypted 
            });
        }
    }

    updateSettings(settings: Partial<Settings>) {
        Object.assign(this.pendingSettings, settings);
        savePendingSettings(this.pendingSettings);
        this.mobileClient.updateSettings(settings);
    }

    disconnect() {
        this.mobileClient?.disconnect();
    }

    // Get the mobile API client for RPC operations
    getMobileClient() {
        return this.mobileClient;
    }

    /**
     * Clear cache for a specific session (useful when session is deleted)
     */
    clearSessionCache(sessionId: string): void {
        this.encryptionCache.clearSessionCache(sessionId);
    }

    /**
     * Clear all cached data (useful on logout)
     */
    clearAllCache(): void {
        if (this.encryptionCache.clearAll) {
            this.encryptionCache.clearAll();
        }
    }

    /**
     * Get cache statistics for debugging performance
     */
    getCacheStats() {
        return this.encryptionCache.getStats();
    }
}

export const sync = new Sync();

// Legacy exports for compatibility
export const syncCreate = sync.init.bind(sync);
export const syncRestore = sync.init.bind(sync);