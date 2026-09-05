import { beforeEach, describe, expect, it, vi } from 'vitest';

const { log } = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock('@/utils/log', () => ({ log }));

import { rpcHandler } from '@/app/api/socket/rpcHandler';

type Listener = (...args: any[]) => void;

class FakeCallerSocket {
    readonly id = 'caller';
    private listeners = new Map<string, Listener>();

    on(event: string, listener: Listener) {
        this.listeners.set(event, listener);
        return this;
    }

    emit() {
        return true;
    }

    receive(event: string, ...args: unknown[]) {
        const listener = this.listeners.get(event);
        if (!listener) throw new Error(`No listener registered for ${event}`);
        return listener(...args);
    }
}

class FakeTargetSocket {
    readonly id = 'target';
    readonly timeout = vi.fn((timeoutMs: number) => ({
        emitWithAck: vi.fn(() => new Promise<string>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('operation has timed out'));
                }
            }, timeoutMs);
            this.ack().then((response) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(response);
                }
            }, (error) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            });
        })),
    }));
    ack: () => Promise<string> = async () => 'encrypted-response';
}

function createIo(target: FakeTargetSocket) {
    return {
        in: vi.fn(() => ({
            timeout: vi.fn(() => ({
                fetchSockets: vi.fn(async () => [target]),
            })),
        })),
    };
}

function createNoTargetIo(fetchTimeouts: number[]) {
    return {
        in: vi.fn(() => ({
            timeout: vi.fn((timeoutMs: number) => ({
                fetchSockets: vi.fn(() => new Promise<never>((_, reject) => {
                    fetchTimeouts.push(timeoutMs);
                    setTimeout(() => reject(new Error('fetch timed out')), timeoutMs);
                })),
            })),
        })),
    };
}

function createDelayedIo(steps: Array<{ delayMs: number; sockets: FakeTargetSocket[] }>) {
    let stepIndex = 0;
    return {
        in: vi.fn(() => ({
            timeout: vi.fn(() => ({
                fetchSockets: vi.fn(() => {
                    const step = steps[Math.min(stepIndex++, steps.length - 1)];
                    return new Promise<FakeTargetSocket[]>((resolve) => {
                        setTimeout(() => resolve(step.sockets), step.delayMs);
                    });
                }),
            })),
        })),
    };
}

async function callRpc(
    method: string,
    target: FakeTargetSocket,
    params: Record<string, unknown> = {},
) {
    const caller = new FakeCallerSocket();
    const io = createIo(target);
    rpcHandler('user-1', caller as any, io as any);
    const acknowledge = vi.fn();

    const request = caller.receive('rpc-call', { method, params }, acknowledge);
    await request;

    return { acknowledge, io };
}

