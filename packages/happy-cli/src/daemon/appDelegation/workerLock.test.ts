import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { acquireMachineLock, processAlive } from './workerLock';

describe('machine execution ownership', () => {
    it('blocks a second worker until the first finishes cleanup', async () => {
        const id = randomUUID();
        const release = await acquireMachineLock(id, () => {});
        expect(release).not.toBeNull();
        try { expect(await acquireMachineLock(id, () => {})).toBeNull(); }
        finally { await release?.(); }
        const next = await acquireMachineLock(id, () => {});
        expect(next).not.toBeNull();
        await next?.();
    });
    it('treats live or invalid process identities as unsafe for recovery', () => {
        expect(processAlive(process.pid)).toBe(true);
        expect(processAlive(NaN)).toBe(true);
        expect(processAlive(0)).toBe(true);
        expect(processAlive(-1)).toBe(true);
    });
});
