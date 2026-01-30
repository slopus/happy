/**
 * OpenClaw Module
 *
 * Provides RPC handlers for the OpenClaw tunnel functionality,
 * allowing the mobile app to communicate with OpenClaw gateways
 * through the Happy daemon.
 */

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
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
 * Register OpenClaw RPC handlers with the handler manager
 */
export function registerOpenClawHandlers(rpcManager: RpcHandlerManager): void {
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
    rpcManager.registerHandler<OpenClawSendRequest, OpenClawSendResponse>(
        'openclaw-send',
        async (params) => {
            if (!params.tunnelId || !params.method) {
                return {
                    ok: false,
                    error: 'tunnelId and method are required',
                };
            }
            return openClawTunnelManager.send(params);
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
