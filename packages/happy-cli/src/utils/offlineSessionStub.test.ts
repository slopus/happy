import { describe, expect, it } from 'vitest';
import { createOfflineSessionStub } from './offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('supports safe RPC handler cleanup before a reconnect swaps the session', () => {
        const session = createOfflineSessionStub('session-1');

        expect(() => session.rpcHandlerManager.unregisterHandler('mcpAppResourceOpen')).not.toThrow();
    });
});
