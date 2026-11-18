import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RpcHandlerManager } from './RpcHandlerManager';

function mockSocket() {
    const listeners: Record<string, Function[]> = {};
    const socket = {
        on: vi.fn((event: string, handler: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(handler);
        }),
        emit: vi.fn(),
        timeout: vi.fn(() => socket),
        emitWithAck: vi.fn(),
        id: 'mock-socket-id',
        _listeners: listeners,
    };
    return socket;
}

function createManager() {
    const logs: string[] = [];
    const manager = new RpcHandlerManager({
        scopePrefix: 'test-scope',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        logger: (msg: string) => logs.push(msg),
    });
    return { manager, logs };
}

describe('RpcHandlerManager', () => {

    describe('onSocketConnect', () => {
        it('should await rpc-registered ack for each handler', async () => {
            const { manager } = createManager();
            const socket = mockSocket();

            manager.registerHandler('method-a', async () => 'ok-a');
            manager.registerHandler('method-b', async () => 'ok-b');

            // emitWithAck resolves immediately for each registration
            let ackCount = 0;
            socket.emitWithAck.mockImplementation(() => {
                ackCount++;
                return Promise.resolve({ method: `test-scope:method-${ackCount}` });
            });

            manager.onSocketConnect(socket as any);

            // Wait for async registration to complete
            await vi.waitFor(() => {
                expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
            });

            expect(socket.emitWithAck).toHaveBeenCalledWith('rpc-register', { method: 'test-scope:method-a' });
            expect(socket.emitWithAck).toHaveBeenCalledWith('rpc-register', { method: 'test-scope:method-b' });
        });

        it('should continue registering remaining handlers when one ack times out', async () => {
            const { manager, logs } = createManager();
            const socket = mockSocket();

            manager.registerHandler('method-a', async () => 'ok-a');
            manager.registerHandler('method-b', async () => 'ok-b');

            let callIndex = 0;
            socket.emitWithAck.mockImplementation(() => {
                callIndex++;
                if (callIndex === 1) {
                    // First registration times out
                    return new Promise((_, reject) => {
                        const err = new Error('timeout');
                        (err as any).message = 'timeout';
                        reject(err);
                    });
                }
                return Promise.resolve({ method: 'test-scope:method-b' });
            });

            manager.onSocketConnect(socket as any);

            await vi.waitFor(() => {
                expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
            });

            // Both methods should have been attempted
            expect(logs).toContainEqual(expect.stringContaining('Registration ack timeout'));
            expect(logs).toContainEqual(expect.stringContaining('Registered 2 handlers'));
        });

        it('should abort if socket is replaced during registration', async () => {
            const { manager } = createManager();
            const socket1 = mockSocket();
            const socket2 = mockSocket();

            manager.registerHandler('method-a', async () => 'ok-a');
            manager.registerHandler('method-b', async () => 'ok-b');

            let callIndex = 0;
            socket1.emitWithAck.mockImplementation(async () => {
                callIndex++;
                // After first registration, simulate reconnect replacing the socket
                if (callIndex === 1) {
                    manager.onSocketDisconnect();
                    manager.onSocketConnect(socket2 as any);
                }
                return { method: `test-scope:method-${callIndex}` };
            });

            socket2.emitWithAck.mockResolvedValue({ method: 'test-scope:method-a' });

            manager.onSocketConnect(socket1 as any);

            // socket1 should only have registered once (then aborted)
            await vi.waitFor(() => {
                expect(socket1.emitWithAck).toHaveBeenCalledTimes(1);
            });

            // socket2 should have registered all methods
            expect(socket2.emitWithAck).toHaveBeenCalled();
        });
    });

    describe('registerHandler', () => {
        it('should emit rpc-register when socket is connected', () => {
            const { manager } = createManager();
            const socket = mockSocket();

            // Connect socket first
            socket.emitWithAck.mockResolvedValue({});
            manager.onSocketConnect(socket as any);

            manager.registerHandler('new-method', async () => 'ok');

            // Fire-and-forget emit for late registration
            expect(socket.emit).toHaveBeenCalledWith('rpc-register', { method: 'test-scope:new-method' });
        });

        it('should not emit when socket is not connected', () => {
            const { manager } = createManager();

            manager.registerHandler('new-method', async () => 'ok');
            // No socket, no emit — should not throw
        });
    });

    describe('unregisterHandler', () => {
        it('should emit rpc-unregister when socket is connected', () => {
            const { manager } = createManager();
            const socket = mockSocket();

            socket.emitWithAck.mockResolvedValue({});
            manager.onSocketConnect(socket as any);

            manager.registerHandler('to-remove', async () => 'ok');
            manager.unregisterHandler('to-remove');

            expect(socket.emit).toHaveBeenCalledWith('rpc-unregister', { method: 'test-scope:to-remove' });
        });
    });

    describe('hasHandler', () => {
        it('should return true for registered handlers', () => {
            const { manager } = createManager();
            manager.registerHandler('exists', async () => 'ok');
            expect(manager.hasHandler('exists')).toBe(true);
            expect(manager.hasHandler('nope')).toBe(false);
        });
    });

    describe('getHandlerCount', () => {
        it('should return correct count', () => {
            const { manager } = createManager();
            expect(manager.getHandlerCount()).toBe(0);
            manager.registerHandler('a', async () => 'ok');
            manager.registerHandler('b', async () => 'ok');
            expect(manager.getHandlerCount()).toBe(2);
            manager.unregisterHandler('a');
            expect(manager.getHandlerCount()).toBe(1);
        });
    });

    describe('clearHandlers', () => {
        it('should remove all handlers', () => {
            const { manager } = createManager();
            manager.registerHandler('a', async () => 'ok');
            manager.registerHandler('b', async () => 'ok');
            manager.clearHandlers();
            expect(manager.getHandlerCount()).toBe(0);
        });
    });
});
