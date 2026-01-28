/**
 * Moltbot Module
 *
 * Provides RPC handlers for the Moltbot tunnel functionality,
 * allowing the mobile app to communicate with Moltbot gateways
 * through the Happy daemon.
 */

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { moltbotTunnelManager } from './MoltbotTunnelManager';
import type {
    MoltbotConnectRequest,
    MoltbotConnectResponse,
    MoltbotSendRequest,
    MoltbotSendResponse,
    MoltbotCloseRequest,
    MoltbotCloseResponse,
    MoltbotStatusRequest,
    MoltbotStatusResponse,
} from './types';

/**
 * Register Moltbot RPC handlers with the handler manager
 */
export function registerMoltbotHandlers(rpcManager: RpcHandlerManager): void {
    // moltbot-connect: Establish connection to a Moltbot gateway
    rpcManager.registerHandler<MoltbotConnectRequest, MoltbotConnectResponse>(
        'moltbot-connect',
        async (params) => {
            if (!params.tunnelId || !params.config?.url) {
                return {
                    ok: false,
                    status: 'error',
                    error: 'tunnelId and config.url are required',
                };
            }
            return moltbotTunnelManager.connect(params);
        }
    );

    // moltbot-send: Send a request through the tunnel
    rpcManager.registerHandler<MoltbotSendRequest, MoltbotSendResponse>(
        'moltbot-send',
        async (params) => {
            if (!params.tunnelId || !params.method) {
                return {
                    ok: false,
                    error: 'tunnelId and method are required',
                };
            }
            return moltbotTunnelManager.send(params);
        }
    );

    // moltbot-close: Close a tunnel connection
    rpcManager.registerHandler<MoltbotCloseRequest, MoltbotCloseResponse>(
        'moltbot-close',
        (params) => {
            if (!params.tunnelId) {
                return { ok: false };
            }
            const success = moltbotTunnelManager.close(params.tunnelId);
            return { ok: success };
        }
    );

    // moltbot-status: Get status of a tunnel
    rpcManager.registerHandler<MoltbotStatusRequest, MoltbotStatusResponse>(
        'moltbot-status',
        (params) => {
            if (!params.tunnelId) {
                return {
                    ok: false,
                    status: 'disconnected',
                    error: 'tunnelId is required',
                };
            }
            const status = moltbotTunnelManager.getStatus(params.tunnelId);
            return {
                ok: true,
                ...status,
            };
        }
    );
}

export { moltbotTunnelManager } from './MoltbotTunnelManager';
export * from './types';
