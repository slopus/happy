import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalAttachResult } from './terminalTypes';

const {
    machineRPC,
    socketSend,
    socketOnMessage,
    socketOnReconnected,
    socketHandlers,
    fakeEncryption,
} = vi.hoisted(() => {
    const handlers: Record<string, (data: any) => void> = {};
    return {
        machineRPC: vi.fn(),
        socketSend: vi.fn(),
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
    };
});

vi.mock('./apiSocket', () => ({
    apiSocket: {
        machineRPC,
        send: socketSend,
        onMessage: socketOnMessage,
        onReconnected: socketOnReconnected,
    },
}));

vi.mock('./sync', () => ({
    sync: {
        encryption: {
            getMachineEncryption: vi.fn(() => fakeEncryption),
        },
    },
}));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function runningAttach(nextSeq = 3): TerminalAttachResult {
    return {
        status: 'running',
        snapshot: 'snapshot-ansi',
        nextSeq,
        truncated: false,
        replayFrames: [{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }],
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
        machineRPC.mockResolvedValue(runningAttach());
    });

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
        expect(socketSend).toHaveBeenCalledWith('terminal:subscribe', { terminalId: 't1' });
        expect(socketSend).toHaveBeenCalledWith('terminal:takeover', { terminalId: 't1' });
        expect(statuses).toContain('attached');

        const outputHandler = socketHandlers['terminal:output'];
        outputHandler({
            terminalId: 't1',
            payload: 'enc:' + JSON.stringify({ seq: 4, kind: 'output', data: 'live' }),
        });
        await flush();
        expect(outputs).toEqual(['live']);

        // Duplicate/older frames are ignored.
        outputHandler({
            terminalId: 't1',
            payload: 'enc:' + JSON.stringify({ seq: 4, kind: 'output', data: 'dup' }),
        });
        outputHandler({
            terminalId: 't1',
            payload: 'enc:' + JSON.stringify({ seq: 3, kind: 'output', data: 'old' }),
        });
        await flush();
        expect(outputs).toEqual(['live']);
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
        expect(socketSend).toHaveBeenCalledWith('terminal:input', {
            terminalId: 't1',
            payload: 'enc:' + JSON.stringify({ seq: 1, kind: 'input', data: 'ls -la' }),
        });

        socketHandlers['terminal:input-ack']({
            terminalId: 't1',
            payload: 'enc:' + JSON.stringify({ seq: 1, kind: 'input-ack' }),
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
        });
        await stream.attach();

        expect(exits).toEqual([2]);
        expect(socketSend).not.toHaveBeenCalledWith('terminal:subscribe', { terminalId: 't1' });

        socketHandlers['terminal:exit']({
            terminalId: 't1',
            payload: 'enc:' + JSON.stringify({ seq: 5, kind: 'exit', exitCode: 3 }),
        });
        await flush();
        expect(exits).toEqual([2, 3]);
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
