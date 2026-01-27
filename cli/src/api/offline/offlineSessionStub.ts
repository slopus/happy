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

import { EventEmitter } from 'node:events';
import type { ACPMessageData, ACPProvider, ApiSessionClient } from '@/api/apiSession';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { AgentState, Metadata, Usage, UserMessage } from '@/api/types';
import type { RawJSONLines } from '@/backends/claude/types';

type ApiSessionClientStubContract = Pick<
    ApiSessionClient,
    | 'sessionId'
    | 'rpcHandlerManager'
    | 'sendCodexMessage'
    | 'sendAgentMessage'
    | 'sendClaudeSessionMessage'
    | 'sendSessionEvent'
    | 'keepAlive'
    | 'sendSessionDeath'
    | 'sendUsageData'
    | 'updateMetadata'
    | 'updateAgentState'
    | 'onUserMessage'
    | 'flush'
    | 'close'
>;

class OfflineSessionStub extends EventEmitter implements ApiSessionClientStubContract {
    readonly sessionId: string;
    readonly rpcHandlerManager: RpcHandlerManager;

    constructor(sessionId: string) {
        super();
        this.sessionId = sessionId;
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            logger: () => undefined,
        });
    }

    sendCodexMessage(_body: unknown): void {}
    sendAgentMessage(_provider: ACPProvider, _body: ACPMessageData): void {}
    sendClaudeSessionMessage(_body: RawJSONLines): void {}
    sendSessionEvent(
        _event:
            | { type: 'switch'; mode: 'local' | 'remote' }
            | { type: 'message'; message: string }
            | { type: 'permission-mode-changed'; mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' }
            | { type: 'ready' },
        _id?: string
    ): void {}
    keepAlive(_thinking: boolean, _mode: 'local' | 'remote'): void {}
    sendSessionDeath(): void {}
    sendUsageData(_usage: Usage): void {}
    updateMetadata(_handler: (metadata: Metadata) => Metadata): void {}
    updateAgentState(_handler: (metadata: AgentState) => AgentState): void {}
    onUserMessage(_callback: (data: UserMessage) => void): void {}
    async flush(): Promise<void> {}
    async close(): Promise<void> {}
}

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
export function createOfflineSessionStub(sessionTag: string): ApiSessionClient {
    const stub = new OfflineSessionStub(`offline-${sessionTag}`);
    const _typecheck: ApiSessionClientStubContract = stub;
    void _typecheck;
    return stub as unknown as ApiSessionClient;
}
