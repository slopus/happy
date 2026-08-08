import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalAttachResult } from './terminalTypes';

const {
    machineRPC,
    socketSend,
    socketEmitWithAck,
    socketOnMessage,
    socketOnReconnected,
    socketHandlers,
    fakeEncryption,
    randomUUID,
    getSocketId,
} = vi.hoisted(() => {
    const handlers: Record<string, (data: any) => void> = {};
    return {
        machineRPC: vi.fn(),
        socketSend: vi.fn(),
        socketEmitWithAck: vi.fn(),
        socketOnMessage: vi.fn((event: string, handler: (data: any) => void) => {
            handlers[event] = handler;
            return () => {
                delete handlers[event];
            };
        }),
        socketOnReconnected: vi.fn((_listener: () => void) => () => {}),
        socketHandlers: handlers,
        fakeEncryption: {
            encryptRaw: vi.fn(async (value: unknown) => `enc:${JSON.stringify(value)}`),
            decryptRaw: vi.fn(async (payload: string) => JSON.parse(payload.slice(4))),
        },
        randomUUID: vi.fn(),
        getSocketId: vi.fn(() => 'socket-a'),
    };
});

vi.mock('./apiSocket', () => ({
    apiSocket: {
        machineRPC,
        send: socketSend,
        emitWithAck: socketEmitWithAck,
        onMessage: socketOnMessage,
        onReconnected: socketOnReconnected,
        getSocketId,
    },
}));

vi.mock('expo-crypto', () => ({
    randomUUID,
}));

vi.mock('./sync', () => ({
    sync: {
        encryption: {
            getMachineEncryption: vi.fn(() => fakeEncryption),
        },
    },
}));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function runningAttach(nextSeq = 3, streamEpoch = 'epoch-1'): TerminalAttachResult {
    return {
        status: 'running',
        snapshot: 'snapshot-ansi',
        nextSeq,
        truncated: false,
        replayFrames: [{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }],
        streamEpoch,
    };
}

describe('terminal control RPCs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of Object.keys(socketHandlers)) {
            delete socketHandlers[key];
        }
    });

    it('lists terminals through machine RPC', async () => {
        machineRPC.mockResolvedValue([]);
        const { terminalList } = await import('./terminalClient');
        await terminalList('machine-1');
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'terminal-list', {});
    });

    it('creates, approves, attaches, closes, and sets policy', async () => {
        const {
            terminalCreate,
            terminalApprove,
            terminalAttach,
            terminalClose,
            terminalSetPolicy,
            terminalGetPolicy,
        } = await import('./terminalClient');

        machineRPC.mockResolvedValue({ type: 'success', terminalId: 't1' });
        await terminalCreate('machine-1', { cwd: '/tmp', cols: 80, rows: 24 });
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'terminal-create', {
            cwd: '/tmp',
            cols: 80,
            rows: 24,
        });

        await terminalApprove('machine-1', 'approval-1');
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'terminal-approve', {
            approvalId: 'approval-1',
        });

        machineRPC.mockResolvedValue(runningAttach());
        await terminalAttach('machine-1', 't1', 2);
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'terminal-attach', {
            terminalId: 't1',
            lastSeq: 2,
        });

        await terminalClose('machine-1', 't1');
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'terminal-close', {
            terminalId: 't1',
        });

        await terminalSetPolicy('machine-1', 'per-session');
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'terminal-set-policy', {
            policy: 'per-session',
        });

        await terminalGetPolicy('machine-1');
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'terminal-get-policy', {});
    });
});

