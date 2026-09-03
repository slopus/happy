import { describe, expect, it, vi } from 'vitest';
import {
    createPublicSessionCoverAvailability,
    PublicSessionCoverAvailabilityError,
} from './publicSessionCoverAvailability';

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
    return { promise, resolve };
}

describe('public session cover provider availability', () => {
    it('uses distinct hashed distributed account and global hourly buckets across asset IDs', async () => {
        const counts = new Map<string, number>();
        const redisEval = vi.fn(async (_script: string, _keyCount: number, key: string): Promise<unknown> => {
            const count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            return [count, 3_600_000];
        });
        const availability = createPublicSessionCoverAvailability({
            accountRateMax: 2,
            globalRateMax: 3,
            redisEval,
        });
        const run = (accountId: string, assetId: string) => availability.run(accountId, async () => assetId);

        await expect(run('account-a', 'asset-1')).resolves.toBe('asset-1');
        await expect(run('account-a', 'asset-2')).resolves.toBe('asset-2');
        await expect(run('account-a', 'asset-3')).rejects.toBeInstanceOf(PublicSessionCoverAvailabilityError);
        await expect(run('account-b', 'asset-4')).resolves.toBe('asset-4');
        await expect(run('account-b', 'asset-5')).rejects.toMatchObject({ retryAfterSeconds: 3600 });

        const keys = redisEval.mock.calls.map((call) => call[2]);
        expect(keys.some((key) => key.startsWith('happy:public-share-rate:cover-provider-account:'))).toBe(true);
        expect(keys.some((key) => key.startsWith('happy:public-share-rate:cover-provider-global:'))).toBe(true);
        expect(keys.join(' ')).not.toContain('account-a');
        expect(keys.join(' ')).not.toContain('asset-');
    });

    it('bounds same-account and process-global in-flight provider work', async () => {
        const availability = createPublicSessionCoverAvailability({
            accountConcurrency: 1,
            globalConcurrency: 2,
            accountRateMax: 100,
            globalRateMax: 100,
            redisEval: null,
        });
        const first = deferred();
        const second = deferred();
        const firstRun = availability.run('account-a', async () => first.promise);

        await expect(availability.run('account-a', async () => undefined)).rejects.toBeInstanceOf(PublicSessionCoverAvailabilityError);
        await expect(availability.run('account-a', async () => undefined)).rejects.toThrow('Cover provider is busy');
        const secondRun = availability.run('account-b', async () => second.promise);
        await expect(availability.run('account-c', async () => undefined)).rejects.toBeInstanceOf(PublicSessionCoverAvailabilityError);

        first.resolve();
        second.resolve();
        await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([undefined, undefined]);
    });

    it('releases both concurrency slots after provider failure', async () => {
        const availability = createPublicSessionCoverAvailability({
            accountConcurrency: 1,
            globalConcurrency: 1,
            accountRateMax: 100,
            globalRateMax: 100,
            redisEval: null,
        });

        await expect(availability.run('account-a', async () => {
            throw new Error('provider failed');
        })).rejects.toThrow('provider failed');
        await expect(availability.run('account-a', async () => 'recovered')).resolves.toBe('recovered');
    });

    it('fails closed when the configured distributed limiter errors', async () => {
        const operation = vi.fn(async () => 'should not run');
        const availability = createPublicSessionCoverAvailability({
            redisEval: vi.fn(async () => { throw new Error('redis unavailable'); }),
        });

        await expect(availability.run('account-a', operation)).rejects.toThrow('redis unavailable');
        expect(operation).not.toHaveBeenCalled();
    });
});
