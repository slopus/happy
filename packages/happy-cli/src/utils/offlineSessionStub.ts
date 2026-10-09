/**
 * Offline Session Stub Factory
 *
 * Creates a no-op session stub for offline mode that can be used across all backends
 * (Claude, Codex, Gemini, etc.). All session methods become no-ops until reconnection.
 *
 * This follows DRY principles by providing a single implementation for all backends,
 * satisfying REQ-8 from serverConnectionErrors.ts.
 *
 * @module offlineSessionStub
 */

import type { ApiSessionClient } from '@/api/apiSession';

/**
 * Creates a no-op session stub for offline mode.
 *
 * The stub implements the ApiSessionClient interface with no-op methods,
 * allowing the application to continue running while offline. When reconnection
 * succeeds, the real session replaces this stub.
 *
 * @param sessionTag - Unique session tag (used to create offline session ID)
 * @returns A no-op ApiSessionClient stub
 *
 * @example
 * ```typescript
 * const offlineStub = createOfflineSessionStub(sessionTag);
 * let session: ApiSessionClient = offlineStub;
 *
 * // When reconnected:
 * session = api.sessionSyncClient(response);
 * ```
 */
type OfflineRegistrations = {
    userMessageHandler: Parameters<ApiSessionClient['onUserMessage']>[0] | null;
    rpcHandlers: Map<string, (...args: any[]) => any>;
};

const offlineRegistrations = new WeakMap<object, OfflineRegistrations>();

export function createOfflineSessionStub(sessionTag: string): ApiSessionClient {
    // Backends register their handlers once, on whatever session they hold at
    // startup. Record them so they can be attached to the real session later.
    const registrations: OfflineRegistrations = { userMessageHandler: null, rpcHandlers: new Map() };
    const stub = {
        sessionId: `offline-${sessionTag}`,
        sendCodexMessage: () => {},
        sendAgentMessage: () => {},
        sendClaudeSessionMessage: () => {},
        keepAlive: () => {},
        sendSessionEvent: () => {},
        sendSessionDeath: () => {},
        updateLifecycleState: () => {},
        requestControlTransfer: async () => {},
        flush: async () => {},
        close: async () => {},
        updateMetadata: () => {},
        updateAgentState: () => {},
        onUserMessage: (handler: OfflineRegistrations['userMessageHandler']) => {
            registrations.userMessageHandler = handler;
        },
        rpcHandlerManager: {
            registerHandler: (method: string, handler: (...args: any[]) => any) => {
                registrations.rpcHandlers.set(method, handler);
            }
        }
    };
    offlineRegistrations.set(stub, registrations);
    return stub as unknown as ApiSessionClient;
}

/**
 * Attaches the handlers registered on an offline stub to the real session that
 * replaces it after reconnection. Without this, the real session would have no
 * user-message listener and no RPC handlers (abort, kill, ...).
 */
export function transferOfflineRegistrations(stub: ApiSessionClient, session: ApiSessionClient): void {
    const registrations = offlineRegistrations.get(stub);
    if (!registrations) return;
    for (const [method, handler] of registrations.rpcHandlers) {
        session.rpcHandlerManager.registerHandler(method, handler);
    }
    if (registrations.userMessageHandler) {
        session.onUserMessage(registrations.userMessageHandler);
    }
}
