/**
 * OpenClaw Module
 *
 * Provides RPC handlers for the OpenClaw tunnel functionality,
 * allowing the mobile app to communicate with OpenClaw gateways
 * through the Happy daemon.
 */

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { openClawTunnelManager } from './OpenClawTunnelManager';
import type {
    OpenClawConnectRequest,
    OpenClawConnectResponse,
    OpenClawSendRequest,
    OpenClawSendResponse,
    OpenClawCloseRequest,
    OpenClawCloseResponse,
    OpenClawStatusRequest,
    OpenClawStatusResponse,
} from './types';

/**
 * Encryption context for OpenClaw chat.history
 * Uses legacy (secretbox) format for cross-platform compatibility
 */
export interface OpenClawEncryptionContext {
    key: Uint8Array;
}

/**
 * Register OpenClaw RPC handlers with the handler manager
 * @param rpcManager - The RPC handler manager
 * @param encryptionContext - Encryption context for chat.history (uses legacy format)
 */
export function registerOpenClawHandlers(
    rpcManager: RpcHandlerManager,
    encryptionContext?: OpenClawEncryptionContext
): void {
    // openclaw-connect: Establish connection to an OpenClaw gateway
    rpcManager.registerHandler<OpenClawConnectRequest, OpenClawConnectResponse>(
        'openclaw-connect',
        async (params) => {
            if (!params.tunnelId || !params.config?.url) {
                return {
                    ok: false,
                    status: 'error',
                    error: 'tunnelId and config.url are required',
                };
            }
            return openClawTunnelManager.connect(params);
        }
    );

    // openclaw-send: Send a request through the tunnel
    rpcManager.registerHandler<OpenClawSendRequest, any>(
        'openclaw-send',
        async (params) => {
            if (!params.tunnelId || !params.method) {
                return {
                    ok: false,
                    error: 'tunnelId and method are required',
                };
            }

            const result = await openClawTunnelManager.send(params);

            // For chat.history, use legacy encryption to ensure cross-platform compatibility
            // (Node.js AES-GCM format differs from React Native rn-encryption)
            if (encryptionContext && params.method === 'chat.history' && result.ok && result.payload) {
                const payload = result.payload as { messages?: unknown[] };
                if (Array.isArray(payload.messages) && payload.messages.length > 0) {
                    return {
                        __preEncrypted: true,
                        data: encodeBase64(encryptLegacy(result, encryptionContext.key))
                    };
                }
            }

            return result;
        }
    );

    // openclaw-close: Close a tunnel connection
    rpcManager.registerHandler<OpenClawCloseRequest, OpenClawCloseResponse>(
        'openclaw-close',
        (params) => {
            if (!params.tunnelId) {
                return { ok: false };
            }
            const success = openClawTunnelManager.close(params.tunnelId);
            return { ok: success };
        }
    );

    // openclaw-status: Get status of a tunnel
    rpcManager.registerHandler<OpenClawStatusRequest, OpenClawStatusResponse>(
        'openclaw-status',
        (params) => {
            if (!params.tunnelId) {
                return {
                    ok: false,
                    status: 'disconnected',
                    error: 'tunnelId is required',
                };
            }
            const status = openClawTunnelManager.getStatus(params.tunnelId);
            return {
                ok: true,
                ...status,
            };
        }
    );
}

export { openClawTunnelManager } from './OpenClawTunnelManager';
export * from './types';
