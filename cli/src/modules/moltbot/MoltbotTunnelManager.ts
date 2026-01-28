/**
 * Moltbot Tunnel Manager
 *
 * Manages WebSocket connections to Moltbot gateways, allowing the mobile app
 * to communicate with Moltbot instances through the Happy daemon.
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { logger } from '@/ui/logger';
import * as nacl from 'tweetnacl';
import { encode as encodeBase64, decode as decodeBase64 } from '@stablelib/base64';
import type {
    MoltbotTunnelStatus,
    MoltbotTunnelConfig,
    MoltbotFrame,
    MoltbotTunnelEventCallback,
    MoltbotConnectRequest,
    MoltbotConnectResponse,
    MoltbotSendRequest,
    MoltbotSendResponse,
} from './types';

const PROTOCOL_VERSION = 3;

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

interface TunnelConnection {
    ws: WebSocket | null;
    config: MoltbotTunnelConfig;
    status: MoltbotTunnelStatus;
    pending: Map<string, PendingRequest>;
    mainSessionKey: string | null;
    serverHost: string | null;
    pairingRequestId: string | null;
    device?: {
        id: string;
        publicKey: Uint8Array;
        privateKey: Uint8Array;
    };
    connectNonce: string | null;
    connectSent: boolean;
    deviceToken: string | null;
}

/**
 * Manages multiple Moltbot tunnel connections
 */
export class MoltbotTunnelManager {
    private tunnels = new Map<string, TunnelConnection>();
    private eventCallback: MoltbotTunnelEventCallback | null = null;

    /**
     * Set the event callback for receiving tunnel events
     */
    setEventCallback(callback: MoltbotTunnelEventCallback | null): void {
        this.eventCallback = callback;
    }

    /**
     * Connect to a Moltbot gateway
     */
    async connect(request: MoltbotConnectRequest): Promise<MoltbotConnectResponse> {
        const { tunnelId, config, device } = request;

        // Close existing tunnel if any
        if (this.tunnels.has(tunnelId)) {
            this.closeTunnel(tunnelId);
        }

        // Parse device keys if provided
        let parsedDevice: TunnelConnection['device'] | undefined;
        if (device) {
            try {
                parsedDevice = {
                    id: device.id,
                    publicKey: this.base64UrlDecode(device.publicKey),
                    privateKey: this.base64UrlDecode(device.privateKey),
                };
            } catch (error) {
                return {
                    ok: false,
                    status: 'error',
                    error: 'Invalid device key format',
                };
            }
        }

        // Create tunnel connection
        const tunnel: TunnelConnection = {
            ws: null,
            config,
            status: 'connecting',
            pending: new Map(),
            mainSessionKey: null,
            serverHost: null,
            pairingRequestId: null,
            device: parsedDevice,
            connectNonce: null,
            connectSent: false,
            deviceToken: null,
        };

        this.tunnels.set(tunnelId, tunnel);

        // Connect WebSocket
        return new Promise((resolve) => {
            try {
                logger.debug(`[MoltbotTunnel] Connecting to ${config.url}`);
                const ws = new WebSocket(config.url);
                tunnel.ws = ws;

                ws.on('open', () => {
                    logger.debug(`[MoltbotTunnel] WebSocket opened for tunnel ${tunnelId}`);
                    // Wait for challenge event before sending connect
                });

                ws.on('message', async (data) => {
                    const result = await this.handleMessage(tunnelId, tunnel, data.toString());
                    if (result) {
                        resolve(result);
                    }
                });

                ws.on('error', (error) => {
                    logger.debug(`[MoltbotTunnel] WebSocket error for tunnel ${tunnelId}:`, error);
                    tunnel.status = 'error';
                    this.failAllPending(tunnel, new Error('WebSocket error'));
                    resolve({
                        ok: false,
                        status: 'error',
                        error: error.message,
                    });
                });

                ws.on('close', (code, reason) => {
                    logger.debug(`[MoltbotTunnel] WebSocket closed for tunnel ${tunnelId}: ${code} ${reason}`);
                    this.failAllPending(tunnel, new Error('Connection closed'));
                    if (tunnel.status === 'connecting') {
                        resolve({
                            ok: false,
                            status: 'disconnected',
                            error: 'Connection closed',
                        });
                    }
                    tunnel.status = 'disconnected';
                });

                // Timeout for initial connection
                setTimeout(() => {
                    if (tunnel.status === 'connecting') {
                        tunnel.status = 'error';
                        this.closeTunnel(tunnelId);
                        resolve({
                            ok: false,
                            status: 'error',
                            error: 'Connection timeout',
                        });
                    }
                }, 15000);
            } catch (error) {
                tunnel.status = 'error';
                resolve({
                    ok: false,
                    status: 'error',
                    error: error instanceof Error ? error.message : 'Failed to connect',
                });
            }
        });
    }

