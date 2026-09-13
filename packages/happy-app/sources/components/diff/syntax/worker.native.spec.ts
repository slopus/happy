import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyntaxWorker } from './worker.native';

const bridge = vi.hoisted(() => ({
    jobs: [] as (() => void)[],
    create: vi.fn((_config?: unknown) => ({ name: 'test-runtime' })),
    receive: vi.fn(),
    payloads: [] as unknown[],
}));
vi.mock('react-native-worklets', () => ({
    createWorkletRuntime: bridge.create,
    scheduleOnRuntime: (_runtime: unknown, fn: (...args: any[]) => void, id: number, payload: unknown) => {
        bridge.payloads.push(payload);
        bridge.jobs.push(() => fn(id, payload));
    },
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: unknown[]) => {
        bridge.receive(...args);
        fn(...args);
    },
}));

describe('native syntax transport', () => {
    beforeEach(() => {
        bridge.jobs.length = 0;
        bridge.payloads.length = 0;
        bridge.create.mockClear();
        bridge.receive.mockClear();
        vi.stubGlobal('__happyDiffSyntax', undefined);
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('creates one runtime lazily, initializes Prism in scheduled work, and sends strings both ways', async () => {
        const worker = createSyntaxWorker();
        expect(bridge.create).not.toHaveBeenCalled();
        const input = { language: 'typescript', lines: [{ text: 'const x = 1;', type: 'add' as const }] };
        const first = worker.run(input);
        expect(bridge.create).toHaveBeenCalledTimes(1);
        expect(bridge.create.mock.calls[0][0]).toEqual({ name: 'happy-diff-syntax' });
        expect((globalThis as any).__happyDiffSyntax).toBeUndefined();
        expect(typeof bridge.payloads[0]).toBe('string');
        bridge.jobs.shift()!();
        expect((await first).status).toBe('highlighted');
        expect(typeof bridge.receive.mock.calls[0][1]).toBe('string');
        const second = worker.run(input);
        bridge.jobs.shift()!();
        expect((await second).runs).toEqual((await first).runs);
        expect(bridge.create).toHaveBeenCalledTimes(1);
    });

    it('rejects cleanly when the tokenizer or native runtime fails', async () => {
        const worker = createSyntaxWorker();
        vi.stubGlobal('__happyDiffSyntax', () => { throw new Error('bad grammar'); });
        const request = worker.run({ language: 'typescript', lines: [] });
        bridge.jobs.shift()!();
        await expect(request).rejects.toThrow('Diff syntax worker failed');
        bridge.create.mockImplementationOnce(() => { throw new Error('not linked'); });
        await expect(createSyntaxWorker().run({ language: 'typescript', lines: [] })).rejects.toThrow('not linked');
    });
});