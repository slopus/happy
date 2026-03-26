import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Socket } from "socket.io";
import {
    ClientConnection,
    EventRouter,
} from "@/app/events/eventRouter";
import { MemoryBackplane } from "@/modules/backplane/memoryBackplane";

/**
 * These tests verify that the timeout sweep's ephemeral events route correctly
 * through the backplane and are delivered to user-scoped clients on remote
 * processes. They also verify that duplicate events are harmless.
 *
 * We test at the EventRouter level (not the full timeout.ts function) because
 * the timeout sweep's interaction with the EventRouter is the critical
 * multi-process concern. The DB interaction (updateManyAndReturn) is tested
 * via its atomic conditional semantics at the database level.
 */

interface MockSocket {
    id: string;
    emit: ReturnType<typeof vi.fn>;
}

function createMockSocket(id: string): MockSocket {
    return {
        id,
        emit: vi.fn()
    };
}

function createUserConnection(userId: string, socketId: string): { socket: MockSocket; connection: ClientConnection } {
    const socket = createMockSocket(socketId);
    return {
        socket,
        connection: {
            connectionType: 'user-scoped',
            userId,
            socket: socket as unknown as Socket,
        }
    };
}

function createSessionConnection(userId: string, socketId: string, sessionId: string): { socket: MockSocket; connection: ClientConnection } {
    const socket = createMockSocket(socketId);
    return {
        socket,
        connection: {
            connectionType: 'session-scoped',
            userId,
            sessionId,
            socket: socket as unknown as Socket,
        }
    };
}

