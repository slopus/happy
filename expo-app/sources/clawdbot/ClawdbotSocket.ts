import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import type {
    ClawdbotGatewayConfig,
    ClawdbotFrame,
    ClawdbotConnectParams,
    ClawdbotHelloOk,
    ClawdbotSession,
    ClawdbotChatMessage,
    ClawdbotChatHistoryResult,
    ClawdbotSessionsListResult,
    ClawdbotChatSendResult,
    ClawdbotClientId,
    ClawdbotClientMode,
} from './clawdbotTypes';
import {
    loadOrCreateDeviceIdentity,
    loadDeviceAuthToken,
    storeDeviceAuthToken,
    buildDeviceAuthPayload,
    signPayload,
    getPublicKeyBase64Url,
} from './deviceIdentity';

const PROTOCOL_VERSION = 3;

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
};

export type ClawdbotConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'pairing_required'
    | 'error';

export type ClawdbotEventHandler = (event: string, payload: unknown) => void;
export type ClawdbotStatusHandler = (status: ClawdbotConnectionStatus, error?: string, details?: { pairingRequestId?: string }) => void;

/**
 * ClawdbotSocket - Raw WebSocket client for Clawdbot Gateway
 *
 * Implements the Clawdbot gateway protocol (req/res/event frames)
 * for direct communication with a user's local or remote gateway.
 * Uses device identity for secure authentication with pairing flow.
 */
class ClawdbotSocketClass {
    private ws: WebSocket | null = null;
    private config: ClawdbotGatewayConfig | null = null;
    private pending = new Map<string, PendingRequest>();
    private status: ClawdbotConnectionStatus = 'disconnected';
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private mainSessionKey: string | null = null;
    private serverHost: string | null = null;
    private pairingRequestId: string | null = null;
    private deviceId: string | null = null;
    private connectNonce: string | null = null;
    private connectSent = false;

    // Listeners
    private statusListeners = new Set<ClawdbotStatusHandler>();
    private eventListeners = new Set<ClawdbotEventHandler>();

    // Public getters
    getStatus(): ClawdbotConnectionStatus {
        return this.status;
    }
    getMainSessionKey(): string | null {
        return this.mainSessionKey;
    }
    getServerHost(): string | null {
        return this.serverHost;
    }
    isConnected(): boolean {
        return this.status === 'connected';
    }
    getConfig(): ClawdbotGatewayConfig | null {
        return this.config;
    }
    getPairingRequestId(): string | null {
        return this.pairingRequestId;
    }
    getDeviceId(): string | null {
        return this.deviceId;
    }

    /**
     * Connect to a Clawdbot gateway
     */
    connect(config: ClawdbotGatewayConfig) {
        this.config = config;
        this.pairingRequestId = null;
        this.doConnect();
    }

    /**
     * Disconnect from gateway
     */
    disconnect() {
        this.config = null;
        this.clearReconnectTimer();
        this.closeSocket();
        this.updateStatus('disconnected');
        this.mainSessionKey = null;
        this.serverHost = null;
        this.pairingRequestId = null;
    }

    /**
     * Retry connection (e.g., after pairing is approved)
     */
    retryConnect() {
        if (this.config) {
            this.pairingRequestId = null;
            this.doConnect();
        }
    }

    /**
     * Register a status change listener
     */
    onStatusChange(handler: ClawdbotStatusHandler): () => void {
        this.statusListeners.add(handler);
        handler(this.status, undefined, { pairingRequestId: this.pairingRequestId ?? undefined });
        return () => this.statusListeners.delete(handler);
    }

    /**
     * Register an event listener (for chat events, etc.)
     */
    onEvent(handler: ClawdbotEventHandler): () => void {
        this.eventListeners.add(handler);
        return () => this.eventListeners.delete(handler);
    }