describe('rpcHandler', () => {
    beforeEach(() => {
        log.mockReset();
    });

    it('forwards a startup trace and records only receipt and daemon-found stages', async () => {
        const target = new FakeTargetSocket();
        const caller = new FakeCallerSocket();
        const io = createIo(target);
        rpcHandler('user-1', caller as any, io as any);
        const acknowledge = vi.fn();

        await caller.receive('rpc-call', {
            method: 'machine-1:spawn-happy-session',
            params: 'encrypted-params',
            traceId: '00000000-0000-4000-8000-000000000001',
            token: 'token-canary',
            prompt: 'prompt-canary',
        }, acknowledge);

        const emitWithAck = target.timeout.mock.results[0]?.value.emitWithAck;
        expect(emitWithAck).toHaveBeenCalledWith('rpc-request', {
            method: 'machine-1:spawn-happy-session',
            params: 'encrypted-params',
            traceId: '00000000-0000-4000-8000-000000000001',
        });
        const stageEvents = log.mock.calls
            .map(([event]) => event)
            .filter((event) => event?.traceId === '00000000-0000-4000-8000-000000000001');
        expect(stageEvents).toEqual([
            expect.objectContaining({
                traceId: '00000000-0000-4000-8000-000000000001',
                stage: 'server.rpc.received',
                machineId: 'machine-1',
                outcome: 'success',
            }),
            expect.objectContaining({
                traceId: '00000000-0000-4000-8000-000000000001',
                stage: 'server.rpc.daemon_found',
                machineId: 'machine-1',
                outcome: 'success',
            }),
        ]);
        expect(JSON.stringify(stageEvents)).not.toContain('canary');
    });

    it('keeps legacy calls trace-free', async () => {
        const target = new FakeTargetSocket();

        await callRpc('machine-1:spawn-happy-session', target);

        expect(log.mock.calls.some(([event]) => event?.stage?.startsWith('server.rpc.'))).toBe(false);
    });

    it('forwards a startup RPC even when startup telemetry logging throws', async () => {
        log.mockImplementation((event) => {
            if (event?.stage?.startsWith('server.rpc.')) throw new Error('logger-canary');
        });
        const target = new FakeTargetSocket();
        const caller = new FakeCallerSocket();
        const io = createIo(target);
        rpcHandler('user-1', caller as any, io as any);
        const acknowledge = vi.fn();

        await caller.receive('rpc-call', {
            method: 'machine-1:spawn-happy-session',
            params: 'encrypted-params',
            traceId: '00000000-0000-4000-8000-000000000001',
        }, acknowledge);

        expect(target.timeout).toHaveBeenCalledTimes(1);
        expect(acknowledge).toHaveBeenCalledWith({ ok: true, result: 'encrypted-response' });
    });

    it('keeps ordinary RPC calls on the 30-second target acknowledgement timeout', async () => {
        const target = new FakeTargetSocket();

        const { acknowledge } = await callRpc('machine-1:bash', target);

        expect(target.timeout).toHaveBeenCalledWith(30_000);
        expect(acknowledge).toHaveBeenCalledWith({ ok: true, result: 'encrypted-response' });
    });

    it('stops an empty lookup within the initial 2 seconds plus the 15-second grace window', async () => {
        vi.useFakeTimers();
        try {
            const fetchTimeouts: number[] = [];
            const caller = new FakeCallerSocket();
            const io = createNoTargetIo(fetchTimeouts);
            rpcHandler('user-1', caller as any, io as any);
            const requestStart = Date.now();
            let acknowledgedAt: number | undefined;
            const acknowledge = vi.fn(() => {
                acknowledgedAt = Date.now();
            });

            const request = caller.receive('rpc-call', {
                method: 'machine-1:spawn-happy-session',
                params: {},
            }, acknowledge);
            await vi.advanceTimersByTimeAsync(17_000);
            const acknowledgementsAtDeadline = acknowledge.mock.calls.length;
            const lastFetchTimeout = fetchTimeouts.at(-1);

            await vi.advanceTimersByTimeAsync(30_000);
            await request;

            expect(acknowledgedAt).toBeDefined();
            expect(acknowledgedAt! - requestStart).toBeLessThanOrEqual(17_000);
            expect(acknowledgementsAtDeadline).toBe(1);
            expect(acknowledge).toHaveBeenCalledWith({ ok: false, error: 'RPC method not available' });
            expect(lastFetchTimeout).toBeDefined();
            expect(lastFetchTimeout).toBeLessThan(8_000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('forwards a delayed startup acknowledgement after a delayed daemon reconnect', async () => {
        vi.useFakeTimers();
        try {
            const target = new FakeTargetSocket();
            target.ack = () => new Promise<string>((resolve) => {
                setTimeout(() => resolve('encrypted-response'), 90_000);
            });
            const caller = new FakeCallerSocket();
            const io = createDelayedIo([
                { delayMs: 2_000, sockets: [] },
                { delayMs: 2_000, sockets: [] },
                { delayMs: 4_000, sockets: [target] },
            ]);
            rpcHandler('user-1', caller as any, io as any);
            const acknowledge = vi.fn();

            const request = caller.receive('rpc-call', {
                method: 'machine-1:spawn-happy-session',
                params: {},
            }, acknowledge);
            await vi.advanceTimersByTimeAsync(99_000);
            await request;

            expect(target.timeout).toHaveBeenCalledWith(100_000);
            expect(acknowledge).toHaveBeenCalledWith({ ok: true, result: 'encrypted-response' });
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        'machine-1:spawn-happy-session',
        'machine-1:resume-happy-session',
    ])('gives %s the longer startup acknowledgement timeout', async (method) => {
        const target = new FakeTargetSocket();

        const { acknowledge } = await callRpc(method, target);

        expect(target.timeout).toHaveBeenCalledWith(100_000);
        expect(acknowledge).toHaveBeenCalledWith({ ok: true, result: 'encrypted-response' });
    });

    it('allows a startup RPC acknowledgement after 90 seconds', async () => {
        vi.useFakeTimers();
        try {
            const target = new FakeTargetSocket();
            target.ack = () => new Promise<string>((resolve) => {
                setTimeout(() => resolve('encrypted-response'), 90_000);
            });
            const caller = new FakeCallerSocket();
            const io = createIo(target);
            rpcHandler('user-1', caller as any, io as any);
            const acknowledge = vi.fn();

            const request = caller.receive('rpc-call', {
                method: 'machine-1:spawn-happy-session',
                params: {},
            }, acknowledge);
            await vi.advanceTimersByTimeAsync(90_000);
            await request;

            expect(target.timeout).toHaveBeenCalledWith(100_000);
            expect(acknowledge).toHaveBeenCalledWith({ ok: true, result: 'encrypted-response' });
        } finally {
            vi.useRealTimers();
        }
    });
});
