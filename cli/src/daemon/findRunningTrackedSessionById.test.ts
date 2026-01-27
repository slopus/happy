import { describe, expect, it } from 'vitest';
import type { TrackedSession } from './types';
import { findRunningTrackedSessionById } from './findRunningTrackedSessionById';

describe('findRunningTrackedSessionById', () => {
    it('returns the matching tracked session when PID is alive and hash matches', async () => {
        const sessions: TrackedSession[] = [
            { pid: 1, startedBy: 'daemon', happySessionId: 's1', processCommandHash: 'h1' },
            { pid: 2, startedBy: 'daemon', happySessionId: 's2', processCommandHash: 'h2' },
        ];

        const found = await findRunningTrackedSessionById({
            sessions,
            happySessionId: 's2',
            isPidAlive: async (pid) => pid === 2,
            getProcessCommandHash: async (pid) => (pid === 2 ? 'h2' : null),
        });

        expect(found?.pid).toBe(2);
        expect(found?.happySessionId).toBe('s2');
    });

    it('returns null when PID is not alive', async () => {
        const sessions: TrackedSession[] = [
            { pid: 2, startedBy: 'daemon', happySessionId: 's2', processCommandHash: 'h2' },
        ];

        const found = await findRunningTrackedSessionById({
            sessions,
            happySessionId: 's2',
            isPidAlive: async () => false,
            getProcessCommandHash: async () => 'h2',
        });

        expect(found).toBeNull();
    });

    it('returns null when command hash mismatches', async () => {
        const sessions: TrackedSession[] = [
            { pid: 2, startedBy: 'daemon', happySessionId: 's2', processCommandHash: 'h2' },
        ];

        const found = await findRunningTrackedSessionById({
            sessions,
            happySessionId: 's2',
            isPidAlive: async () => true,
            getProcessCommandHash: async () => 'DIFFERENT',
        });

        expect(found).toBeNull();
    });
});
