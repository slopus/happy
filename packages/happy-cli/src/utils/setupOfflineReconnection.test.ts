import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnReconnected: (() => Promise<unknown>) | null = null;

vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'http://server.test' },
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    startOfflineReconnection: (config: { onReconnected: () => Promise<unknown> }) => {
        capturedOnReconnected = config.onReconnected;
        return { cancel: () => {}, getSession: () => null, isReconnected: () => false };
    },
}));

import { setupOfflineReconnection } from './setupOfflineReconnection';

function makeRealSession() {
    return {
        sessionId: 'real-session',
        onUserMessage: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
    };
}

function setupOffline(realSession: ReturnType<typeof makeRealSession>, onSessionSwap = vi.fn()) {
    const api = {
        getOrCreateSession: vi.fn().mockResolvedValue({ id: 'real-session' }),
        sessionSyncClient: vi.fn().mockReturnValue(realSession),
    };
    const result = setupOfflineReconnection({
        api: api as any,
        sessionTag: 'tag-1',
        metadata: {} as any,
        state: {} as any,
        response: null,
        onSessionSwap,
    });
    return { result, onSessionSwap };
}

describe('setupOfflineReconnection', () => {
    beforeEach(() => {
        capturedOnReconnected = null;
    });

    it('re-attaches the user message handler registered while offline', async () => {
        const realSession = makeRealSession();
        const { result } = setupOffline(realSession);
        const handler = vi.fn();

        result.session.onUserMessage(handler);
        await capturedOnReconnected!();

        expect(realSession.onUserMessage).toHaveBeenCalledWith(handler);
    });

    it('re-registers RPC handlers registered while offline', async () => {
        const realSession = makeRealSession();
        const { result } = setupOffline(realSession);
        const abort = vi.fn();
        const kill = vi.fn();

        result.session.rpcHandlerManager.registerHandler('abort', abort);
        result.session.rpcHandlerManager.registerHandler('killSession', kill);
        await capturedOnReconnected!();

        expect(realSession.rpcHandlerManager.registerHandler).toHaveBeenCalledWith('abort', abort);
        expect(realSession.rpcHandlerManager.registerHandler).toHaveBeenCalledWith('killSession', kill);
    });

    it('attaches handlers before handing the real session to the caller', async () => {
        const realSession = makeRealSession();
        const order: string[] = [];
        realSession.onUserMessage.mockImplementation(() => order.push('attach'));
        const { result } = setupOffline(realSession, vi.fn(() => order.push('swap')));

        result.session.onUserMessage(vi.fn());
        await capturedOnReconnected!();

        expect(order).toEqual(['attach', 'swap']);
    });

    it('re-attaches only the latest user message handler', async () => {
        const realSession = makeRealSession();
        const { result } = setupOffline(realSession);
        const first = vi.fn();
        const second = vi.fn();

        result.session.onUserMessage(first);
        result.session.onUserMessage(second);
        await capturedOnReconnected!();

        expect(realSession.onUserMessage).toHaveBeenCalledTimes(1);
        expect(realSession.onUserMessage).toHaveBeenCalledWith(second);
    });
});
