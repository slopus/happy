import { beforeEach, describe, expect, it, vi } from 'vitest';

const { io, socket, socketHandlers } = vi.hoisted(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const mockSocket = {
        id: 'socket-a',
        recovered: true,
        disconnect: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn(),
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
            handlers[event] = handler;
        }),
        onAny: vi.fn((handler: (...args: any[]) => void) => {
            handlers.onAny = handler;
        }),
    };
    return {
        io: vi.fn(() => mockSocket),
        socket: mockSocket,
        socketHandlers: handlers,
    };
});

vi.mock('socket.io-client', () => ({ io }));
vi.mock('react-native', () => ({
    AppState: { currentState: 'active' },
    Platform: { OS: 'web' },
}));
vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '1.0.0' } },
}));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: { getCredentials: vi.fn() },
}));
vi.mock('./storage', () => ({
    storage: {
        getState: () => ({ localSettings: { verboseLogging: false } }),
    },
}));

describe('ApiSocket message listeners', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of Object.keys(socketHandlers)) {
            delete socketHandlers[key];
        }
    });

    it('keeps multiple handlers for the same event independently disposable', async () => {
        const { ApiSocket } = await import('./apiSocket');
        const apiSocket = new ApiSocket();
        apiSocket.initialize(
            { endpoint: 'http://localhost', token: 'token' },
            {} as any,
        );

        const first = vi.fn();
        const second = vi.fn();
        const disposeFirst = apiSocket.onMessage('terminal:output', first);
        apiSocket.onMessage('terminal:output', second);

        socketHandlers.onAny('terminal:output', { payload: 'one' });
        expect(first).toHaveBeenCalledWith({ payload: 'one' });
        expect(second).toHaveBeenCalledWith({ payload: 'one' });

        disposeFirst();
        socketHandlers.onAny('terminal:output', { payload: 'two' });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
        expect(apiSocket.getSocketId()).toBe(socket.id);
    });
});
