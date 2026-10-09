import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSessionArchived } from '@/utils/sessionLifecycle';

const mocks = vi.hoisted(() => ({
    state: {} as any,
    credentials: { token: 'owner' },
    send: vi.fn(async () => undefined),
    activeAccount: true,
}));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => mocks.activeAccount }));
vi.mock('@/utils/sessionUtils', () => ({ resolveSessionState: (session: any) => ({
    state: session.agentState?.turnStatus?.status ?? 'idle', isConnected: session.presence === 'online',
}) }));
vi.mock('./messageStagingQueuePersistence', () => ({
    messageStagingPersistence: { load: () => ({ messages: [], barriers: {} }), save: () => {} },
    initializeMessageStagingPersistence: async () => {}, clearMessageStagingStorage: () => {},
}));
vi.mock('./storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('./sync', () => ({ sync: { getCredentials: () => mocks.credentials, sendMessage: mocks.send } }));
vi.mock('./ops', () => ({ sessionSteer: vi.fn() }));
vi.mock('./messageMeta', () => ({ resolveMessageModeMeta: () => ({}) }));

import { messageStagingQueue } from './messageStagingQueueRuntime';

describe('archive behavior of the wired message staging runtime', () => {
    beforeEach(() => {
        mocks.send.mockReset();
        mocks.send.mockResolvedValue(undefined);
        mocks.activeAccount = true;
        mocks.state = { socketStatus: 'connected', applyPendingMessageSessions: (ids: Set<string>) => {
            for (const [id, session] of Object.entries(mocks.state.sessions)) {
                (session as any).hasPendingLocalMessages = ids.has(id);
            }
        }, sessions: { app: {
            metadata: { path: '/app', host: 'mac', lifecycleState: 'running', application: { appId: 'advisor', bindingId: 'binding' } },
            presence: 'online', thinking: false,
            agentState: { turnStatus: { status: 'completed', turnId: 'previous', updatedAt: 10 } },
        } } };
        messageStagingQueue.clear();
    });

    it('sends a followup directly to an auto-archived warm session', async () => {
        expect(isSessionArchived(mocks.state.sessions.app)).toBe(true);
        messageStagingQueue.enqueue({ id: 'followup', sessionId: 'app', text: 'continue', modeMeta: {} });
        await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
        expect(mocks.send).toHaveBeenCalledWith('app', 'continue', expect.objectContaining({ source: 'chat' }));
        await vi.waitFor(() => expect(messageStagingQueue.getSnapshot().messages).toHaveLength(0));
        // The old completed outcome must not hide an accepted, not yet started followup.
        expect(isSessionArchived(mocks.state.sessions.app)).toBe(false);
        mocks.state.sessions.app.agentState.turnStatus = { status: 'completed', turnId: 'next', updatedAt: 20 };
        messageStagingQueue.refresh();
        expect(isSessionArchived(mocks.state.sessions.app)).toBe(true);
    });

    it('keeps offline and failed submissions current until the user resolves them', async () => {
        mocks.state.socketStatus = 'disconnected';
        messageStagingQueue.enqueue({ id: 'followup', sessionId: 'app', text: 'continue', modeMeta: {} });
        expect(mocks.send).not.toHaveBeenCalled();
        expect(isSessionArchived(mocks.state.sessions.app)).toBe(false);
        mocks.send.mockRejectedValueOnce(new Error('offline'));
        mocks.state.socketStatus = 'connected';
        messageStagingQueue.refresh();
        await vi.waitFor(() => expect(messageStagingQueue.getSnapshot().messages[0]?.status).toBe('failed'));
        expect(isSessionArchived(mocks.state.sessions.app)).toBe(false);
        messageStagingQueue.remove('followup');
        expect(isSessionArchived(mocks.state.sessions.app)).toBe(true);
    });

    it.each(['archiveRequested', 'archived'])('keeps a manual %s session blocked until restored', async (lifecycleState) => {
        mocks.state.sessions.app.metadata.lifecycleState = lifecycleState;
        messageStagingQueue.enqueue({ id: 'followup', sessionId: 'app', text: 'continue', modeMeta: {} });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(mocks.send).not.toHaveBeenCalled();
        mocks.state.sessions.app.metadata.lifecycleState = 'running';
        messageStagingQueue.refresh();
        await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    });
});