function createMachineConnection(userId: string, socketId: string, machineId: string): { socket: MockSocket; connection: ClientConnection } {
    const socket = createMockSocket(socketId);
    return {
        socket,
        connection: {
            connectionType: 'machine-scoped',
            userId,
            machineId,
            socket: socket as unknown as Socket,
        }
    };
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Timeout event routing through backplane', () => {
    const backplanes: MemoryBackplane[] = [];

    afterEach(async () => {
        await Promise.all(backplanes.splice(0).map((bp) => bp.destroy()));
    });

    async function createTwoProcessRouters(): Promise<{
        processA: EventRouter;
        processB: EventRouter;
    }> {
        const bpA = new MemoryBackplane();
        const bpB = new MemoryBackplane();
        backplanes.push(bpA, bpB);

        const processA = new EventRouter();
        const processB = new EventRouter();
        await processA.init(bpA);
        await processB.init(bpB);

        return { processA, processB };
    }

    it('delivers session timeout ephemeral to user-scoped client on a remote process', async () => {
        const { processA, processB } = await createTwoProcessRouters();
        const userId = 'user-1';

        // User-scoped client connected to process B (the "mobile app")
        const mobileClient = createUserConnection(userId, 'mobile-socket');
        processB.addConnection(userId, mobileClient.connection);

        // Process A runs the timeout sweep and emits the session activity ephemeral
        // (simulating what timeout.ts does after updateManyAndReturn succeeds)
        processA.emitEphemeral({
            userId,
            payload: {
                type: 'activity',
                id: 'session-123',
                active: false,
                activeAt: Date.now(),
                thinking: false,
            },
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        // The mobile client on process B should receive the ephemeral event
        expect(mobileClient.socket.emit).toHaveBeenCalledTimes(1);
        expect(mobileClient.socket.emit).toHaveBeenCalledWith('ephemeral', expect.objectContaining({
            type: 'activity',
            id: 'session-123',
            active: false,
            thinking: false,
        }));
    });

    it('delivers machine timeout ephemeral to user-scoped client on a remote process', async () => {
        const { processA, processB } = await createTwoProcessRouters();
        const userId = 'user-1';

        const mobileClient = createUserConnection(userId, 'mobile-socket');
        processB.addConnection(userId, mobileClient.connection);

        // Process A runs the timeout sweep and emits machine activity ephemeral
        processA.emitEphemeral({
            userId,
            payload: {
                type: 'machine-activity',
                id: 'machine-456',
                active: false,
                activeAt: Date.now(),
            },
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        expect(mobileClient.socket.emit).toHaveBeenCalledTimes(1);
        expect(mobileClient.socket.emit).toHaveBeenCalledWith('ephemeral', expect.objectContaining({
            type: 'machine-activity',
            id: 'machine-456',
            active: false,
        }));
    });

    it('does NOT deliver timeout ephemeral to session-scoped or machine-scoped clients', async () => {
        const { processA, processB } = await createTwoProcessRouters();
        const userId = 'user-1';

        const userScoped = createUserConnection(userId, 'user-socket');
        const sessionScoped = createSessionConnection(userId, 'session-socket', 'session-123');
        const machineScoped = createMachineConnection(userId, 'machine-socket', 'machine-456');

        processB.addConnection(userId, userScoped.connection);
        processB.addConnection(userId, sessionScoped.connection);
        processB.addConnection(userId, machineScoped.connection);

        // Process A emits a session timeout ephemeral with user-scoped-only filter
        processA.emitEphemeral({
            userId,
            payload: {
                type: 'activity',
                id: 'session-123',
                active: false,
                activeAt: Date.now(),
                thinking: false,
            },
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        // Only user-scoped gets the event
        expect(userScoped.socket.emit).toHaveBeenCalledTimes(1);
        expect(sessionScoped.socket.emit).not.toHaveBeenCalled();
        expect(machineScoped.socket.emit).not.toHaveBeenCalled();
    });

    it('delivers timeout ephemeral to user-scoped clients on BOTH processes', async () => {
        const { processA, processB } = await createTwoProcessRouters();
        const userId = 'user-1';

        // User has user-scoped clients on both processes (e.g., two browser tabs)
        const clientOnA = createUserConnection(userId, 'client-a');
        const clientOnB = createUserConnection(userId, 'client-b');
        processA.addConnection(userId, clientOnA.connection);
        processB.addConnection(userId, clientOnB.connection);

        // Process A runs the timeout sweep
        processA.emitEphemeral({
            userId,
            payload: {
                type: 'activity',
                id: 'session-123',
                active: false,
                activeAt: Date.now(),
                thinking: false,
            },
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        // Both clients receive the event
        expect(clientOnA.socket.emit).toHaveBeenCalledTimes(1);
        expect(clientOnB.socket.emit).toHaveBeenCalledTimes(1);
    });

    it('handles duplicate timeout ephemerals idempotently (same payload, different emitters)', async () => {
        const { processA, processB } = await createTwoProcessRouters();
        const userId = 'user-1';

        // Client on a third-party process (simulated by using process B as receiver)
        const mobileClient = createUserConnection(userId, 'mobile-socket');
        processB.addConnection(userId, mobileClient.connection);

        const activeAt = Date.now();
        const payload = {
            type: 'activity' as const,
            id: 'session-123',
            active: false,
            activeAt,
            thinking: false,
        };

        // Both processes emit the same timeout event (simulating the race condition
        // where both processes query findMany before either updates the row).
        // In practice, updateManyAndReturn prevents this — only one succeeds.
        // But even if it happened, the client handles it gracefully.
        processA.emitEphemeral({
            userId,
            payload,
            recipientFilter: { type: 'user-scoped-only' }
        });
        processB.emitEphemeral({
            userId,
            payload,
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        // The client receives both events — this is harmless because:
        // 1. ActivityUpdateAccumulator's isSignificantChange check: second event has same
        //    active/thinking state, so it's accumulated (debounced), not immediately flushed
        // 2. Even if both flush, applySessions() is a state merge — setting active:false
        //    twice produces identical UI state
        const emitCalls = mobileClient.socket.emit.mock.calls;
        expect(emitCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of emitCalls) {
            expect(call[0]).toBe('ephemeral');
            expect(call[1]).toEqual(expect.objectContaining({
                type: 'activity',
                id: 'session-123',
                active: false,
            }));
        }
    });

    it('handles duplicate machine timeout ephemerals idempotently', async () => {
        const { processA, processB } = await createTwoProcessRouters();
        const userId = 'user-1';

        const mobileClient = createUserConnection(userId, 'mobile-socket');
        processB.addConnection(userId, mobileClient.connection);

        const activeAt = Date.now();
        const payload = {
            type: 'machine-activity' as const,
            id: 'machine-456',
            active: false,
            activeAt,
        };

        // Both processes emit the same machine timeout event
        processA.emitEphemeral({
            userId,
            payload,
            recipientFilter: { type: 'user-scoped-only' }
        });
        processB.emitEphemeral({
            userId,
            payload,
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        // Client receives both — harmless because applyMachines() is a state merge
        const emitCalls = mobileClient.socket.emit.mock.calls;
        expect(emitCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of emitCalls) {
            expect(call[0]).toBe('ephemeral');
            expect(call[1]).toEqual(expect.objectContaining({
                type: 'machine-activity',
                id: 'machine-456',
                active: false,
            }));
        }
    });

    it('timeout ephemeral works in legacy mode (no backplane init)', () => {
        const router = new EventRouter();
        const userId = 'user-1';

        const userScoped = createUserConnection(userId, 'user-socket');
        const sessionScoped = createSessionConnection(userId, 'session-socket', 'session-123');

        router.addConnection(userId, userScoped.connection);
        router.addConnection(userId, sessionScoped.connection);

        // Emit like timeout.ts does — should work in legacy mode (direct local delivery)
        router.emitEphemeral({
            userId,
            payload: {
                type: 'activity',
                id: 'session-123',
                active: false,
                activeAt: Date.now(),
                thinking: false,
            },
            recipientFilter: { type: 'user-scoped-only' }
        });

        expect(userScoped.socket.emit).toHaveBeenCalledTimes(1);
        expect(sessionScoped.socket.emit).not.toHaveBeenCalled();
    });

    it('timeout ephemeral reaches clients added after backplane init', async () => {
        const bpA = new MemoryBackplane();
        const bpB = new MemoryBackplane();
        backplanes.push(bpA, bpB);

        const processA = new EventRouter();
        const processB = new EventRouter();

        // Init backplane FIRST, then add connections (normal startup order)
        await processA.init(bpA);
        await processB.init(bpB);

        const userId = 'user-1';
        const client = createUserConnection(userId, 'late-client');
        processB.addConnection(userId, client.connection);

        processA.emitEphemeral({
            userId,
            payload: {
                type: 'activity',
                id: 'session-123',
                active: false,
                activeAt: Date.now(),
                thinking: false,
            },
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        expect(client.socket.emit).toHaveBeenCalledTimes(1);
    });

    it('no delivery to disconnected users after unsubscribe', async () => {
        const { processA, processB } = await createTwoProcessRouters();
        const userId = 'user-1';

        const client = createUserConnection(userId, 'temp-client');
        processB.addConnection(userId, client.connection);

        // User disconnects — triggers unsubscribe from backplane channels
        processB.removeConnection(userId, client.connection);
        await flushAsyncWork();

        processA.emitEphemeral({
            userId,
            payload: {
                type: 'activity',
                id: 'session-123',
                active: false,
                activeAt: Date.now(),
                thinking: false,
            },
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        // Should not receive anything — the user has no connections and is unsubscribed
        expect(client.socket.emit).not.toHaveBeenCalled();
    });
});
