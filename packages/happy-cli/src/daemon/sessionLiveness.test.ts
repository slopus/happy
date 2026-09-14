import { describe, expect, it, vi } from 'vitest';
import type { PersistedSession } from '@/persistence';
import { hasPersistedProcessConflict, isPidAlive, machineBootTimeMs } from './sessionLiveness';

describe('session liveness (PR #1715)', () => {
    it.each([undefined, 0, -1, 1.5, NaN, Infinity])('does not probe invalid PID %s', (pid) => {
        const kill = vi.fn();
        expect(isPidAlive(pid, kill)).toBe(false);
        expect(kill).not.toHaveBeenCalled();
    });

    it('only treats ESRCH as proof of death', () => {
        expect(isPidAlive(123, () => {})).toBe(true);
        for (const code of ['ESRCH', 'EPERM', 'EACCES', undefined]) {
            expect(isPidAlive(123, () => { throw Object.assign(new Error('probe'), { code }); })).toBe(code !== 'ESRCH');
        }
    });

    it('subtracts uptime from now', () => {
        expect(machineBootTimeMs(60, 1_000_000)).toBe(940_000);
    });

    it('rejects a live same-boot persisted PID without granting ownership or signalling it', () => {
        const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
        const persisted = { metadata: { hostPid: 123 }, savedAt: 200 } as PersistedSession;
        try {
            expect(hasPersistedProcessConflict(persisted, 100)).toBe(true);
            expect(probe.mock.calls).toEqual([[123, 0]]);
            probe.mockClear();
            expect(hasPersistedProcessConflict(persisted, 300)).toBe(false);
            expect(hasPersistedProcessConflict(undefined, 100)).toBe(false);
            expect(probe).not.toHaveBeenCalled();
        } finally {
            probe.mockRestore();
        }
    });
});