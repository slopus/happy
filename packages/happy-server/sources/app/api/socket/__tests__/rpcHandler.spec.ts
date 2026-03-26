import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { DistributedRpcRegistry } from "@/modules/rpc/distributedRpc";
import { rpcHandler } from "../rpcHandler";

class MockSocket {
    id: string;
    connected = true;
    handshake: { auth: Record<string, unknown> };
    emit = vi.fn<(event: string, payload?: any) => boolean>(() => true);
    disconnect = vi.fn(() => {
        this.connected = false;
    });
    timeout = vi.fn((ms: number) => {
        this.timeoutDuration = ms;
        return {
            emitWithAck: this.emitWithAck,
        };
    });
    emitWithAck = vi.fn<(event: string, payload: any) => Promise<any>>(async () => undefined);
    timeoutDuration: number | null = null;

    private handlers = new Map<string, Array<(...args: any[]) => any>>();

    constructor(id: string, auth: Record<string, unknown> = {}) {
        this.id = id;
        this.handshake = { auth };
    }

    on(event: string, handler: (...args: any[]) => any): this {
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
        return this;
    }

    async trigger(event: string, ...args: any[]): Promise<void> {
        const handlers = this.handlers.get(event) ?? [];
        for (const handler of handlers) {
            await handler(...args);
        }
    }

    async simulateDisconnect(): Promise<void> {
        this.connected = false;
        await this.trigger('disconnect');
    }
}

afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
});

