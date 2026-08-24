import { describe, expect, it } from 'vitest';
import type { PersistedSession } from '@/persistence';
import {
    classifyResumeConflict,
    isPidAlive,
    machineBootTimeMs,
    resolveLiveOwnerPid,
    type SessionPresence,
} from './sessionLiveness';

const BOOT = 1_000_000;
const alive = (pids: number[]) => (pid: number | undefined) => pid !== undefined && pids.includes(pid);

describe('isPidAlive', () => {
    it('reports the current process as alive', () => {
        expect(isPidAlive(process.pid)).toBe(true);
    });

    it('reports a PID the kernel rejects as dead', () => {
        const kill = () => { throw new Error('ESRCH'); };
        expect(isPidAlive(4242, kill)).toBe(false);
    });

    it('treats absent and non-positive PIDs as dead without probing', () => {
        const kill = () => { throw new Error('should not be called'); };
        expect(isPidAlive(undefined, kill)).toBe(false);
        expect(isPidAlive(0, kill)).toBe(false);
        expect(isPidAlive(-1, kill)).toBe(false);
    });
});

describe('machineBootTimeMs', () => {
    it('subtracts uptime from now', () => {
        expect(machineBootTimeMs(60, 1_000_000)).toBe(1_000_000 - 60_000);
    });
});

describe('resolveLiveOwnerPid', () => {
    it('returns nothing when the session has no tracked or persisted process', () => {
        expect(resolveLiveOwnerPid({ trackedPids: [], bootTimeMs: BOOT, isAlive: alive([]) })).toBeUndefined();
    });

    it('returns a tracked PID that is still alive', () => {
        expect(resolveLiveOwnerPid({ trackedPids: [77], bootTimeMs: BOOT, isAlive: alive([77]) })).toBe(77);
    });

    it('skips a dead tracked entry left behind next to a live one', () => {
        // Tracking is keyed by PID and is cleared lazily, so a session can hold a
        // stale entry alongside its real one. Answering from the stale entry would
        // report "no owner" and wave a duplicate spawn through.
        expect(resolveLiveOwnerPid({ trackedPids: [11, 22], bootTimeMs: BOOT, isAlive: alive([22]) })).toBe(22);
    });

    it('falls back to the on-disk record when the daemon tracks nothing', () => {
        // The case after a daemon restart: children are detached and outlive it.
        const owner = resolveLiveOwnerPid({
            trackedPids: [],
            persisted: { metadata: { hostPid: 99 }, savedAt: BOOT + 5_000 },
            bootTimeMs: BOOT,
            isAlive: alive([99]),
        });
        expect(owner).toBe(99);
    });

    it('ignores an on-disk PID recorded before the current boot', () => {
        // A reboot resets the PID space, so that number now belongs to whatever
        // reused it — probing it would be a confident false positive.
        const owner = resolveLiveOwnerPid({
            trackedPids: [],
            persisted: { metadata: { hostPid: 99 }, savedAt: BOOT - 1 },
            bootTimeMs: BOOT,
            isAlive: alive([99]),
        });
        expect(owner).toBeUndefined();
    });

    it('reads the PID out of a record shaped exactly as the daemon stores it', () => {
        // Pins the parameter against the real `PersistedSession`. The PID lives
        // under `metadata`, and a version of this that reached for a top-level
        // field still type-checked, still passed every other test here, and
        // resolved every owner to `undefined` — a guard that never fires is
        // indistinguishable from one with nothing to guard against.
        const stored: PersistedSession = {
            encryptionKey: '',
            encryptionVariant: 'dataKey',
            seq: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: { path: '/tmp/project', hostPid: 1234 } as PersistedSession['metadata'],
            savedAt: BOOT + 1,
        };
        const owner = resolveLiveOwnerPid({
            trackedPids: [],
            persisted: stored,
            bootTimeMs: BOOT,
            isAlive: alive([1234]),
        });
        expect(owner).toBe(1234);
    });

    it('returns nothing when the on-disk PID is dead', () => {
        const owner = resolveLiveOwnerPid({
            trackedPids: [],
            persisted: { metadata: { hostPid: 99 }, savedAt: BOOT + 5_000 },
            bootTimeMs: BOOT,
            isAlive: alive([]),
        });
        expect(owner).toBeUndefined();
    });
});

describe('classifyResumeConflict', () => {
    const active: SessionPresence = { ok: true, active: true };
    const inactive: SessionPresence = { ok: true, active: false };

    it('allows the spawn when no process owns the session', () => {
        expect(classifyResumeConflict(undefined, inactive)).toBe('none');
    });

    it('reports a healthy owner as already running', () => {
        expect(classifyResumeConflict(50, active)).toBe('already-running');
    });

    it('reports a live process the server no longer sees as wedged', () => {
        expect(classifyResumeConflict(50, inactive)).toBe('wedged');
    });

    it.each(['unreachable', 'unknown-session'] as const)(
        'treats a %s server as already running rather than wedged',
        (reason) => {
            // A failed probe must not read as "nobody is attached": that answer
            // gets the owning process killed. Refusing costs the user a retry.
            expect(classifyResumeConflict(50, { ok: false, reason })).toBe('already-running');
        },
    );
});
