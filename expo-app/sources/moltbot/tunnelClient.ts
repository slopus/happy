/**
 * Moltbot Tunnel Client
 *
 * A client for connecting to Moltbot gateways through Happy's relay infrastructure.
 * Uses RPC calls to the Happy CLI daemon, which manages the actual WebSocket
 * connection to the Moltbot gateway.
 *
 * The tunnel client:
 * - Connects to a Moltbot gateway via the daemon's relay
 * - Manages connection state (connecting, connected, disconnected, etc.)
 * - Sends messages to the Moltbot gateway
 * - Receives events from the Moltbot gateway
 * - Handles pairing flow when required
 * - Supports reconnection
 */

import { randomUUID } from 'expo-crypto';
import { apiSocket } from '@/sync/apiSocket';
import type {
    MoltbotConnectionStatus,
    MoltbotPairingData,
} from './types';

// RPC request/response types (matching CLI daemon types)

interface MoltbotTunnelConfig {
    url: string;
    token?: string;
    password?: string;
}

interface MoltbotConnectRequest {
    tunnelId: string;
    config: MoltbotTunnelConfig;
    device?: {
        id: string;
        publicKey: string;
        privateKey: string;
    };
}

interface MoltbotConnectResponse {
    ok: boolean;
    status: MoltbotConnectionStatus;
    error?: string;
    mainSessionKey?: string;
    serverHost?: string;
    pairingRequestId?: string;
    deviceToken?: string;
}

interface MoltbotSendRequest {
    tunnelId: string;
    method: string;
    params?: unknown;
    timeoutMs?: number;
}

interface MoltbotSendResponse {
    ok: boolean;
    payload?: unknown;
    error?: string;
}

interface MoltbotCloseRequest {
    tunnelId: string;
}

interface MoltbotCloseResponse {
    ok: boolean;
}

interface MoltbotStatusRequest {
    tunnelId: string;
}

interface MoltbotStatusResponse {
    ok: boolean;
    status: MoltbotConnectionStatus;
    mainSessionKey?: string;
    serverHost?: string;
    error?: string;
}

// Event types

export type TunnelEventCallback = (event: string, payload: unknown) => void;
export type TunnelStatusCallback = (status: MoltbotConnectionStatus, error?: string) => void;

// Tunnel client configuration

export interface TunnelClientConfig {
    machineId: string;
    url: string;
    token?: string;
    password?: string;
    pairingData?: MoltbotPairingData;
    onEvent?: TunnelEventCallback;
    onStatusChange?: TunnelStatusCallback;
}

// Tunnel client result types

export interface TunnelConnectResult {
    ok: boolean;
    status: MoltbotConnectionStatus;
    error?: string;
    mainSessionKey?: string;
    serverHost?: string;
    pairingRequestId?: string;
    deviceToken?: string;
}

export interface TunnelSendResult {
    ok: boolean;
    payload?: unknown;
    error?: string;
}

/**
 * Moltbot Tunnel Client
 *
 * Manages a connection to a Moltbot gateway through the Happy CLI daemon.
 * The daemon handles the actual WebSocket connection; this client communicates
 * with the daemon via encrypted RPC calls.
 */
export class MoltbotTunnelClient {
    private readonly machineId: string;
    private readonly tunnelId: string;
    private readonly config: MoltbotTunnelConfig;
    private readonly pairingData: MoltbotPairingData | null;

    private status: MoltbotConnectionStatus = 'disconnected';
    private mainSessionKey: string | null = null;
    private serverHost: string | null = null;
    private pairingRequestId: string | null = null;
    private deviceToken: string | null = null;

    private eventCallback: TunnelEventCallback | null = null;
    private statusCallback: TunnelStatusCallback | null = null;
    private eventUnsubscribe: (() => void) | null = null;