describe('rpcHandler', () => {
    function createRegistryMock() {
        return {
            register: vi.fn(async () => {}),
            unregister: vi.fn(async () => {}),
            call: vi.fn(async () => ({ ok: false, error: 'RPC method not available' })),
        } as unknown as DistributedRpcRegistry;
    }

    function attachRpcHandler(
        socket: MockSocket,
        rpcListeners: Map<string, Socket>,
        userId = 'user-1',
        registry?: DistributedRpcRegistry,
    ) {
        rpcHandler(userId, socket as unknown as Socket, rpcListeners, registry);
    }

    it('registers a method and acknowledges the registration', async () => {
        const rpcListeners = new Map<string, Socket>();
        const socket = new MockSocket('listener-socket');
        attachRpcHandler(socket, rpcListeners);

        await socket.trigger('rpc-register', { method: 'spawn-session' });

        expect(rpcListeners.get('spawn-session')).toBe(socket as unknown as Socket);
        expect(socket.emit).toHaveBeenCalledWith('rpc-registered', { method: 'spawn-session' });
    });

    it('registers distributed rpc methods when a registry is configured', async () => {
        const rpcListeners = new Map<string, Socket>();
        const socket = new MockSocket('listener-socket');
        const registry = createRegistryMock();
        attachRpcHandler(socket, rpcListeners, 'user-1', registry);

        await socket.trigger('rpc-register', { method: 'spawn-session' });

        expect((registry.register as any)).toHaveBeenCalledWith('user-1', 'spawn-session');
    });

    it('rolls back local registration if distributed registration fails', async () => {
        const socket = new MockSocket('listener-socket');
        const previousSocket = new MockSocket('previous-socket');
        const rpcListeners = new Map<string, Socket>([
            ['spawn-session', previousSocket as unknown as Socket],
        ]);
        const registry = createRegistryMock();
        (registry.register as any).mockRejectedValue(new Error('redis unavailable'));
        attachRpcHandler(socket, rpcListeners, 'user-1', registry);

        await socket.trigger('rpc-register', { method: 'spawn-session' });

        expect(rpcListeners.get('spawn-session')).toBe(previousSocket as unknown as Socket);
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register',
            error: 'Internal error',
        });
    });

    it('unregisters a method owned by the socket and acknowledges the removal', async () => {
        const rpcListeners = new Map<string, Socket>();
        const socket = new MockSocket('listener-socket');
        attachRpcHandler(socket, rpcListeners);

        await socket.trigger('rpc-register', { method: 'stop-session' });
        await socket.trigger('rpc-unregister', { method: 'stop-session' });

        expect(rpcListeners.has('stop-session')).toBe(false);
        expect(socket.emit).toHaveBeenNthCalledWith(1, 'rpc-registered', { method: 'stop-session' });
        expect(socket.emit).toHaveBeenNthCalledWith(2, 'rpc-unregistered', { method: 'stop-session' });
    });

    it('unregisters distributed rpc methods when a registry is configured', async () => {
        const rpcListeners = new Map<string, Socket>();
        const socket = new MockSocket('listener-socket');
        const registry = createRegistryMock();
        attachRpcHandler(socket, rpcListeners, 'user-1', registry);

        await socket.trigger('rpc-register', { method: 'stop-session' });
        await socket.trigger('rpc-unregister', { method: 'stop-session' });

        expect((registry.unregister as any)).toHaveBeenCalledWith('user-1', 'stop-session');
    });

    it('restores the local listener if distributed unregister fails', async () => {
        const rpcListeners = new Map<string, Socket>();
        const socket = new MockSocket('listener-socket');
        const registry = createRegistryMock();
        (registry.unregister as any).mockRejectedValue(new Error('redis unavailable'));
        attachRpcHandler(socket, rpcListeners, 'user-1', registry);

        await socket.trigger('rpc-register', { method: 'stop-session' });
        await socket.trigger('rpc-unregister', { method: 'stop-session' });

        expect(rpcListeners.get('stop-session')).toBe(socket as unknown as Socket);
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'unregister',
            error: 'Internal error',
        });
    });

    it('forwards rpc calls to the registered socket and returns the response', async () => {
        const rpcListeners = new Map<string, Socket>();
        const caller = new MockSocket('caller-socket');
        const target = new MockSocket('target-socket');
        const callback = vi.fn();

        target.emitWithAck.mockResolvedValue({ sessionId: 'session-1' });
        attachRpcHandler(caller, rpcListeners);
        attachRpcHandler(target, rpcListeners);

        await target.trigger('rpc-register', { method: 'spawn-session' });
        await caller.trigger('rpc-call', { method: 'spawn-session', params: { prompt: 'hello' } }, callback);

        expect(target.timeout).toHaveBeenCalledWith(30000);
        expect(target.emitWithAck).toHaveBeenCalledWith('rpc-request', {
            method: 'spawn-session',
            params: { prompt: 'hello' },
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { sessionId: 'session-1' },
        });
    });

    it('rejects rpc self-calls on the same socket', async () => {
        const rpcListeners = new Map<string, Socket>();
        const socket = new MockSocket('single-socket');
        const callback = vi.fn();
        attachRpcHandler(socket, rpcListeners);

        await socket.trigger('rpc-register', { method: 'spawn-session' });
        await socket.trigger('rpc-call', { method: 'spawn-session', params: {} }, callback);

        expect(socket.timeout).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: 'Cannot call RPC on the same socket',
        });
    });

    it('returns the timeout error when the target socket does not ack', async () => {
        const rpcListeners = new Map<string, Socket>();
        const caller = new MockSocket('caller-socket');
        const target = new MockSocket('target-socket');
        const callback = vi.fn();

        target.emitWithAck.mockRejectedValue(new Error('operation has timed out'));
        attachRpcHandler(caller, rpcListeners);
        attachRpcHandler(target, rpcListeners);

        await target.trigger('rpc-register', { method: 'permissions' });
        await caller.trigger('rpc-call', { method: 'permissions', params: { path: '/tmp' } }, callback);

        expect(target.timeout).toHaveBeenCalledWith(30000);
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: 'operation has timed out',
        });
    });

    it('delegates to the distributed registry when the method is not available locally', async () => {
        const rpcListeners = new Map<string, Socket>();
        const caller = new MockSocket('caller-socket');
        const callback = vi.fn();
        const registry = createRegistryMock();
        (registry.call as any).mockResolvedValue({
            ok: true,
            result: { source: 'remote-process' },
        });
        attachRpcHandler(caller, rpcListeners, 'user-1', registry);

        await caller.trigger('rpc-call', { method: 'spawn-session', params: { prompt: 'hello' } }, callback);

        expect((registry.call as any)).toHaveBeenCalledWith('user-1', 'spawn-session', { prompt: 'hello' });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { source: 'remote-process' },
        });
    });

    it('cleans up all methods owned by a socket when it disconnects', async () => {
        const rpcListeners = new Map<string, Socket>();
        const disconnectingSocket = new MockSocket('disconnecting-socket');
        const survivingSocket = new MockSocket('surviving-socket');
        const registry = createRegistryMock();
        attachRpcHandler(disconnectingSocket, rpcListeners, 'user-1', registry);
        attachRpcHandler(survivingSocket, rpcListeners, 'user-1', registry);

        await disconnectingSocket.trigger('rpc-register', { method: 'spawn-session' });
        await disconnectingSocket.trigger('rpc-register', { method: 'stop-session' });
        await survivingSocket.trigger('rpc-register', { method: 'permissions' });

        await disconnectingSocket.simulateDisconnect();

        expect(Array.from(rpcListeners.keys())).toEqual(['permissions']);
        expect(rpcListeners.get('permissions')).toBe(survivingSocket as unknown as Socket);
        expect((registry.unregister as any)).toHaveBeenCalledWith('user-1', 'spawn-session');
        expect((registry.unregister as any)).toHaveBeenCalledWith('user-1', 'stop-session');
        expect((registry.unregister as any)).not.toHaveBeenCalledWith('user-1', 'permissions');
    });

    it('uses the most recently registered socket for a method', async () => {
        const rpcListeners = new Map<string, Socket>();
        const caller = new MockSocket('caller-socket');
        const originalTarget = new MockSocket('original-target');
        const replacementTarget = new MockSocket('replacement-target');
        const callback = vi.fn();

        originalTarget.emitWithAck.mockResolvedValue({ source: 'original' });
        replacementTarget.emitWithAck.mockResolvedValue({ source: 'replacement' });
        attachRpcHandler(caller, rpcListeners);
        attachRpcHandler(originalTarget, rpcListeners);
        attachRpcHandler(replacementTarget, rpcListeners);

        await originalTarget.trigger('rpc-register', { method: 'spawn-session' });
        await replacementTarget.trigger('rpc-register', { method: 'spawn-session' });
        await caller.trigger('rpc-call', { method: 'spawn-session', params: { prompt: 'hello' } }, callback);

        expect(rpcListeners.get('spawn-session')).toBe(replacementTarget as unknown as Socket);
        expect(originalTarget.emitWithAck).not.toHaveBeenCalled();
        expect(replacementTarget.emitWithAck).toHaveBeenCalledWith('rpc-request', {
            method: 'spawn-session',
            params: { prompt: 'hello' },
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { source: 'replacement' },
        });
    });

    it('rejects invalid method names during registration', async () => {
        const rpcListeners = new Map<string, Socket>();
        const socket = new MockSocket('listener-socket');
        attachRpcHandler(socket, rpcListeners);

        await socket.trigger('rpc-register', { method: 123 });

        expect(rpcListeners.size).toBe(0);
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register',
            error: 'Invalid method name',
        });
    });
});

