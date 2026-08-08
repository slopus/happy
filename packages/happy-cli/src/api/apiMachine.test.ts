import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';

const {
    mockIo,
    mockShouldReconnect,
    mockRpcHandlers
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true),
    mockRpcHandlers: {} as Record<string, (...args: any[]) => any>
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn((name: string, handler: (...args: any[]) => any) => {
            mockRpcHandlers[name] = handler;
        });
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
    }
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false
    }))
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of Object.keys(mockRpcHandlers)) {
            delete mockRpcHandlers[key];
        }
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn()
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({
            reconnection: false
        }));
        expect(mockSocket.connect).not.toHaveBeenCalled();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    it('emits machine-alive immediately when the socket connects', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive')).toHaveLength(0);

        emitSocketEvent('connect');

        let aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(1);
        expect(aliveCalls[0][1]).toEqual(expect.objectContaining({
            machineId: 'test-machine-id',
            time: expect.any(Number)
        }));

        await vi.advanceTimersByTimeAsync(19999);
        aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(2);

        client.shutdown();
    });

    it('registers terminal RPC handlers, stream rooms, and decrypts input frames', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));

        const terminalManager = {
            start: vi.fn(),
            create: vi.fn(async () => ({ type: 'success', terminalId: 'term-1' })),
            approve: vi.fn(),
            attach: vi.fn(),
            list: vi.fn(async () => []),
            close: vi.fn(),
            applyInput: vi.fn(() => 'applied'),
            resize: vi.fn(),
            signal: vi.fn(),
            setTransportPaused: vi.fn(),
            getRunningTerminalIds: vi.fn(() => ['term-1']),
            policyStore: { get: vi.fn(() => 'per-session'), set: vi.fn() },
        } as any;

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            terminalManager,
        });
        client.connect();
        emitSocketEvent('connect');
        mockSocket.connected = true;

        // Control RPCs are registered and routed to the manager.
        const createHandler = mockRpcHandlers['terminal-create'];
        expect(createHandler).toBeTypeOf('function');
        await createHandler({ cwd: '/tmp', name: 'dev', cols: 90, rows: 30 });
        expect(terminalManager.create).toHaveBeenCalledWith(expect.objectContaining({
            cwd: '/tmp',
            name: 'dev',
            cols: 90,
            rows: 30,
        }));

        // Running terminals re-register their stream rooms on connect.
        expect(mockSocket.emit).toHaveBeenCalledWith('terminal:register', { terminalId: 'term-1' });

        // Encrypted input frames are decrypted, authenticated, and acked.
        const { encrypt, encodeBase64, decodeBase64, decrypt } = await import('@/api/encryption');
        const machine = makeMachine();
        const inputFrame = {
            version: 1,
            streamId: 'stream-1',
            terminalId: 'term-1',
            machineId: 'test-machine-id',
            direction: 'client-to-daemon',
            seq: 7,
            kind: 'input',
            data: 'ls -la',
        };
        const payload = encodeBase64(encrypt(
            machine.encryptionKey,
            machine.encryptionVariant,
            inputFrame,
        ));
        emitSocketEvent('terminal:input', { terminalId: 'term-1', payload });

        expect(terminalManager.applyInput).toHaveBeenCalledWith('term-1', 'stream-1', 7, 'ls -la');
        const ackCalls = mockSocket.emit.mock.calls.filter(
            ([event]: [string]) => event === 'terminal:input-ack',
        );
        expect(ackCalls).toHaveLength(1);
        const ack = decrypt(
            machine.encryptionKey,
            machine.encryptionVariant,
            decodeBase64(ackCalls[0][1].payload),
        );
        expect(ack).toEqual(expect.objectContaining({
            version: 1,
            streamId: 'stream-1',
            terminalId: 'term-1',
            machineId: 'test-machine-id',
            direction: 'daemon-to-client',
            seq: 7,
            kind: 'input-ack',
        }));

        // Duplicate frames are acked again but never re-applied.
        terminalManager.applyInput.mockReturnValueOnce('duplicate');
        emitSocketEvent('terminal:input', { terminalId: 'term-1', payload });
        const ackCallsAfterDuplicate = mockSocket.emit.mock.calls.filter(
            ([event]: [string]) => event === 'terminal:input-ack',
        );
        expect(ackCallsAfterDuplicate).toHaveLength(2);

        // A frame whose authenticated terminalId does not match the route is dropped.
        const misroutedPayload = encodeBase64(encrypt(
            machine.encryptionKey,
            machine.encryptionVariant,
            { ...inputFrame, terminalId: 'other-term' },
        ));
        emitSocketEvent('terminal:input', { terminalId: 'term-1', payload: misroutedPayload });
        expect(terminalManager.applyInput).toHaveBeenCalledTimes(2);
        expect(mockSocket.emit.mock.calls.filter(
            ([event]: [string]) => event === 'terminal:input-ack',
        )).toHaveLength(2);

        // Resize frames are authenticated and routed to the manager.
        const resizePayload = encodeBase64(encrypt(
            machine.encryptionKey,
            machine.encryptionVariant,
            {
                version: 1,
                streamId: 'stream-1',
                terminalId: 'term-1',
                machineId: 'test-machine-id',
                direction: 'client-to-daemon',
                seq: 8,
                kind: 'resize',
                cols: 120,
                rows: 40,
            },
        ));
        emitSocketEvent('terminal:resize', { terminalId: 'term-1', payload: resizePayload });
        expect(terminalManager.resize).toHaveBeenCalledWith('term-1', 120, 40);

        client.shutdown();
    });
});