    /**
     * Send a request to the gateway and wait for response
     */
    async request<T = unknown>(method: string, params?: unknown, timeoutMs = 15000): Promise<T> {
        if (!this.ws || this.status !== 'connected') {
            throw new Error('Not connected to gateway');
        }

        const id = randomUUID();
        const frame = { type: 'req', id, method, params };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Request timeout: ${method}`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value as T);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            });

            this.ws!.send(JSON.stringify(frame));
        });
    }

    // ─────────────────────────────────────────────────────────────
    // High-level API methods
    // ─────────────────────────────────────────────────────────────

    /**
     * List all chat sessions
     */
    async listSessions(limit?: number): Promise<ClawdbotSession[]> {
        const result = await this.request<ClawdbotSessionsListResult>(
            'sessions.list',
            { includeGlobal: true, includeUnknown: false, limit }
        );
        console.log('[Clawdbot] sessions.list response:', JSON.stringify(result, null, 2));
        return result.sessions ?? [];
    }

    /**
     * Get chat history for a session
     */
    async getHistory(sessionKey: string): Promise<ClawdbotChatMessage[]> {
        const result = await this.request<ClawdbotChatHistoryResult>(
            'chat.history',
            { sessionKey }
        );
        return result.messages ?? [];
    }

    /**
     * Send a message to a session
     */
    async sendMessage(
        sessionKey: string,
        message: string,
        options?: { thinking?: string; attachments?: unknown[] }
    ): Promise<ClawdbotChatSendResult> {
        const result = await this.request<ClawdbotChatSendResult>(
            'chat.send',
            {
                sessionKey,
                message,
                thinking: options?.thinking ?? 'low',
                attachments: options?.attachments,
                timeoutMs: 30000,
                idempotencyKey: randomUUID(),
            },
            35000
        );
        return result;
    }

    /**
     * Abort an in-progress run
     */
    async abortRun(sessionKey: string, runId?: string): Promise<void> {
        await this.request('chat.abort', { sessionKey, runId }, 10000);
    }

    /**
     * Health check
     */
    async healthCheck(): Promise<boolean> {
        try {
            const result = await this.request<{ ok?: boolean }>('health', undefined, 5000);
            return result.ok !== false;
        } catch {
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Private implementation
    // ─────────────────────────────────────────────────────────────

    private doConnect() {
        if (!this.config) return;

        this.updateStatus('connecting');
        this.closeSocket();
        this.connectNonce = null;
        this.connectSent = false;

        const url = this.config.url;
        console.log(`[Clawdbot] Connecting to gateway: ${url}`);

        try {
            this.ws = new WebSocket(url);
        } catch (err) {
            console.error(`[Clawdbot] Failed to create WebSocket:`, err);
            this.updateStatus('error', 'Failed to create connection');
            this.scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            console.log('[Clawdbot] WebSocket opened, waiting for challenge...');
            // Don't send connect immediately - wait for challenge event
        };

        this.ws.onmessage = (event) => {
            this.handleMessage(event.data as string);
        };

        this.ws.onerror = (event) => {
            console.error(`[Clawdbot] WebSocket error:`, event);
            if (this.status === 'connecting') {
                this.updateStatus('error', 'Connection failed');
            }
        };

        this.ws.onclose = (event) => {
            console.log(`[Clawdbot] WebSocket closed: ${event.code} ${event.reason}`);
            this.failAllPending(new Error('Connection closed'));
            // Don't auto-reconnect if pairing is required
            if (this.config && this.status !== 'pairing_required') {
                this.scheduleReconnect();
            }
        };
    }

    private async sendConnect() {
        if (!this.ws || !this.config || this.connectSent) return;
        this.connectSent = true;

        try {
            // Load device identity (creates one if doesn't exist)
            const identity = await loadOrCreateDeviceIdentity();
            this.deviceId = identity.deviceId;
            console.log(`[Clawdbot] Using device ID: ${identity.deviceId.slice(0, 16)}...`);

            // Load stored auth token if available
            const storedToken = await loadDeviceAuthToken();

            // Client IDs for each platform
            const clientId: ClawdbotClientId =
                Platform.OS === 'ios' ? 'clawdbot-ios' :
                Platform.OS === 'android' ? 'clawdbot-android' :
                'webchat-ui';

            const clientMode: ClawdbotClientMode = 'ui';
            const role = 'operator';
            const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing'];
            const signedAtMs = Date.now();

            // Determine auth token (config token takes priority, then stored device token)
            const authToken = this.config.token ?? storedToken?.token ?? undefined;

            // Build and sign device auth payload (with nonce if available)
            const payload = buildDeviceAuthPayload({
                deviceId: identity.deviceId,
                clientId,
                clientMode,
                role,
                scopes,
                signedAtMs,
                token: authToken ?? null,
                nonce: this.connectNonce,
            });
            const signature = await signPayload(identity.privateKey, payload);

            const params: ClawdbotConnectParams = {
                minProtocol: PROTOCOL_VERSION,
                maxProtocol: PROTOCOL_VERSION,
                client: {
                    id: clientId,
                    displayName: 'Happy',
                    version: '1.0.0',
                    platform: Platform.OS,
                    mode: clientMode,
                },
                role,
                scopes,
                device: {
                    id: identity.deviceId,
                    publicKey: getPublicKeyBase64Url(identity.publicKey),
                    signature,
                    signedAt: signedAtMs,
                    nonce: this.connectNonce ?? undefined,
                },
                auth: authToken
                    ? { token: authToken }
                    : this.config.password
                        ? { password: this.config.password }
                        : undefined,
            };

            // Send connect request
            const id = randomUUID();
            const frame = { type: 'req', id, method: 'connect', params };

            const resultPromise = new Promise<ClawdbotHelloOk>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error('Connect timeout'));
                }, 10000);

                this.pending.set(id, {
                    resolve: (value) => {
                        clearTimeout(timeout);
                        resolve(value as ClawdbotHelloOk);
                    },
                    reject: (error) => {
                        clearTimeout(timeout);
                        reject(error);
                    },
                });
            });

            this.ws.send(JSON.stringify(frame));

            const result = await resultPromise;

            // Store device auth token if provided
            if (result.auth?.deviceToken) {
                console.log('[Clawdbot] Storing device auth token');
                await storeDeviceAuthToken({
                    token: result.auth.deviceToken,
                    role: result.auth.role ?? role,
                    scopes: result.auth.scopes ?? scopes,
                });
            }

            this.mainSessionKey = result.snapshot?.sessionDefaults?.mainSessionKey ?? null;
            this.serverHost = result.server?.host ?? null;
            this.updateStatus('connected');
            console.log(`[Clawdbot] Connected! Server: ${this.serverHost}, Main session: ${this.mainSessionKey}`);
        } catch (error) {
            console.error(`[Clawdbot] Connect failed:`, error);

            // Check if pairing is required
            const errorMsg = error instanceof Error ? error.message : '';
            if (errorMsg.includes('NOT_PAIRED')) {
                // Extract request ID from error details if available
                const match = errorMsg.match(/requestId['":\s]+([a-f0-9-]+)/i);
                this.pairingRequestId = match?.[1] ?? null;
                this.updateStatus('pairing_required', 'Device pairing required', { pairingRequestId: this.pairingRequestId ?? undefined });
                this.closeSocket();
                return;
            }

            this.updateStatus('error', error instanceof Error ? error.message : 'Connect failed');
            this.closeSocket();
            this.scheduleReconnect();
        }
    }

    private handleMessage(data: string) {
        let frame: ClawdbotFrame;
        try {
            frame = JSON.parse(data);
        } catch {
            console.error(`[Clawdbot] Invalid JSON: ${data.slice(0, 100)}`);
            return;
        }

        if (frame.type === 'res') {
            // Response to a pending request
            const pending = this.pending.get(frame.id);
            if (pending) {
                this.pending.delete(frame.id);
                if (frame.ok) {
                    pending.resolve(frame.payload);
                } else {
                    const err = frame.error;
                    pending.reject(new Error(`${err?.code ?? 'ERROR'}: ${err?.message ?? 'Request failed'}`));
                }
            }
        } else if (frame.type === 'event') {
            // Server-pushed event
            let payload = frame.payload;
            if (!payload && frame.payloadJSON) {
                try {
                    payload = JSON.parse(frame.payloadJSON);
                } catch {
                    // ignore
                }
            }

            // Handle connect.challenge event - receive nonce and send connect
            if (frame.event === 'connect.challenge' && !this.connectSent) {
                const nonce = (payload as { nonce?: string } | undefined)?.nonce;
                if (nonce) {
                    console.log(`[Clawdbot] Received challenge nonce: ${nonce.slice(0, 8)}...`);
                    this.connectNonce = nonce;
                }
                this.sendConnect();
                return;
            }

            this.eventListeners.forEach((handler) => handler(frame.event, payload));
        }
    }

    private updateStatus(status: ClawdbotConnectionStatus, error?: string, details?: { pairingRequestId?: string }) {
        this.status = status;
        this.statusListeners.forEach((handler) => handler(status, error, details));
    }

    private closeSocket() {
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            try {
                this.ws.close();
            } catch {
                /* ignore */
            }
            this.ws = null;
        }
    }

    private failAllPending(error: Error) {
        for (const [, pending] of this.pending) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    private scheduleReconnect() {
        if (!this.config) return; // Intentionally disconnected

        this.clearReconnectTimer();
        this.updateStatus('disconnected');

        this.reconnectTimer = setTimeout(() => {
            this.doConnect();
        }, 3000);
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}

// Singleton export
export const ClawdbotSocket = new ClawdbotSocketClass();
