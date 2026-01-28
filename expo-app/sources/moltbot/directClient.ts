/**
 * Moltbot Direct Client
 *
 * A client for connecting directly to Moltbot gateways via WebSocket,
 * without going through Happy's relay infrastructure. This is used for
 * direct machine connections (type='direct').
 *
 * The direct client:
 * - Connects directly to the Moltbot gateway WebSocket
 * - Implements Moltbot protocol v3 authentication (Ed25519 signing)
 * - Manages connection state (connecting, connected, disconnected, etc.)
 * - Sends messages to the Moltbot gateway
 * - Receives events from the Moltbot gateway
 * - Handles pairing flow when required
 * - Supports reconnection
 */

import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { signDetached } from '@/encryption/libsodium';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type {
    MoltbotConnectionStatus,
    MoltbotPairingData,
    MoltbotFrame,
    MoltbotRequestFrame,
    MoltbotResponseFrame,
    MoltbotEventFrame,
} from './types';

const PROTOCOL_VERSION = 3;
const DEFAULT_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 15000;

// Event types

export type DirectClientEventCallback = (event: string, payload: unknown) => void;
export type DirectClientStatusCallback = (status: MoltbotConnectionStatus, error?: string) => void;

// Direct client configuration

export interface DirectClientConfig {
    url: string;
    password?: string;
    token?: string;
    pairingData?: MoltbotPairingData;
    onEvent?: DirectClientEventCallback;
    onStatusChange?: DirectClientStatusCallback;
}

// Direct client result types

export interface DirectConnectResult {
    ok: boolean;
    status: MoltbotConnectionStatus;
    error?: string;
    mainSessionKey?: string;
    serverHost?: string;
    pairingRequestId?: string;
    deviceToken?: string;
}

export interface DirectSendResult {
    ok: boolean;
    payload?: unknown;
    error?: string;
}

// Internal pending request tracking

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

/**
 * Moltbot Direct Client
 *
 * Manages a direct WebSocket connection to a Moltbot gateway.
 * Implements the Moltbot protocol v3 with Ed25519 device authentication.
 */
export class MoltbotDirectClient {
    private readonly config: DirectClientConfig;
    private readonly pairingData: MoltbotPairingData | null;

    private ws: WebSocket | null = null;
    private status: MoltbotConnectionStatus = 'disconnected';
    private mainSessionKey: string | null = null;
    private serverHost: string | null = null;
    private pairingRequestId: string | null = null;
    private deviceToken: string | null = null;

    private eventCallback: DirectClientEventCallback | null = null;
    private statusCallback: DirectClientStatusCallback | null = null;

    private pending = new Map<string, PendingRequest>();
    private connectNonce: string | null = null;
    private connectSent = false;
    private connectPromise: {
        resolve: (result: DirectConnectResult) => void;
        reject: (error: Error) => void;
    } | null = null;
    private connectTimeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(config: DirectClientConfig) {
        this.config = config;
        this.pairingData = config.pairingData ?? null;
        this.eventCallback = config.onEvent ?? null;
        this.statusCallback = config.onStatusChange ?? null;
    }

    /**
     * Get the current connection status
     */
    getStatus(): MoltbotConnectionStatus {
        return this.status;
    }

    /**
     * Get the main session key (available after successful connection)
     */
    getMainSessionKey(): string | null {
        return this.mainSessionKey;
    }

    /**
     * Get the server host (available after successful connection)
     */
    getServerHost(): string | null {
        return this.serverHost;
    }

    /**
     * Get the pairing request ID (available when pairing is required)
     */
    getPairingRequestId(): string | null {
        return this.pairingRequestId;
    }

    /**
     * Get the device token (issued after successful pairing)
     */
    getDeviceToken(): string | null {
        return this.deviceToken;
    }

    /**
     * Set the event callback
     */
    setEventCallback(callback: DirectClientEventCallback | null): void {
        this.eventCallback = callback;
    }