describe('TerminalStream', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of Object.keys(socketHandlers)) {
            delete socketHandlers[key];
        }
        randomUUID.mockReset();
        randomUUID
            .mockReturnValueOnce('stream-test-1')
            .mockReturnValueOnce('stream-test-2')
            .mockReturnValue('stream-test-3');
        fakeEncryption.encryptRaw.mockImplementation(
            async (value: unknown) => `enc:${JSON.stringify(value)}`,
        );
        fakeEncryption.decryptRaw.mockImplementation(
            async (payload: string) => JSON.parse(payload.slice(4)),
        );
        getSocketId.mockReturnValue('socket-a');
        socketEmitWithAck.mockResolvedValue({
            writerSocketId: 'socket-a',
            generation: 1,
            isWriter: true,
        });
        machineRPC.mockResolvedValue(runningAttach());
    });

    const outFrame = (seq: number, data: string) => ({
        version: 3,
        epoch: 'epoch-1',
        terminalId: 't1',
        machineId: 'machine-1',
        direction: 'daemon-to-client',
        seq,
        kind: 'output',
        data,
    });
    const emit = (event: string, frame: object) => {
        socketHandlers[event]({
            terminalId: 't1',
            payload: 'enc:' + JSON.stringify(frame),
        });
    };

    it('attaches, subscribes, takes control, and streams live output with dedupe', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const attaches: TerminalAttachResult[] = [];
        const outputs: string[] = [];
        const statuses: string[] = [];

        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: (result) => attaches.push(result),
            onOutput: (data) => outputs.push(data),
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: (status) => statuses.push(status),
        });

        const result = await stream.attach();
        expect(result.nextSeq).toBe(3);
        expect(attaches).toHaveLength(1);
        expect(socketEmitWithAck).toHaveBeenCalledWith(
            'terminal:subscribe',
            { terminalId: 't1' },
        );
        expect(socketEmitWithAck).not.toHaveBeenCalledWith(
            'terminal:takeover',
            { terminalId: 't1' },
        );
        expect(stream.isWriter).toBe(true);
        expect(statuses).toContain('attached');

        emit('terminal:output', outFrame(3, 'live'));
        await flush();
        expect(outputs).toEqual(['live']);

        // Duplicate/older frames are ignored.
        emit('terminal:output', outFrame(3, 'dup'));
        emit('terminal:output', outFrame(2, 'old'));
        await flush();
        expect(outputs).toEqual(['live']);
    });

    it('buffers live frames during attach and applies them after replay', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const outputs: string[] = [];
        let resolveAttach!: (value: TerminalAttachResult) => void;
        machineRPC.mockReturnValueOnce(new Promise((resolve) => {
            resolveAttach = resolve;
        }));

        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: (data) => outputs.push(data),
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        const attachPromise = stream.attach();
        await flush();

        // Live frame arrives while attach is still in flight: it must be
        // buffered and applied after snapshot/replay, not lost.
        emit('terminal:output', outFrame(3, 'live-3'));
        await flush();
        resolveAttach(runningAttach(3));
        await attachPromise;

        expect(outputs).toEqual(['live-3']);
    });

    it('allocates no control sequence before attach and sends only the latest resize first', async () => {
        const { TerminalStream } = await import('./terminalClient');
        let resolveAttach!: (value: TerminalAttachResult) => void;
        machineRPC.mockReturnValueOnce(new Promise((resolve) => {
            resolveAttach = resolve;
        }));
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });

        const attachPromise = stream.attach();
        await flush();
        await stream.sendInput('too-early');
        await stream.sendResize(80, 24);
        await stream.sendResize(100, 40);
        expect(socketSend.mock.calls.some(([event]) => [
            'terminal:input',
            'terminal:resize',
            'terminal:signal',
        ].includes(event))).toBe(false);

        resolveAttach(runningAttach());
        await attachPromise;
        const controls = socketSend.mock.calls
            .filter(([event]) => event === 'terminal:resize' || event === 'terminal:input')
            .map(([event, data]) => ({ event, frame: JSON.parse(data.payload.slice(4)) }));
        expect(controls).toEqual([{
            event: 'terminal:resize',
            frame: expect.objectContaining({
                seq: 1,
                kind: 'resize',
                cols: 100,
                rows: 40,
            }),
        }]);
    });

    it('resyncs when a live output frame is missing', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach(); // lastOutputSeq = 2

        machineRPC.mockResolvedValueOnce(runningAttach(8));
        emit('terminal:output', outFrame(5, 'gap'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(machineRPC).toHaveBeenCalledTimes(2);
    });

    it('sends input, acks it, and does not resend acked input after reconnect', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();

        await stream.sendInput('ls -la');
        const inputCall = socketSend.mock.calls.find(
            (call) => call[0] === 'terminal:input',
        );
        expect(inputCall).toBeDefined();
        const inputFrame = JSON.parse(inputCall![1].payload.slice(4));
        expect(inputFrame).toMatchObject({
            version: 3,
            epoch: 'epoch-1',
            streamId: expect.any(String),
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'client-to-daemon',
            seq: 1,
            kind: 'input',
            data: 'ls -la',
        });

        emit('terminal:control-ack', {
            version: 3,
            epoch: 'epoch-1',
            streamId: inputFrame.streamId,
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 1,
            kind: 'control-ack',
            status: 'applied',
        });
        emit('terminal:output', {
            ...outFrame(3, ''),
            kind: 'error',
            error: 'stale-error',
        });
        await flush();

        const inputCallsBeforeReconnect = socketSend.mock.calls.filter(
            (call) => call[0] === 'terminal:input',
        ).length;
        expect(inputCallsBeforeReconnect).toBe(1);

        const reconnectedListener = socketOnReconnected.mock.calls[0][0];
        machineRPC.mockResolvedValueOnce(runningAttach(6));
        reconnectedListener();
        await flush();

        const inputCallsAfterReconnect = socketSend.mock.calls.filter(
            (call) => call[0] === 'terminal:input',
        );
        // The acked input must not be re-sent after resync.
        expect(inputCallsAfterReconnect).toHaveLength(inputCallsBeforeReconnect);
    });

    it('handles exit frames and stops subscribing after an exited attach', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const exits: number[] = [];
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: (code) => exits.push(code),
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });

        machineRPC.mockResolvedValueOnce({
            status: 'exited',
            snapshot: '',
            nextSeq: 0,
            truncated: false,
            replayFrames: [],
            exitCode: 2,
            streamEpoch: 'epoch-1',
        });
        await stream.attach();

        expect(exits).toEqual([2]);
        expect(socketEmitWithAck).not.toHaveBeenCalledWith(
            'terminal:takeover',
            { terminalId: 't1' },
        );

        emit('terminal:exit', {
            version: 3,
            epoch: 'epoch-1',
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 1,
            kind: 'exit',
            exitCode: 3,
        });
        await flush();
        expect(exits).toEqual([2, 3]);
    });

    it('preserves Socket.IO order when frame decryption completes out of order', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const outputs: string[] = [];
        let resolveFirst!: (value: object) => void;
        fakeEncryption.decryptRaw.mockImplementation((payload: string) => {
            const frame = JSON.parse(payload.slice(4));
            if (frame.kind === 'output' && frame.seq === 3) {
                return new Promise((resolve) => {
                    resolveFirst = resolve;
                });
            }
            return Promise.resolve(frame);
        });

        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: (data) => outputs.push(data),
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();

        emit('terminal:output', outFrame(3, 'first'));
        emit('terminal:output', outFrame(4, 'second'));
        await flush();
        expect(outputs).toEqual([]);

        resolveFirst(outFrame(3, 'first'));
        await flush();
        await flush();
        expect(outputs).toEqual(['first', 'second']);
        expect(machineRPC).toHaveBeenCalledTimes(1);
    });

    it('resyncs once on a daemon epoch announcement and ignores stale frames', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const outputs: string[] = [];
        const exits: number[] = [];
        const resets: number[] = [];
        const errors: string[] = [];
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: (data) => outputs.push(data),
            onExit: (code) => exits.push(code),
            onError: (message) => errors.push(message),
            onWriter: () => undefined,
            onEpochReset: () => resets.push(1),
            onStatusChange: () => undefined,
        });
        await stream.attach();
        await stream.sendInput('npm publish');

        machineRPC.mockResolvedValueOnce(runningAttach(3, 'epoch-2'));
        const epochFrame = {
            version: 3,
            epoch: 'epoch-2',
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 0,
            kind: 'epoch',
        };
        emit('terminal:epoch', epochFrame);
        emit('terminal:epoch', epochFrame);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(machineRPC).toHaveBeenCalledTimes(2);
        expect(resets).toHaveLength(1);
        expect(stream.streamId).toBe('stream-test-2');

        emit('terminal:output', outFrame(3, 'stale-output'));
        emit('terminal:exit', {
            ...outFrame(3, ''),
            kind: 'exit',
            exitCode: 9,
        });
        emit('terminal:control-ack', {
            version: 3,
            epoch: 'epoch-1',
            streamId: 'stream-test-1',
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 1,
            kind: 'control-ack',
            status: 'applied',
        });
        await flush();
        await flush();
        expect(outputs).toEqual([]);
        expect(exits).toEqual([]);
        expect(errors).toEqual([]);

        await stream.sendInput('pwd');
        const latestInput = socketSend.mock.calls.filter(
            (call) => call[0] === 'terminal:input',
        ).at(-1);
        expect(JSON.parse(latestInput![1].payload.slice(4))).toMatchObject({
            version: 3,
            epoch: 'epoch-2',
            streamId: 'stream-test-2',
            seq: 1,
            kind: 'input',
            data: 'pwd',
        });
    });

    it('forwards current-epoch daemon errors to the stream handler', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const errors: string[] = [];
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: (message) => errors.push(message),
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();

        emit('terminal:output', {
            version: 3,
            epoch: 'epoch-1',
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 3,
            kind: 'error',
            error: 'pty failed',
        });
        await flush();
        expect(errors).toEqual(['pty failed']);
    });

    it('accepts exit only at the next output sequence', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const exits: number[] = [];
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: (code) => exits.push(code),
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();

        emit('terminal:exit', {
            version: 3,
            epoch: 'epoch-1',
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 2,
            kind: 'exit',
            exitCode: 9,
        });
        await flush();
        expect(exits).toEqual([]);

        emit('terminal:exit', {
            version: 3,
            epoch: 'epoch-1',
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 3,
            kind: 'exit',
            exitCode: 0,
        });
        await flush();
        expect(exits).toEqual([0]);
    });

    it('sends resize and input on one ordered sequence', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();

        await stream.sendResize(120, 40);
        await stream.sendInput('ls');

        const resizeCall = socketSend.mock.calls.find(
            (call) => call[0] === 'terminal:resize',
        );
        const inputCall = socketSend.mock.calls.find(
            (call) => call[0] === 'terminal:input',
        );
        expect(resizeCall).toBeDefined();
        expect(inputCall).toBeDefined();
        expect(JSON.parse(resizeCall![1].payload.slice(4))).toMatchObject({
            version: 3,
            epoch: 'epoch-1',
            seq: 1,
            kind: 'resize',
            cols: 120,
            rows: 40,
        });
        expect(JSON.parse(inputCall![1].payload.slice(4))).toMatchObject({
            version: 3,
            epoch: 'epoch-1',
            seq: 2,
            kind: 'input',
            data: 'ls',
        });
    });

    it('serializes sequence allocation, encryption, and emit order', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();
        socketSend.mockClear();

        let resolveFirst!: (value: string) => void;
        fakeEncryption.encryptRaw.mockImplementation((value: unknown) => {
            const frame = value as { data?: string };
            if (frame.data === 'first') {
                return new Promise((resolve) => {
                    resolveFirst = resolve;
                });
            }
            return Promise.resolve(`enc:${JSON.stringify(value)}`);
        });

        const first = stream.sendInput('first');
        const second = stream.sendInput('second');
        await flush();
        expect(socketSend).not.toHaveBeenCalled();

        resolveFirst('enc:' + JSON.stringify({
            version: 3,
            epoch: 'epoch-1',
            streamId: stream.streamId,
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'client-to-daemon',
            seq: 1,
            kind: 'input',
            data: 'first',
        }));
        await Promise.all([first, second]);

        const frames = socketSend.mock.calls.map((call) => JSON.parse(call[1].payload.slice(4)));
        expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
        expect(frames.map((frame) => frame.data)).toEqual(['first', 'second']);
    });

    it('resends pending resize and input in order after a gap NACK', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();
        await stream.sendResize(120, 40);
        await stream.sendInput('echo once');

        emit('terminal:control-nack', {
            version: 3,
            epoch: 'epoch-1',
            streamId: stream.streamId,
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 2,
            kind: 'control-nack',
            receivedSeq: 2,
            expectedSeq: 1,
            reason: 'gap',
        });
        await flush();
        await flush();

        const controls = socketSend.mock.calls
            .filter(([event]) => event === 'terminal:resize' || event === 'terminal:input')
            .map(([event, data]) => ({ event, frame: JSON.parse(data.payload.slice(4)) }));
        expect(controls.map(({ event }) => event)).toEqual([
            'terminal:resize',
            'terminal:input',
            'terminal:resize',
            'terminal:input',
        ]);
        expect(controls.slice(2).map(({ frame }) => frame.seq)).toEqual([1, 2]);
    });

    it('resends every pending control in ascending order on same-epoch reconnect', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();
        await stream.sendResize(120, 40);
        await stream.sendInput('ls');
        await stream.sendSignal('SIGINT');

        socketEmitWithAck.mockResolvedValueOnce({
            writerSocketId: 'socket-a',
            generation: 1,
            isWriter: true,
        });
        machineRPC.mockResolvedValueOnce(runningAttach(6, 'epoch-1'));
        const reconnectedListener = socketOnReconnected.mock.calls[0][0];
        reconnectedListener();
        await new Promise((resolve) => setTimeout(resolve, 20));

        const controls = socketSend.mock.calls
            .filter(([event]) => event.startsWith('terminal:') && [
                'terminal:resize',
                'terminal:input',
                'terminal:signal',
            ].includes(event))
            .map(([, data]) => JSON.parse(data.payload.slice(4)));
        expect(controls.map((frame) => frame.seq)).toEqual([1, 2, 3, 1, 2, 3]);
        expect(controls.slice(3).map((frame) => frame.kind)).toEqual([
            'resize',
            'input',
            'signal',
        ]);
    });

    it('rotates a broken control stream and sends only the desired resize first', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const resets: number[] = [];
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onControlReset: () => resets.push(1),
            onStatusChange: () => undefined,
        });
        await stream.attach();
        await stream.sendResize(90, 30);
        await stream.sendInput('dangerous');
        const oldStreamId = stream.streamId;

        emit('terminal:control-ack', {
            version: 3,
            epoch: 'epoch-1',
            streamId: oldStreamId,
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 1,
            kind: 'control-ack',
            status: 'applied',
        });
        emit('terminal:control-nack', {
            version: 3,
            epoch: 'epoch-1',
            streamId: oldStreamId,
            terminalId: 't1',
            machineId: 'machine-1',
            direction: 'daemon-to-client',
            seq: 2,
            kind: 'control-nack',
            receivedSeq: 2,
            expectedSeq: 1,
            reason: 'gap',
        });
        await flush();
        await flush();

        expect(resets).toEqual([1]);
        expect(stream.streamId).not.toBe(oldStreamId);
        const controls = socketSend.mock.calls
            .filter(([event]) => event === 'terminal:resize' || event === 'terminal:input')
            .map(([event, data]) => ({ event, frame: JSON.parse(data.payload.slice(4)) }));
        expect(controls.at(-1)).toEqual(expect.objectContaining({
            event: 'terminal:resize',
            frame: expect.objectContaining({
                streamId: stream.streamId,
                seq: 1,
                kind: 'resize',
                cols: 90,
                rows: 30,
            }),
        }));
        expect(controls.filter(({ frame }) => frame.streamId === stream.streamId))
            .toHaveLength(1);
    });

    it('keeps later subscribers view-only until explicit takeover', async () => {
        const { TerminalStream } = await import('./terminalClient');
        socketEmitWithAck.mockImplementation(async (event: string) => {
            if (event === 'terminal:takeover') {
                return { writerSocketId: 'socket-a', generation: 2, isWriter: true };
            }
            return { writerSocketId: 'socket-b', generation: 1, isWriter: false };
        });
        const writerStates: boolean[] = [];
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: (state) => writerStates.push(state.isWriter),
            onStatusChange: () => undefined,
        });
        await stream.attach();

        expect(stream.isWriter).toBe(false);
        await stream.sendInput('hidden');
        await stream.sendResize(100, 30);
        expect(socketSend.mock.calls.some(
            ([event]) => event === 'terminal:input' || event === 'terminal:resize',
        )).toBe(false);

        await stream.takeControl();
        expect(stream.isWriter).toBe(true);
        await stream.sendInput('visible');
        const controls = socketSend.mock.calls
            .filter(([event]) => event === 'terminal:resize' || event === 'terminal:input')
            .map(([event, data]) => ({ event, frame: JSON.parse(data.payload.slice(4)) }));
        expect(controls.map(({ event }) => event)).toEqual(['terminal:resize', 'terminal:input']);
        expect(controls.map(({ frame }) => frame.seq)).toEqual([1, 2]);
        expect(writerStates).toEqual([false, true]);
    });

    it('demotes on writer broadcast and drops pending input before resync', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();
        const originalStreamId = stream.streamId;
        await stream.sendInput('dangerous');

        socketHandlers['terminal:writer']({
            terminalId: 't1',
            writerSocketId: 'socket-b',
            generation: 2,
        });
        expect(stream.isWriter).toBe(false);
        expect(stream.streamId).not.toBe(originalStreamId);

        socketEmitWithAck.mockResolvedValueOnce({
            writerSocketId: 'socket-b',
            generation: 2,
            isWriter: false,
        });
        machineRPC.mockResolvedValueOnce(runningAttach(6));
        const reconnectedListener = socketOnReconnected.mock.calls[0][0];
        reconnectedListener();
        await new Promise((resolve) => setTimeout(resolve, 10));

        const inputCalls = socketSend.mock.calls.filter(([event]) => event === 'terminal:input');
        expect(inputCalls).toHaveLength(1);
    });

    it('drops unacked input when the daemon epoch changes', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const resets: number[] = [];
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onEpochReset: () => resets.push(1),
            onStatusChange: () => undefined,
        });
        await stream.attach(); // epoch-1
        await stream.sendInput('npm publish');

        const reconnectedListener = socketOnReconnected.mock.calls[0][0];
        machineRPC.mockResolvedValueOnce(runningAttach(6, 'epoch-2'));
        reconnectedListener();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(resets).toHaveLength(1);
        // The unacked input is dropped, never re-sent against the new epoch.
        const inputCalls = socketSend.mock.calls.filter(
            (call) => call[0] === 'terminal:input',
        );
        expect(inputCalls).toHaveLength(1);
    });

    it('detaches by unsubscribing and disposing socket listeners', async () => {
        const { TerminalStream } = await import('./terminalClient');
        const stream = new TerminalStream('machine-1', 't1', {
            onAttach: () => undefined,
            onOutput: () => undefined,
            onExit: () => undefined,
            onError: () => undefined,
            onWriter: () => undefined,
            onStatusChange: () => undefined,
        });
        await stream.attach();
        stream.detach();

        expect(socketSend).toHaveBeenCalledWith('terminal:unsubscribe', { terminalId: 't1' });
        expect(Object.keys(socketHandlers)).toEqual([]);
    });
});
