import { describe, it, expect } from 'vitest';
import { InvalidateSync } from './sync';

describe('InvalidateSync', () => {
    it('resolves invalidateAndAwait even when command throws', async () => {
        const errors: unknown[] = [];
        const sync = new InvalidateSync(async () => {
            throw new Error('boom');
        }, {
            backoff: async <T>(cb: () => Promise<T>): Promise<T> => cb(),
            onError: (e: unknown) => errors.push(e),
        });

        await sync.invalidateAndAwait();
        expect(errors.length).toBe(1);
    });

    it('runs again when invalidated during an in-flight sync', async () => {
        let releaseFirstRun!: () => void;
        const firstRunGate = new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
        });
        const runs: number[] = [];

        const sync = new InvalidateSync(async () => {
            const run = runs.length + 1;
            runs.push(run);
            if (run === 1) {
                await firstRunGate;
            }
        }, {
            backoff: async <T>(cb: () => Promise<T>): Promise<T> => cb(),
        });

        const first = sync.invalidateAndAwait();
        sync.invalidate(); // while run #1 is pending

        // Let run #1 finish, allowing queued run #2.
        releaseFirstRun();

        await first;
        expect(runs).toEqual([1, 2]);
    });

    it('reports increasing failuresCount even when using a custom backoff', async () => {
        const failuresCounts: number[] = [];
        const errors: unknown[] = [];

        const backoff = async <T>(cb: () => Promise<T>): Promise<T> => {
            let lastError: unknown;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    return await cb();
                } catch (e) {
                    lastError = e;
                }
            }
            throw lastError;
        };

        const sync = new InvalidateSync(async () => {
            throw new Error('boom');
        }, {
            backoff,
            onError: (e, failuresCount) => {
                errors.push(e);
                failuresCounts.push(failuresCount);
            },
        });

        await sync.invalidateAndAwait();

        expect(errors).toHaveLength(3);
        expect(failuresCounts).toEqual([1, 2, 3]);
    });
});
