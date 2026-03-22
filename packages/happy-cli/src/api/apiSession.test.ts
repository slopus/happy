import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionClient } from './apiSession';
import { resolveSessionScopedSyncNodeToken } from './syncNodeToken';
import type { Update } from './types';

const {
    mockIo,
    mockBackoff,
    mockDelay
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockBackoff: vi.fn(async <T>(callback: () => Promise<T>) => {
        let lastError: unknown;
        for (let i = 0; i < 20; i += 1) {
            try {
                return await callback();
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    }),
    mockDelay: vi.fn(async () => undefined)
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://server.test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/utils/time', () => ({
    backoff: mockBackoff,
    delay: mockDelay
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeSession() {
    return {
        id: 'test-session-id',
        seq: 0,
        metadata: {
            path: '/tmp',
            host: 'localhost',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib',
            happyToolsDir: '/home/user/.happy/tools'
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const
    };
}

describe('ApiSessionClient', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;
    let session: ReturnType<typeof makeSession>;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        socketHandlers = {};
        session = makeSession();

        mockSocket = {
            connected: true,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            off: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
            volatile: {
                emit: vi.fn()
            },
            close: vi.fn()
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    // ─── SyncNodeToken resolution ──────────────────────────────────────────────

    it('returns the provided session-scoped sync token when it already matches the session', async () => {
        const token: import('@slopus/happy-sync').SyncNodeToken = {
            raw: 'session-token',
            claims: {
                scope: {
                    type: 'session' as const,
                    userId: 'user-1',
                    sessionId: 'test-session-id',
                },
                permissions: ['read', 'write'],
            },
        };

        await expect(resolveSessionScopedSyncNodeToken({
            serverUrl: 'https://server.test',
            sessionId: 'test-session-id',
            token,
        })).resolves.toEqual(token);
    });

    it('mints a session-scoped sync token when given an account-scoped token', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            token: 'minted-session-token',
            claims: {
                scope: {
                    type: 'session',
                    userId: 'user-1',
                    sessionId: 'test-session-id',
                },
                permissions: ['read', 'write'],
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        vi.stubGlobal('fetch', mockFetch);

        const resolved = await resolveSessionScopedSyncNodeToken({
            serverUrl: 'https://server.test',
            sessionId: 'test-session-id',
            token: {
                raw: 'account-token',
                claims: {
                    scope: {
                        type: 'account',
                        userId: 'user-1',
                    },
                    permissions: ['read', 'write', 'admin'],
                },
            },
        });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://server.test/v1/sessions/test-session-id/token',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer account-token',
                    'Content-Type': 'application/json',
                }),
            }),
        );
        expect(resolved).toEqual({
            raw: 'minted-session-token',
            claims: {
                scope: {
                    type: 'session',
                    userId: 'user-1',
                    sessionId: 'test-session-id',
                },
                permissions: ['read', 'write'],
            },
        });
    });

    it('rejects a mismatched session-scoped sync token', async () => {
        await expect(resolveSessionScopedSyncNodeToken({
            serverUrl: 'https://server.test',
            sessionId: 'test-session-id',
            token: {
                raw: 'session-token',
                claims: {
                    scope: {
                        type: 'session',
                        userId: 'user-1',
                        sessionId: 'other-session',
                    },
                    permissions: ['read', 'write'],
                },
            },
        })).rejects.toThrow('Session-scoped sync token targets other-session, expected test-session-id');
    });

    // ─── Socket setup ──────────────────────────────────────────────────────────

    it('registers core socket handlers and connects', () => {
        new ApiSessionClient('fake-token', session);

        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('update', expect.any(Function));
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    });

    // ─── Message transport via SyncBridge ──────────────────────────────────────

    it('drops messages when no SyncBridge is attached', () => {
        const client = new ApiSessionClient('fake-token', session);

        // Should not throw — just drops silently
        expect(() => {
            client.sendCodexMessage({ type: 'delta', text: 'hello' });
        }).not.toThrow();
    });

    it('sendV3ProtocolMessage drops message when no SyncBridge is attached', () => {
        const client = new ApiSessionClient('fake-token', session);

        // Should not throw — just drops silently
        expect(() => {
            client.sendV3ProtocolMessage({ info: { role: 'user' }, parts: [] } as any);
        }).not.toThrow();
    });

    // ─── Socket update handler ─────────────────────────────────────────────────

    it('skips new-message processing when SyncBridge is attached', () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        // Attach a mock SyncBridge
        (client as any).syncBridge = { sendMessage: vi.fn() };

        emitSocketEvent('update', {
            id: 'upd-1',
            seq: 1,
            createdAt: Date.now(),
            body: {
                t: 'new-message',
                sid: 'test-session-id',
                message: {
                    id: 'msg-1',
                    seq: 1,
                    localId: null,
                    content: { t: 'encrypted', c: 'fake-ciphertext' },
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                }
            }
        } satisfies Update);

        // Message should NOT be routed — SyncBridge handles it
        expect(onUserMessage).not.toHaveBeenCalled();
    });

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    it('closes socket and disconnects SyncBridge on close', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const mockBridgeDisconnect = vi.fn();
        (client as any).syncBridge = { disconnect: mockBridgeDisconnect };

        await client.close();

        expect(mockSocket.close).toHaveBeenCalledTimes(1);
        expect(mockBridgeDisconnect).toHaveBeenCalledTimes(1);
    });

    // ─── Keep alive ────────────────────────────────────────────────────────────

    it('sends keep-alive via socket volatile emit', () => {
        const client = new ApiSessionClient('fake-token', session);
        client.keepAlive(true, 'remote');

        expect(mockSocket.volatile.emit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'test-session-id',
            thinking: true,
            mode: 'remote'
        }));
    });

    it('sends session death via socket emit', () => {
        const client = new ApiSessionClient('fake-token', session);
        client.sendSessionDeath();

        expect(mockSocket.emit).toHaveBeenCalledWith('session-end', expect.objectContaining({
            sid: 'test-session-id'
        }));
    });
});
