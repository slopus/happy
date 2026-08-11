import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeVoiceSessionAdapter } from './RealtimeVoiceSessionAdapter';

const mocks = vi.hoisted(() => ({
    setRealtimeStatus: vi.fn(),
}));

vi.mock('@/constants/Languages', () => ({
    getElevenLabsCodeFromPreference: () => 'en',
}));

vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            settings: { voiceAssistantLanguage: 'en' },
            setRealtimeStatus: mocks.setRealtimeStatus,
        }),
    },
}));

function createController() {
    return {
        startSession: vi.fn(),
        endSession: vi.fn(),
        sendUserMessage: vi.fn(),
        sendContextualUpdate: vi.fn(),
    };
}

const config = {
    sessionId: 'session-1',
    conversationToken: 'token-1',
    initialContext: 'hello',
};

describe('RealtimeVoiceSessionAdapter', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('does not report a session as started until ElevenLabs calls onConnect', async () => {
        const adapter = new RealtimeVoiceSessionAdapter();
        const controller = createController();
        adapter.setConversation(controller);

        let settled = false;
        const started = adapter.startSession(config).finally(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);
        expect(controller.startSession).toHaveBeenCalledWith(expect.objectContaining({
            conversationToken: 'token-1',
            connectionType: 'webrtc',
        }));

        adapter.handleConnect('conv-1');
        await expect(started).resolves.toBe('conv-1');
        expect(adapter.isConnected()).toBe(true);
    });

    it('rejects overlapping starts and permits a clean retry after a failed start', async () => {
        const adapter = new RealtimeVoiceSessionAdapter();
        const controller = createController();
        adapter.setConversation(controller);

        const first = adapter.startSession(config);
        await expect(adapter.startSession(config)).rejects.toThrow('already connecting');

        expect(adapter.handleError('signaling failed')).toBe(true);
        await expect(first).rejects.toThrow('signaling failed');

        const retry = adapter.startSession(config);
        adapter.handleConnect('conv-retry');
        await expect(retry).resolves.toBe('conv-retry');
        expect(controller.startSession).toHaveBeenCalledTimes(2);
    });

    it('keeps an established session active on a non-terminal onError', async () => {
        const adapter = new RealtimeVoiceSessionAdapter();
        const controller = createController();
        adapter.setConversation(controller);

        const started = adapter.startSession(config);
        adapter.handleConnect('conv-1');
        await started;

        expect(adapter.handleError('recoverable LiveKit error')).toBe(false);
        expect(adapter.isConnected()).toBe(true);
        expect(mocks.setRealtimeStatus).not.toHaveBeenCalledWith('error');
    });

    it('waits for onDisconnect before completing stop and blocks messages while disconnected', async () => {
        const adapter = new RealtimeVoiceSessionAdapter();
        const controller = createController();
        adapter.setConversation(controller);

        adapter.sendTextMessage('too early');
        expect(controller.sendUserMessage).not.toHaveBeenCalled();

        const started = adapter.startSession(config);
        adapter.handleConnect('conv-1');
        await started;
        adapter.sendTextMessage('connected');
        expect(controller.sendUserMessage).toHaveBeenCalledWith('connected');

        let stopped = false;
        const stop = adapter.endSession().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(controller.endSession).toHaveBeenCalledOnce();

        adapter.handleDisconnect();
        await stop;
        expect(stopped).toBe(true);
        expect(adapter.isConnected()).toBe(false);
    });

    it('cancels an in-flight start immediately when stop is requested', async () => {
        const adapter = new RealtimeVoiceSessionAdapter();
        const controller = createController();
        adapter.setConversation(controller);

        const started = adapter.startSession(config);
        const stop = adapter.endSession();

        await expect(started).rejects.toMatchObject({ name: 'VoiceSessionCancellationError' });
        expect(controller.endSession).toHaveBeenCalledOnce();

        adapter.handleDisconnect();
        await expect(stop).resolves.toBeUndefined();
    });

    it('cancels a connection that never reaches onConnect', async () => {
        vi.useFakeTimers();
        const resetProvider = vi.fn(async () => undefined);
        const adapter = new RealtimeVoiceSessionAdapter(resetProvider);
        const controller = createController();
        adapter.setConversation(controller);

        const started = adapter.startSession(config);
        const rejection = expect(started).rejects.toThrow('timed out after 20s');
        await vi.advanceTimersByTimeAsync(20_000);

        await rejection;
        expect(controller.endSession).toHaveBeenCalledOnce();
        expect(mocks.setRealtimeStatus).toHaveBeenCalledWith('error');
        expect(resetProvider).toHaveBeenCalledOnce();
    });

    it('resets the provider before unlocking a stop whose disconnect callback never arrives', async () => {
        vi.useFakeTimers();
        let resolveReset!: () => void;
        const resetProvider = vi.fn(() => new Promise<void>((resolve) => {
            resolveReset = resolve;
        }));
        const adapter = new RealtimeVoiceSessionAdapter(resetProvider);
        const controller = createController();
        adapter.setConversation(controller);

        const started = adapter.startSession(config);
        adapter.handleConnect('conv-1');
        await started;

        const stop = adapter.endSession();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(resetProvider).toHaveBeenCalledOnce();
        let stopped = false;
        void stop.then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);

        adapter.dispose();
        await Promise.resolve();
        expect(stopped).toBe(false);

        resolveReset();
        await expect(stop).resolves.toBeUndefined();
    });
});
