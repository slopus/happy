import { afterEach, describe, expect, it, vi } from "vitest";
import { Socket } from "socket.io";
import {
    ClientConnection,
    EphemeralPayload,
    EventRouter,
    RecipientFilter,
    UpdatePayload,
} from "@/app/events/eventRouter";
import { MemoryBackplane } from "@/modules/backplane/memoryBackplane";

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

function createUpdatePayload(id: string): UpdatePayload {
    return {
        id,
        seq: 1,
        body: {
            t: 'new-message',
            sid: 'session-1',
            message: {
                id: 'message-1'
            }
        },
        createdAt: Date.now()
    };
}

function createEphemeralPayload(id: string): EphemeralPayload {
    return {
        type: 'activity',
        id,
        active: true,
        activeAt: Date.now()
    };
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('EventRouter', () => {
    const backplanes: MemoryBackplane[] = [];

    afterEach(async () => {
        await Promise.all(backplanes.splice(0).map((backplane) => backplane.destroy()));
    });

    async function createBackplaneRouterPair(): Promise<{
        senderRouter: EventRouter;
        receiverRouter: EventRouter;
        senderBackplane: MemoryBackplane;
        receiverBackplane: MemoryBackplane;
    }> {
        const senderBackplane = new MemoryBackplane();
        const receiverBackplane = new MemoryBackplane();
        backplanes.push(senderBackplane, receiverBackplane);

        const senderRouter = new EventRouter();
        const receiverRouter = new EventRouter();
        await senderRouter.init(senderBackplane);
        await receiverRouter.init(receiverBackplane);

        return {
            senderRouter,
            receiverRouter,
            senderBackplane,
            receiverBackplane,
        };
    }

    async function expectFilterDelivery(
        filter: RecipientFilter,
        expectedRecipientIds: string[]
    ): Promise<void> {
        const { senderRouter, receiverRouter } = await createBackplaneRouterPair();
        const userId = 'user-1';
        const payload = createUpdatePayload(`update-${filter.type}`);

        const userScoped = createUserConnection(userId, `user-${filter.type}`);
        const matchingSession = createSessionConnection(userId, `session-match-${filter.type}`, 'session-1');
        const otherSession = createSessionConnection(userId, `session-other-${filter.type}`, 'session-2');
        const matchingMachine = createMachineConnection(userId, `machine-match-${filter.type}`, 'machine-1');
        const otherMachine = createMachineConnection(userId, `machine-other-${filter.type}`, 'machine-2');

        receiverRouter.addConnection(userId, userScoped.connection);
        receiverRouter.addConnection(userId, matchingSession.connection);
        receiverRouter.addConnection(userId, otherSession.connection);
        receiverRouter.addConnection(userId, matchingMachine.connection);
        receiverRouter.addConnection(userId, otherMachine.connection);

        senderRouter.emitUpdate({
            userId,
            payload,
            recipientFilter: filter,
        });
        await flushAsyncWork();

        const allSockets = [
            userScoped.socket,
            matchingSession.socket,
            otherSession.socket,
            matchingMachine.socket,
            otherMachine.socket,
        ];

        for (const socket of allSockets) {
            if (expectedRecipientIds.includes(socket.id)) {
                expect(socket.emit).toHaveBeenCalledTimes(1);
                expect(socket.emit).toHaveBeenCalledWith('update', payload);
            } else {
                expect(socket.emit).not.toHaveBeenCalled();
            }
        }
    }

    it('delivers updates across router instances through the backplane', async () => {
        const { senderRouter, receiverRouter } = await createBackplaneRouterPair();
        const userId = 'user-1';
        const payload = createUpdatePayload('cross-instance-update');
        const receiver = createUserConnection(userId, 'receiver-socket');

        receiverRouter.addConnection(userId, receiver.connection);
        senderRouter.emitUpdate({
            userId,
            payload,
        });
        await flushAsyncWork();

        expect(receiver.socket.emit).toHaveBeenCalledTimes(1);
        expect(receiver.socket.emit).toHaveBeenCalledWith('update', payload);
    });

    it('delivers ephemerals across router instances through the backplane', async () => {
        const { senderRouter, receiverRouter } = await createBackplaneRouterPair();
        const userId = 'user-1';
        const payload = createEphemeralPayload('session-1');
        const receiver = createUserConnection(userId, 'receiver-ephemeral');

        receiverRouter.addConnection(userId, receiver.connection);
        senderRouter.emitEphemeral({
            userId,
            payload,
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        expect(receiver.socket.emit).toHaveBeenCalledTimes(1);
        expect(receiver.socket.emit).toHaveBeenCalledWith('ephemeral', payload);
    });

    it('applies all-interested-in-session filtering across processes', async () => {
        await expectFilterDelivery(
            { type: 'all-interested-in-session', sessionId: 'session-1' },
            [
                'user-all-interested-in-session',
                'session-match-all-interested-in-session'
            ]
        );
    });

    it('applies user-scoped-only filtering across processes', async () => {
        await expectFilterDelivery(
            { type: 'user-scoped-only' },
            ['user-user-scoped-only']
        );
    });

    it('applies machine-scoped-only filtering across processes', async () => {
        await expectFilterDelivery(
            { type: 'machine-scoped-only', machineId: 'machine-1' },
            [
                'user-machine-scoped-only',
                'machine-match-machine-scoped-only'
            ]
        );
    });

    it('applies all-user-authenticated-connections filtering across processes', async () => {
        await expectFilterDelivery(
            { type: 'all-user-authenticated-connections' },
            [
                'user-all-user-authenticated-connections',
                'session-match-all-user-authenticated-connections',
                'session-other-all-user-authenticated-connections',
                'machine-match-all-user-authenticated-connections',
                'machine-other-all-user-authenticated-connections'
            ]
        );
    });

    it('skips the sender socket on the originating process while still delivering cross-process', async () => {
        const { senderRouter, receiverRouter } = await createBackplaneRouterPair();
        const userId = 'user-1';
        const payload = createUpdatePayload('skip-source');

        const senderConnection = createUserConnection(userId, 'sender-socket');
        const localPeerConnection = createUserConnection(userId, 'local-peer-socket');
        const remoteConnection = createUserConnection(userId, 'remote-socket');

        senderRouter.addConnection(userId, senderConnection.connection);
        senderRouter.addConnection(userId, localPeerConnection.connection);
        receiverRouter.addConnection(userId, remoteConnection.connection);

        senderRouter.emitUpdate({
            userId,
            payload,
            skipSenderConnection: senderConnection.connection,
        });
        await flushAsyncWork();

        expect(senderConnection.socket.emit).not.toHaveBeenCalled();
        expect(localPeerConnection.socket.emit).toHaveBeenCalledTimes(1);
        expect(localPeerConnection.socket.emit).toHaveBeenCalledWith('update', payload);
        expect(remoteConnection.socket.emit).toHaveBeenCalledTimes(1);
        expect(remoteConnection.socket.emit).toHaveBeenCalledWith('update', payload);
    });

    it('works in legacy local-only mode when init is not called', async () => {
        const router = new EventRouter();
        const userId = 'user-1';
        const payload = createUpdatePayload('legacy');
        const senderConnection = createUserConnection(userId, 'legacy-sender');
        const receiverConnection = createUserConnection(userId, 'legacy-receiver');

        router.addConnection(userId, senderConnection.connection);
        router.addConnection(userId, receiverConnection.connection);
        router.emitUpdate({
            userId,
            payload,
            skipSenderConnection: senderConnection.connection,
        });

        expect(senderConnection.socket.emit).not.toHaveBeenCalled();
        expect(receiverConnection.socket.emit).toHaveBeenCalledTimes(1);
        expect(receiverConnection.socket.emit).toHaveBeenCalledWith('update', payload);
    });

    it('subscribes on first connection and unsubscribes after the last disconnect', async () => {
        const { senderRouter, receiverRouter } = await createBackplaneRouterPair();
        const userId = 'user-1';

        const firstConnection = createUserConnection(userId, 'lifecycle-first');
        const secondConnection = createUserConnection(userId, 'lifecycle-second');
        receiverRouter.addConnection(userId, firstConnection.connection);
        receiverRouter.addConnection(userId, secondConnection.connection);

        const initialPayload = createEphemeralPayload('session-initial');
        senderRouter.emitEphemeral({
            userId,
            payload: initialPayload,
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        expect(firstConnection.socket.emit).toHaveBeenCalledTimes(1);
        expect(secondConnection.socket.emit).toHaveBeenCalledTimes(1);

        receiverRouter.removeConnection(userId, firstConnection.connection);
        const afterSingleDisconnectPayload = createEphemeralPayload('session-still-subscribed');
        senderRouter.emitEphemeral({
            userId,
            payload: afterSingleDisconnectPayload,
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        expect(firstConnection.socket.emit).toHaveBeenCalledTimes(1);
        expect(secondConnection.socket.emit).toHaveBeenCalledTimes(2);
        expect(secondConnection.socket.emit).toHaveBeenLastCalledWith('ephemeral', afterSingleDisconnectPayload);

        receiverRouter.removeConnection(userId, secondConnection.connection);
        await flushAsyncWork();

        const afterLastDisconnectPayload = createEphemeralPayload('session-unsubscribed');
        senderRouter.emitEphemeral({
            userId,
            payload: afterLastDisconnectPayload,
            recipientFilter: { type: 'user-scoped-only' }
        });
        await flushAsyncWork();

        expect(firstConnection.socket.emit).toHaveBeenCalledTimes(1);
        expect(secondConnection.socket.emit).toHaveBeenCalledTimes(2);
    });

    it('subscribes existing users when init is called after connections already exist', async () => {
        const senderBackplane = new MemoryBackplane();
        const receiverBackplane = new MemoryBackplane();
        backplanes.push(senderBackplane, receiverBackplane);

        const senderRouter = new EventRouter();
        const receiverRouter = new EventRouter();
        const receiver = createUserConnection('user-1', 'late-init-receiver');

        receiverRouter.addConnection('user-1', receiver.connection);

        await senderRouter.init(senderBackplane);
        await receiverRouter.init(receiverBackplane);

        const payload = createUpdatePayload('late-init');
        senderRouter.emitUpdate({
            userId: 'user-1',
            payload,
        });
        await flushAsyncWork();

        expect(receiver.socket.emit).toHaveBeenCalledTimes(1);
        expect(receiver.socket.emit).toHaveBeenCalledWith('update', payload);
    });
});