    constructor(config: TunnelClientConfig) {
        this.machineId = config.machineId;
        this.tunnelId = randomUUID();
        this.config = {
            url: config.url,
            token: config.token,
            password: config.password,
        };
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
     * Get the tunnel ID
     */
    getTunnelId(): string {
        return this.tunnelId;
    }

    /**
     * Set the event callback
     */
    setEventCallback(callback: TunnelEventCallback | null): void {
        this.eventCallback = callback;
    }

    /**
     * Set the status change callback
     */
    setStatusCallback(callback: TunnelStatusCallback | null): void {
        this.statusCallback = callback;
    }

    /**
     * Connect to the Moltbot gateway through the daemon
     */
    async connect(): Promise<TunnelConnectResult> {
        if (this.status === 'connecting' || this.status === 'connected') {
            return {
                ok: this.status === 'connected',
                status: this.status,
                mainSessionKey: this.mainSessionKey ?? undefined,
                serverHost: this.serverHost ?? undefined,
            };
        }

        this.updateStatus('connecting');

        // Subscribe to tunnel events from the daemon
        this.subscribeToEvents();

        const request: MoltbotConnectRequest = {
            tunnelId: this.tunnelId,
            config: this.config,
        };

        // Add device authentication if pairing data is available
        if (this.pairingData) {
            request.device = {
                id: this.pairingData.deviceId,
                publicKey: this.pairingData.publicKey,
                privateKey: this.pairingData.privateKey,
            };
        }

        try {
            const response = await apiSocket.machineRPC<MoltbotConnectResponse, MoltbotConnectRequest>(
                this.machineId,
                'moltbot-connect',
                request
            );

            this.updateStatus(response.status, response.error);

            if (response.ok) {
                this.mainSessionKey = response.mainSessionKey ?? null;
                this.serverHost = response.serverHost ?? null;
                this.deviceToken = response.deviceToken ?? null;
            } else if (response.status === 'pairing_required') {
                this.pairingRequestId = response.pairingRequestId ?? null;
            }

            return {
                ok: response.ok,
                status: response.status,
                error: response.error,
                mainSessionKey: response.mainSessionKey,
                serverHost: response.serverHost,
                pairingRequestId: response.pairingRequestId,
                deviceToken: response.deviceToken,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Connection failed';
            this.updateStatus('error', errorMessage);
            return {
                ok: false,
                status: 'error',
                error: errorMessage,
            };
        }
    }

    /**
     * Send a request through the tunnel to the Moltbot gateway
     */
    async send(method: string, params?: unknown, timeoutMs?: number): Promise<TunnelSendResult> {
        if (this.status !== 'connected') {
            return {
                ok: false,
                error: 'Tunnel not connected',
            };
        }

        const request: MoltbotSendRequest = {
            tunnelId: this.tunnelId,
            method,
            params,
            timeoutMs,
        };

        try {
            const response = await apiSocket.machineRPC<MoltbotSendResponse, MoltbotSendRequest>(
                this.machineId,
                'moltbot-send',
                request
            );

            return {
                ok: response.ok,
                payload: response.payload,
                error: response.error,
            };
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Send failed',
            };
        }
    }

    /**
     * Close the tunnel connection
     */
    async close(): Promise<boolean> {
        if (this.status === 'disconnected') {
            return true;
        }

        // Unsubscribe from events
        this.unsubscribeFromEvents();

        const request: MoltbotCloseRequest = {
            tunnelId: this.tunnelId,
        };

        try {
            const response = await apiSocket.machineRPC<MoltbotCloseResponse, MoltbotCloseRequest>(
                this.machineId,
                'moltbot-close',
                request
            );

            this.updateStatus('disconnected');
            this.mainSessionKey = null;
            this.serverHost = null;
            this.pairingRequestId = null;

            return response.ok;
        } catch (error) {
            // Even if RPC fails, mark as disconnected locally
            this.updateStatus('disconnected');
            return false;
        }
    }

    /**
     * Refresh the tunnel status from the daemon
     */
    async refreshStatus(): Promise<MoltbotConnectionStatus> {
        const request: MoltbotStatusRequest = {
            tunnelId: this.tunnelId,
        };

        try {
            const response = await apiSocket.machineRPC<MoltbotStatusResponse, MoltbotStatusRequest>(
                this.machineId,
                'moltbot-status',
                request
            );

            if (response.ok) {
                this.updateStatus(response.status, response.error);
                this.mainSessionKey = response.mainSessionKey ?? null;
                this.serverHost = response.serverHost ?? null;
            }

            return response.status;
        } catch (error) {
            // If RPC fails, assume disconnected
            this.updateStatus('disconnected');
            return 'disconnected';
        }
    }

    /**
     * Reconnect to the Moltbot gateway
     * Closes the existing connection and establishes a new one
     */
    async reconnect(): Promise<TunnelConnectResult> {
        await this.close();
        return this.connect();
    }

    /**
     * Subscribe to tunnel events from the daemon
     * Events are forwarded from the Moltbot gateway through the daemon
     */
    private subscribeToEvents(): void {
        // Events from the daemon are delivered through the socket message system
        // The daemon forwards Moltbot gateway events as messages with a specific format
        // We listen for messages that contain tunnel events for our tunnel ID
        const handleEvent = (data: unknown) => {
            if (!data || typeof data !== 'object') {
                return;
            }

            const eventData = data as {
                type?: string;
                tunnelId?: string;
                event?: string;
                payload?: unknown;
            };

            // Check if this is a tunnel event for our tunnel
            if (eventData.type === 'moltbot-tunnel-event' && eventData.tunnelId === this.tunnelId) {
                this.handleTunnelEvent(eventData.event ?? '', eventData.payload);
            }
        };

        this.eventUnsubscribe = apiSocket.onMessage('moltbot-tunnel-event', handleEvent);
    }

    /**
     * Unsubscribe from tunnel events
     */
    private unsubscribeFromEvents(): void {
        if (this.eventUnsubscribe) {
            this.eventUnsubscribe();
            this.eventUnsubscribe = null;
        }
    }

    /**
     * Handle a tunnel event from the daemon
     */
    private handleTunnelEvent(event: string, payload: unknown): void {
        // Handle connection state events
        if (event === 'connection.closed' || event === 'connection.error') {
            this.updateStatus('disconnected');
        }

        // Forward event to callback
        if (this.eventCallback) {
            this.eventCallback(event, payload);
        }
    }

    /**
     * Update the connection status and notify callback
     */
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
 * Create a new tunnel client instance
 *
 * Convenience function for creating a tunnel client with the given configuration.
 *
 * @param config - Tunnel client configuration
 * @returns A new MoltbotTunnelClient instance
 *
 * @example
 * ```typescript
 * const tunnel = createTunnelClient({
 *     machineId: 'machine-123',
 *     url: 'ws://localhost:18789',
 *     onStatusChange: (status, error) => {
 *         console.log('Status:', status, error);
 *     },
 *     onEvent: (event, payload) => {
 *         console.log('Event:', event, payload);
 *     },
 * });
 *
 * await tunnel.connect();
 *
 * const result = await tunnel.send('sessions.list', {});
 * if (result.ok) {
 *     console.log('Sessions:', result.payload);
 * }
 *
 * await tunnel.close();
 * ```
 */
export function createTunnelClient(config: TunnelClientConfig): MoltbotTunnelClient {
    return new MoltbotTunnelClient(config);
}
