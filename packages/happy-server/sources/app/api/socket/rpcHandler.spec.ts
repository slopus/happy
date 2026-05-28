import { describe, expect, it, vi } from 'vitest';
import { rpcHandler } from './rpcHandler';

class FakeSocket {
    connected = true;
    timeoutCalls: number[] = [];
    emitted: Array<{ event: string; payload: unknown }> = [];
    handlers = new Map<string, (...args: any[]) => unknown>();

    constructor(readonly id: string) {}

    on(event: string, handler: (...args: any[]) => unknown) {
        this.handlers.set(event, handler);
    }

    emit(event: string, payload: unknown) {
        this.emitted.push({ event, payload });
    }

    timeout(ms: number) {
        this.timeoutCalls.push(ms);
        return {
            emitWithAck: vi.fn(async (_event: string, payload: unknown) => payload),
        };
    }

    async trigger(event: string, ...args: unknown[]) {
        const handler = this.handlers.get(event);
        if (!handler) throw new Error(`missing handler: ${event}`);
        return handler(...args);
    }
}

describe('rpcHandler relay timeout', () => {
    it('uses caller-provided timeoutMs when forwarding rpc-request to the target socket', async () => {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        const listeners = new Map<string, FakeSocket>([['machine-1:bash', target]]);
        rpcHandler('u1', caller as any, listeners as any);

        const callback = vi.fn();
        await caller.trigger('rpc-call', {
            method: 'machine-1:bash',
            params: 'encrypted',
            timeoutMs: 330000,
        }, callback);

        expect(target.timeoutCalls).toEqual([330000]);
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { method: 'machine-1:bash', params: 'encrypted' },
        });
    });

    it('keeps the legacy 30s relay timeout when timeoutMs is not provided', async () => {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        const listeners = new Map<string, FakeSocket>([['machine-1:bash', target]]);
        rpcHandler('u1', caller as any, listeners as any);

        await caller.trigger('rpc-call', { method: 'machine-1:bash', params: 'encrypted' }, vi.fn());

        expect(target.timeoutCalls).toEqual([30000]);
    });
});