    /**
     * Set the status change callback
     */
    setStatusCallback(callback: DirectClientStatusCallback | null): void {
        this.statusCallback = callback;
    }

    /**
     * Connect to the Moltbot gateway
     */
    async connect(): Promise<DirectConnectResult> {
        if (this.status === 'connecting' || this.status === 'connected') {
            return {
                ok: this.status === 'connected',
                status: this.status,
                mainSessionKey: this.mainSessionKey ?? undefined,
                serverHost: this.serverHost ?? undefined,
            };
        }

        this.updateStatus('connecting');
        this.connectSent = false;
        this.connectNonce = null;

        return new Promise((resolve) => {
            this.connectPromise = { resolve, reject: (error) => resolve({ ok: false, status: 'error', error: error.message }) };

            // Set connection timeout
            this.connectTimeoutId = setTimeout(() => {
                this.handleConnectTimeout();
            }, CONNECT_TIMEOUT_MS);

            try {
                console.log(`[MoltbotDirect] Connecting to ${this.config.url}`);
                this.ws = new WebSocket(this.config.url);

                this.ws.onopen = () => {
                    console.log('[MoltbotDirect] WebSocket opened');
                    // Wait for challenge event before sending connect
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (event) => {
                    console.log('[MoltbotDirect] WebSocket error:', event);
                    this.handleError('WebSocket error');
                };

                this.ws.onclose = (event) => {
                    console.log(`[MoltbotDirect] WebSocket closed: ${event.code} ${event.reason}`);
                    this.handleClose();
                };
            } catch (error) {
                this.clearConnectTimeout();
                this.updateStatus('error');
                resolve({
                    ok: false,
                    status: 'error',
                    error: error instanceof Error ? error.message : 'Failed to connect',
                });
            }
        });
    }

    /**
     * Send a request through the WebSocket to the Moltbot gateway
     */
    async send(method: string, params?: unknown, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<DirectSendResult> {
        if (this.status !== 'connected' || !this.ws) {
            return {
                ok: false,
                error: 'Not connected',
            };
        }

        const id = randomUUID();
        const frame: MoltbotRequestFrame = {
            type: 'req',
            id,
            method,
            params,
        };

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                resolve({
                    ok: false,
                    error: `Request timeout: ${method}`,
                });
            }, timeoutMs);

            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve({
                        ok: true,
                        payload: value,
                    });
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    resolve({
                        ok: false,
                        error: error.message,
                    });
                },
                timeout,
            });

            this.ws!.send(JSON.stringify(frame));
        });
    }

    /**
     * Close the WebSocket connection
     */
    async close(): Promise<boolean> {
        if (this.status === 'disconnected') {
            return true;
        }

        this.clearConnectTimeout();
        this.failAllPending(new Error('Connection closed'));

        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // Ignore close errors
            }
            this.ws = null;
        }

        this.updateStatus('disconnected');
        this.mainSessionKey = null;
        this.serverHost = null;
        this.pairingRequestId = null;
        this.connectPromise = null;

        return true;
    }

    /**
     * Reconnect to the Moltbot gateway
     * Closes the existing connection and establishes a new one
     */
    async reconnect(): Promise<DirectConnectResult> {
        await this.close();
        return this.connect();
    }

    // Private methods

    private handleMessage(data: string): void {
        let frame: MoltbotFrame;
        try {
            frame = JSON.parse(data);
        } catch {
            console.log(`[MoltbotDirect] Invalid JSON: ${data.slice(0, 100)}`);
            return;
        }

        if (frame.type === 'res') {
            this.handleResponse(frame as MoltbotResponseFrame);
        } else if (frame.type === 'event') {
            this.handleEvent(frame as MoltbotEventFrame);
        }
    }

    private handleResponse(frame: MoltbotResponseFrame): void {
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
    }

    private handleEvent(frame: MoltbotEventFrame): void {
        let payload = frame.payload;
        if (!payload && frame.payloadJSON) {
            try {
                payload = JSON.parse(frame.payloadJSON);
            } catch {
                // ignore
            }
        }

        // Handle connect.challenge event
        if (frame.event === 'connect.challenge' && !this.connectSent) {
            const nonce = (payload as { nonce?: string } | undefined)?.nonce;
            if (nonce) {
                this.connectNonce = nonce;
            }
            this.sendConnect();
            return;
        }

        // Forward events to callback
        if (this.eventCallback) {
            this.eventCallback(frame.event, payload);
        }
    }

    private async sendConnect(): Promise<void> {
        if (!this.ws || this.connectSent) {
            return;
        }

        this.connectSent = true;

        try {
            const params: Record<string, unknown> = {
                minProtocol: PROTOCOL_VERSION,
                maxProtocol: PROTOCOL_VERSION,
                client: {
                    id: 'gateway-client',
                    displayName: 'Happy Mobile',
                    version: '1.0.0',
                    platform: Platform.OS,
                    mode: 'ui',
                },
                role: 'operator',
                scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
            };

            // Add device authentication if pairing data is available
            if (this.pairingData) {
                const signedAtMs = Date.now();
                const payload = this.buildDeviceAuthPayload({
                    deviceId: this.pairingData.deviceId,
                    clientId: 'gateway-client',
                    clientMode: 'ui',
                    role: 'operator',
                    scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
                    signedAtMs,
                    token: this.config.token ?? null,
                    nonce: this.connectNonce,
                });
                const signature = await this.signPayload(payload);

                params.device = {
                    id: this.pairingData.deviceId,
                    publicKey: this.pairingData.publicKey,
                    signature,
                    signedAt: signedAtMs,
                    nonce: this.connectNonce ?? undefined,
                };
            }

            // Add auth if provided
            if (this.config.token) {
                params.auth = { token: this.config.token };
            } else if (this.config.password) {
                params.auth = { password: this.config.password };
            }

            // Send connect request
            const id = randomUUID();
            const frame: MoltbotRequestFrame = {
                type: 'req',
                id,
                method: 'connect',
                params,
            };

            const timeout = setTimeout(() => {
                this.pending.delete(id);
                this.resolveConnect({
                    ok: false,
                    status: 'error',
                    error: 'Connect timeout',
                });
            }, 10000);

            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    const result = value as {
                        server?: { host?: string };
                        snapshot?: { sessionDefaults?: { mainSessionKey?: string } };
                        auth?: { deviceToken?: string };
                    };

                    this.mainSessionKey = result.snapshot?.sessionDefaults?.mainSessionKey ?? null;
                    this.serverHost = result.server?.host ?? null;
                    this.deviceToken = result.auth?.deviceToken ?? null;

                    console.log(`[MoltbotDirect] Connected, server: ${this.serverHost}`);

                    this.clearConnectTimeout();
                    this.updateStatus('connected');
                    this.resolveConnect({
                        ok: true,
                        status: 'connected',
                        mainSessionKey: this.mainSessionKey ?? undefined,
                        serverHost: this.serverHost ?? undefined,
                        deviceToken: this.deviceToken ?? undefined,
                    });
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    const errorMsg = error.message;

                    // Check for pairing required
                    if (errorMsg.includes('NOT_PAIRED')) {
                        const match = errorMsg.match(/requestId['":\s]+([a-f0-9-]+)/i);
                        this.pairingRequestId = match?.[1] ?? null;

                        this.clearConnectTimeout();
                        this.updateStatus('pairing_required');
                        this.resolveConnect({
                            ok: false,
                            status: 'pairing_required',
                            error: 'Device pairing required',
                            pairingRequestId: this.pairingRequestId ?? undefined,
                        });
                        return;
                    }

                    this.clearConnectTimeout();
                    this.updateStatus('error');
                    this.resolveConnect({
                        ok: false,
                        status: 'error',
                        error: errorMsg,
                    });
                },
                timeout,
            });

            this.ws.send(JSON.stringify(frame));
        } catch (error) {
            this.clearConnectTimeout();
            this.updateStatus('error');
            this.resolveConnect({
                ok: false,
                status: 'error',
                error: error instanceof Error ? error.message : 'Connect failed',
            });
        }
    }

    private buildDeviceAuthPayload(params: {
        deviceId: string;
        clientId: string;
        clientMode: string;
        role: string;
        scopes: string[];
        signedAtMs: number;
        token: string | null;
        nonce: string | null;
    }): string {
        // Moltbot protocol: v2 format required when nonce is present
        // Format: v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
        const version = params.nonce ? 'v2' : 'v1';
        const scopes = params.scopes.join(',');
        const token = params.token ?? '';

        const parts = [
            version,
            params.deviceId,
            params.clientId,
            params.clientMode,
            params.role,
            scopes,
            params.signedAtMs.toString(),
            token,
        ];

        if (version === 'v2') {
            parts.push(params.nonce ?? '');
        }

        return parts.join('|');
    }

    private async signPayload(payload: string): Promise<string> {
        if (!this.pairingData) {
            throw new Error('No pairing data available for signing');
        }

        const privateKey = decodeBase64(this.pairingData.privateKey, 'base64url');
        const message = new TextEncoder().encode(payload);
        const signature = await signDetached(message, privateKey);
        return encodeBase64(signature, 'base64url');
    }

    private handleError(message: string): void {
        this.failAllPending(new Error(message));

        if (this.status === 'connecting') {
            this.clearConnectTimeout();
            this.updateStatus('error');
            this.resolveConnect({
                ok: false,
                status: 'error',
                error: message,
            });
        } else {
            this.updateStatus('error');
        }
    }

    private handleClose(): void {
        this.failAllPending(new Error('Connection closed'));
        this.ws = null;

        if (this.status === 'connecting') {
            this.clearConnectTimeout();
            this.resolveConnect({
                ok: false,
                status: 'disconnected',
                error: 'Connection closed',
            });
        }

        this.updateStatus('disconnected');
    }

    private handleConnectTimeout(): void {
        this.connectTimeoutId = null;

        if (this.status === 'connecting') {
            this.updateStatus('error');
            this.resolveConnect({
                ok: false,
                status: 'error',
                error: 'Connection timeout',
            });

            if (this.ws) {
                try {
                    this.ws.close();
                } catch {
                    // Ignore
                }
                this.ws = null;
            }
        }
    }

    private clearConnectTimeout(): void {
        if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = null;
        }
    }

    private resolveConnect(result: DirectConnectResult): void {
        if (this.connectPromise) {
            const promise = this.connectPromise;
            this.connectPromise = null;
            promise.resolve(result);
        }
    }

    private failAllPending(error: Error): void {
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private updateStatus(status: MoltbotConnectionStatus, error?: string): void {
        if (this.status !== status) {
            this.status = status;
            if (this.statusCallback) {
                this.statusCallback(status, error);
            }
        }
    }
}

/**
 * Create a new direct client instance
 *
 * Convenience function for creating a direct client with the given configuration.
 *
 * @param config - Direct client configuration
 * @returns A new MoltbotDirectClient instance
 *
 * @example
 * ```typescript
 * const client = createDirectClient({
 *     url: 'ws://192.168.1.100:18789',
 *     password: 'secret123',
 *     pairingData: {
 *         deviceId: 'device-123',
 *         publicKey: 'base64url-encoded-public-key',
 *         privateKey: 'base64url-encoded-private-key',
 *     },
 *     onStatusChange: (status, error) => {
 *         console.log('Status:', status, error);
 *     },
 *     onEvent: (event, payload) => {
 *         console.log('Event:', event, payload);
 *     },
 * });
 *
 * const result = await client.connect();
 * if (result.ok) {
 *     const sessions = await client.send('sessions.list', {});
 *     console.log('Sessions:', sessions.payload);
 * }
 *
 * await client.close();
 * ```
 */
export function createDirectClient(config: DirectClientConfig): MoltbotDirectClient {
    return new MoltbotDirectClient(config);
}
