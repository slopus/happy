import { describe, expect, it, vi } from 'vitest';
import { createSessionSpawnGate } from './sessionSpawnGate';

describe('createSessionSpawnGate', () => {
    it('fences new spawns and drains one already in flight before shutdown continues', async () => {
        let finish!: (value: any) => void;
        const operation = new Promise<any>((resolve) => { finish = resolve; });
        const spawnImpl = vi.fn().mockReturnValue(operation);
        const gate = createSessionSpawnGate(spawnImpl);

        const first = gate.spawn({ directory: '/tmp/one' });
        const draining = gate.fenceAndDrain();
        await expect(gate.spawn({ directory: '/tmp/two' })).resolves.toMatchObject({
            type: 'error',
            errorMessage: expect.stringContaining('shutting down'),
        });
        expect(spawnImpl).toHaveBeenCalledTimes(1);

        finish({ type: 'success', sessionId: 'one' });
        await expect(first).resolves.toEqual({ type: 'success', sessionId: 'one' });
        await expect(draining).resolves.toBe(1);
        expect(gate.activeCount()).toBe(0);
    });

    it('also fences and drains tracked resume operations that create processes directly', async () => {
        let finish!: (value: any) => void;
        const operation = new Promise<any>((resolve) => { finish = resolve; });
        const gate = createSessionSpawnGate(vi.fn());

        const resume = gate.run(() => operation);
        const draining = gate.fenceAndDrain();
        await expect(gate.run(vi.fn())).resolves.toMatchObject({ type: 'error' });

        finish({ type: 'success', sessionId: 'resumed' });
        await expect(resume).resolves.toEqual({ type: 'success', sessionId: 'resumed' });
        await expect(draining).resolves.toBe(1);
    });
});