    /**
     * Send a request through a tunnel
     */
    async send(request: MoltbotSendRequest): Promise<MoltbotSendResponse> {
        const { tunnelId, method, params, timeoutMs = 15000 } = request;

        const tunnel = this.tunnels.get(tunnelId);
        if (!tunnel || !tunnel.ws || tunnel.status !== 'connected') {
            return {
                ok: false,
                error: 'Tunnel not connected',
            };
        }

        const id = randomUUID();
        const frame = { type: 'req', id, method, params };

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                tunnel.pending.delete(id);
                resolve({
                    ok: false,
                    error: `Request timeout: ${method}`,
                });
            }, timeoutMs);

            tunnel.pending.set(id, {
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

            tunnel.ws!.send(JSON.stringify(frame));
        });
    }

    /**
     * Close a tunnel connection
     */
    close(tunnelId: string): boolean {
        return this.closeTunnel(tunnelId);
    }

    /**
     * Get status of a tunnel
     */
    getStatus(tunnelId: string): { status: MoltbotTunnelStatus; mainSessionKey?: string; serverHost?: string } {
        const tunnel = this.tunnels.get(tunnelId);
        if (!tunnel) {
            return { status: 'disconnected' };
        }
        return {
            status: tunnel.status,
            mainSessionKey: tunnel.mainSessionKey ?? undefined,
            serverHost: tunnel.serverHost ?? undefined,
        };
    }

    /**
     * Close all tunnels (cleanup)
     */
    closeAll(): void {
        for (const tunnelId of this.tunnels.keys()) {
            this.closeTunnel(tunnelId);
        }
    }

    // Private methods

    private closeTunnel(tunnelId: string): boolean {
        const tunnel = this.tunnels.get(tunnelId);
        if (!tunnel) {
            return false;
        }

        this.failAllPending(tunnel, new Error('Tunnel closed'));

        if (tunnel.ws) {
            try {
                tunnel.ws.close();
            } catch {
                // Ignore close errors
            }
            tunnel.ws = null;
        }

        this.tunnels.delete(tunnelId);
        logger.debug(`[MoltbotTunnel] Closed tunnel ${tunnelId}`);
        return true;
    }

    private async handleMessage(
        tunnelId: string,
        tunnel: TunnelConnection,
        data: string
    ): Promise<MoltbotConnectResponse | null> {
        let frame: MoltbotFrame;
        try {
            frame = JSON.parse(data);
        } catch {
            logger.debug(`[MoltbotTunnel] Invalid JSON: ${data.slice(0, 100)}`);
            return null;
        }

        if (frame.type === 'res') {
            // Response to a pending request
            const pending = tunnel.pending.get(frame.id);
            if (pending) {
                tunnel.pending.delete(frame.id);
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

            // Handle connect.challenge event
            if (frame.event === 'connect.challenge' && !tunnel.connectSent) {
                const nonce = (payload as { nonce?: string } | undefined)?.nonce;
                if (nonce) {
                    logger.debug(`[MoltbotTunnel] Received challenge nonce for tunnel ${tunnelId}`);
                    tunnel.connectNonce = nonce;
                }
                return this.sendConnect(tunnelId, tunnel);
            }

            // Forward events to callback
            if (this.eventCallback) {
                this.eventCallback(tunnelId, frame.event, payload);
            }
        }

        return null;
    }

    private async sendConnect(tunnelId: string, tunnel: TunnelConnection): Promise<MoltbotConnectResponse> {
        if (!tunnel.ws || tunnel.connectSent) {
            return {
                ok: false,
                status: tunnel.status,
                error: 'Cannot send connect',
            };
        }

        tunnel.connectSent = true;

        try {
            const params: Record<string, unknown> = {
                minProtocol: PROTOCOL_VERSION,
                maxProtocol: PROTOCOL_VERSION,
                client: {
                    id: 'happy-tunnel',
                    displayName: 'Happy Tunnel',
                    version: '1.0.0',
                    platform: process.platform,
                    mode: 'ui',
                },
                role: 'operator',
                scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
            };

            // Add device authentication if available
            if (tunnel.device) {
                const signedAtMs = Date.now();
                const payload = this.buildDeviceAuthPayload({
                    deviceId: tunnel.device.id,
                    clientId: 'happy-tunnel',
                    clientMode: 'ui',
                    role: 'operator',
                    scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
                    signedAtMs,
                    token: tunnel.config.token ?? null,
                    nonce: tunnel.connectNonce,
                });
                const signature = this.signPayload(tunnel.device.privateKey, payload);

                params.device = {
                    id: tunnel.device.id,
                    publicKey: this.base64UrlEncode(tunnel.device.publicKey),
                    signature,
                    signedAt: signedAtMs,
                    nonce: tunnel.connectNonce ?? undefined,
                };
            }

            // Add auth if provided
            if (tunnel.config.token) {
                params.auth = { token: tunnel.config.token };
            } else if (tunnel.config.password) {
                params.auth = { password: tunnel.config.password };
            }

            // Send connect request
            const id = randomUUID();
            const frame = { type: 'req', id, method: 'connect', params };

            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    tunnel.pending.delete(id);
                    tunnel.status = 'error';
                    resolve({
                        ok: false,
                        status: 'error',
                        error: 'Connect timeout',
                    });
                }, 10000);

                tunnel.pending.set(id, {
                    resolve: (value) => {
                        clearTimeout(timeout);
                        const result = value as {
                            server?: { host?: string };
                            snapshot?: { sessionDefaults?: { mainSessionKey?: string } };
                            auth?: { deviceToken?: string };
                        };

                        tunnel.status = 'connected';
                        tunnel.mainSessionKey = result.snapshot?.sessionDefaults?.mainSessionKey ?? null;
                        tunnel.serverHost = result.server?.host ?? null;
                        tunnel.deviceToken = result.auth?.deviceToken ?? null;

                        logger.debug(`[MoltbotTunnel] Connected tunnel ${tunnelId}, server: ${tunnel.serverHost}`);

                        resolve({
                            ok: true,
                            status: 'connected',
                            mainSessionKey: tunnel.mainSessionKey ?? undefined,
                            serverHost: tunnel.serverHost ?? undefined,
                            deviceToken: tunnel.deviceToken ?? undefined,
                        });
                    },
                    reject: (error) => {
                        clearTimeout(timeout);
                        const errorMsg = error.message;

                        // Check for pairing required
                        if (errorMsg.includes('NOT_PAIRED')) {
                            const match = errorMsg.match(/requestId['":\s]+([a-f0-9-]+)/i);
                            tunnel.pairingRequestId = match?.[1] ?? null;
                            tunnel.status = 'pairing_required';

                            resolve({
                                ok: false,
                                status: 'pairing_required',
                                error: 'Device pairing required',
                                pairingRequestId: tunnel.pairingRequestId ?? undefined,
                            });
                            return;
                        }

                        tunnel.status = 'error';
                        resolve({
                            ok: false,
                            status: 'error',
                            error: errorMsg,
                        });
                    },
                    timeout,
                });

                tunnel.ws!.send(JSON.stringify(frame));
            });
        } catch (error) {
            tunnel.status = 'error';
            return {
                ok: false,
                status: 'error',
                error: error instanceof Error ? error.message : 'Connect failed',
            };
        }
    }

    private failAllPending(tunnel: TunnelConnection, error: Error): void {
        for (const [, pending] of tunnel.pending) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        tunnel.pending.clear();
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

    private signPayload(privateKey: Uint8Array, payload: string): string {
        const message = new TextEncoder().encode(payload);
        const signature = nacl.sign.detached(message, privateKey);
        return this.base64UrlEncode(signature);
    }

    private base64UrlEncode(data: Uint8Array): string {
        return encodeBase64(data)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    private base64UrlDecode(str: string): Uint8Array {
        // Restore padding and standard base64 characters
        let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4 !== 0) {
            base64 += '=';
        }
        return decodeBase64(base64);
    }
}

// Singleton instance
export const moltbotTunnelManager = new MoltbotTunnelManager();