describe('startSocket rpc listener cleanup', () => {
    it('creates a distributed rpc registry for Redis backplanes and destroys it on shutdown', async () => {
        vi.resetModules();

        const capturedRegistries: unknown[] = [];
        const shutdownHandlers = new Map<string, () => Promise<void>>();
        const rpcRegistry = {
            destroy: vi.fn(async () => {}),
        };
        const createRegistry = vi.fn(async () => rpcRegistry);
        let serverInstance: FakeServer | undefined;

        class FakeServer {
            connectionHandler?: (socket: Socket) => Promise<void>;
            close = vi.fn(async () => {});

            constructor() {
                serverInstance = this;
            }

            on(event: string, handler: (socket: Socket) => Promise<void>): this {
                if (event === 'connection') {
                    this.connectionHandler = handler;
                }
                return this;
            }
        }

        class FakeRedisBackplane {
            getProcessId() {
                return 'process-1';
            }
        }

        vi.doMock('socket.io', () => ({
            Server: FakeServer,
        }));
        vi.doMock('@/utils/shutdown', () => ({
            onShutdown: vi.fn((name: string, callback: () => Promise<void>) => {
                shutdownHandlers.set(name, callback);
                return () => shutdownHandlers.delete(name);
            }),
        }));
        vi.doMock('@/modules/backplane/redisBackplane', () => ({
            RedisBackplane: FakeRedisBackplane,
        }));
        vi.doMock('@/modules/rpc/distributedRpc', () => ({
            DistributedRpcRegistry: {
                create: createRegistry,
            },
        }));
        vi.doMock('@/app/events/eventRouter', () => ({
            buildMachineActivityEphemeral: vi.fn(() => ({ type: 'machine-activity' })),
            eventRouter: {
                addConnection: vi.fn(),
                removeConnection: vi.fn(),
                emitEphemeral: vi.fn(),
            },
        }));
        vi.doMock('@/utils/log', () => ({
            log: vi.fn(),
        }));
        vi.doMock('@/app/auth/auth', () => ({
            auth: {
                verifyToken: vi.fn(async () => ({ userId: 'user-1' })),
            },
        }));
        vi.doMock('@/app/monitoring/metrics2', () => ({
            decrementWebSocketConnection: vi.fn(),
            incrementWebSocketConnection: vi.fn(),
            websocketEventsCounter: {
                inc: vi.fn(),
            },
        }));
        vi.doMock('../usageHandler', () => ({
            usageHandler: vi.fn(),
        }));
        vi.doMock('../pingHandler', () => ({
            pingHandler: vi.fn(),
        }));
        vi.doMock('../sessionUpdateHandler', () => ({
            sessionUpdateHandler: vi.fn(),
        }));
        vi.doMock('../machineUpdateHandler', () => ({
            machineUpdateHandler: vi.fn(),
        }));
        vi.doMock('../artifactUpdateHandler', () => ({
            artifactUpdateHandler: vi.fn(),
        }));
        vi.doMock('../accessKeyHandler', () => ({
            accessKeyHandler: vi.fn(),
        }));
        vi.doMock('../rpcHandler', () => ({
            rpcHandler: vi.fn((userId: string, socket: Socket, userRpcListeners: Map<string, Socket>, registry?: unknown) => {
                void userId;
                void socket;
                capturedRegistries.push(registry);
                return userRpcListeners;
            }),
        }));

        const { startSocket } = await import('../../socket');
        const backplane = new FakeRedisBackplane();
        await startSocket({ server: {} } as any, backplane as any);

        expect(createRegistry).toHaveBeenCalledWith(backplane, expect.any(Map));
        expect(serverInstance?.connectionHandler).toBeDefined();

        const socket = new MockSocket('socket-1', { token: 'token', clientType: 'user-scoped' });
        await serverInstance!.connectionHandler!(socket as unknown as Socket);

        expect(capturedRegistries).toEqual([rpcRegistry]);
        expect(shutdownHandlers.has('api')).toBe(true);

        await shutdownHandlers.get('api')!();

        expect(rpcRegistry.destroy).toHaveBeenCalledTimes(1);
        expect(serverInstance?.close).toHaveBeenCalledTimes(1);
    });

    it('drops empty user rpc listener maps after disconnect so reconnects get a fresh map', async () => {
        vi.resetModules();

        const capturedRpcListenerMaps: Array<Map<string, Socket>> = [];
        let serverInstance: FakeServer | undefined;

        class FakeServer {
            connectionHandler?: (socket: Socket) => Promise<void>;
            close = vi.fn(async () => {});

            constructor() {
                serverInstance = this;
            }

            on(event: string, handler: (socket: Socket) => Promise<void>): this {
                if (event === 'connection') {
                    this.connectionHandler = handler;
                }
                return this;
            }
        }

        vi.doMock('socket.io', () => ({
            Server: FakeServer,
        }));
        vi.doMock('@/utils/shutdown', () => ({
            onShutdown: vi.fn(),
        }));
        vi.doMock('@/app/events/eventRouter', () => ({
            buildMachineActivityEphemeral: vi.fn(() => ({ type: 'machine-activity' })),
            eventRouter: {
                addConnection: vi.fn(),
                removeConnection: vi.fn(),
                emitEphemeral: vi.fn(),
            },
        }));
        vi.doMock('@/utils/log', () => ({
            log: vi.fn(),
        }));
        vi.doMock('@/app/auth/auth', () => ({
            auth: {
                verifyToken: vi.fn(async () => ({ userId: 'user-1' })),
            },
        }));
        vi.doMock('@/app/monitoring/metrics2', () => ({
            decrementWebSocketConnection: vi.fn(),
            incrementWebSocketConnection: vi.fn(),
            websocketEventsCounter: {
                inc: vi.fn(),
            },
        }));
        vi.doMock('../usageHandler', () => ({
            usageHandler: vi.fn(),
        }));
        vi.doMock('../pingHandler', () => ({
            pingHandler: vi.fn(),
        }));
        vi.doMock('../sessionUpdateHandler', () => ({
            sessionUpdateHandler: vi.fn(),
        }));
        vi.doMock('../machineUpdateHandler', () => ({
            machineUpdateHandler: vi.fn(),
        }));
        vi.doMock('../artifactUpdateHandler', () => ({
            artifactUpdateHandler: vi.fn(),
        }));
        vi.doMock('../accessKeyHandler', () => ({
            accessKeyHandler: vi.fn(),
        }));
        vi.doMock('../rpcHandler', () => ({
            rpcHandler: vi.fn((userId: string, socket: Socket, userRpcListeners: Map<string, Socket>) => {
                capturedRpcListenerMaps.push(userRpcListeners);
                (socket as unknown as MockSocket).on('disconnect', () => {
                    userRpcListeners.clear();
                });
            }),
        }));

        const { startSocket } = await import('../../socket');
        await startSocket({ server: {} } as any);

        expect(serverInstance?.connectionHandler).toBeDefined();

        const firstSocket = new MockSocket('first-socket', { token: 'token', clientType: 'user-scoped' });
        const secondSocket = new MockSocket('second-socket', { token: 'token', clientType: 'user-scoped' });

        await serverInstance!.connectionHandler!(firstSocket as unknown as Socket);
        await firstSocket.simulateDisconnect();
        await serverInstance!.connectionHandler!(secondSocket as unknown as Socket);

        expect(capturedRpcListenerMaps).toHaveLength(2);
        expect(capturedRpcListenerMaps[1]).not.toBe(capturedRpcListenerMaps[0]);
    });
});
