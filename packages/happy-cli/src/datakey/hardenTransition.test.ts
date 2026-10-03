/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R17 — `happy datakey
 * harden` drops the trust marks compat left while no daemon can run.
 */
import { describe, expect, it } from 'vitest';
import { hardenBlockingSessions, runHarden, type HardenIo, type HardenState } from './hardenTransition';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const dataKey = (extra: Record<string, unknown> = {}) => ({ token: 't', encryption: { publicKey: key(2), machineKey: key(3), ...extra } });

function fakeIo(states: HardenState[], options: { locked?: boolean; failSetStrict?: boolean; sessions?: Array<{ pid: number; command: string }> } = {}) {
    const calls: string[] = [];
    let reads = 0;
    const io: HardenIo = {
        readState: async () => {
            calls.push('read');
            return states[Math.min(reads++, states.length - 1)];
        },
        lockDaemonStart: async () => {
            calls.push('lock');
            return options.locked ? null : async () => { calls.push('release'); };
        },
        liveSessions: async () => {
            calls.push('sessions');
            return options.sessions ?? [];
        },
        dropNeverEscrowed: async () => { calls.push('drop-never-escrowed'); },
        discardPendingRotation: async () => { calls.push('discard-pending'); },
        setStrict: async () => {
            calls.push('set-strict');
            if (options.failSetStrict) throw new Error('settings are not writable');
        },
    };
    return { io, calls };
}

const compat = (rawCredentials: unknown, pendingExists = false): HardenState => ({ mode: 'compat', rawCredentials, pendingExists });

describe('runHarden', () => {
    it('drops the marks compat left and switches to strict while no daemon can start', async () => {
        const { io, calls } = fakeIo([compat(dataKey({ neverEscrowed: true }), true)]);

        expect(await runHarden(io)).toEqual({ ok: true, markedStrict: false, reset: { neverEscrowed: true, pending: true } });
        expect(calls).toEqual(['read', 'lock', 'sessions', 'read', 'drop-never-escrowed', 'discard-pending', 'set-strict', 'release']);
    });

    it('judges the files again once no daemon can write them', async () => {
        const { io, calls } = fakeIo([compat(dataKey()), compat(dataKey({ neverEscrowed: true }))]);

        expect(await runHarden(io)).toEqual({ ok: true, markedStrict: false, reset: { neverEscrowed: true, pending: false } });
        expect(calls).toContain('drop-never-escrowed');
    });

    it('refuses while a daemon holds the start lock, and changes nothing', async () => {
        const { io, calls } = fakeIo([compat(dataKey({ neverEscrowed: true }), true)], { locked: true });

        expect(await runHarden(io)).toEqual({ ok: false, reason: 'daemon-running' });
        expect(calls).toEqual(['read', 'lock']);
    });

    it('releases the lock when a step fails', async () => {
        const { io, calls } = fakeIo([compat(dataKey())], { failSetStrict: true });

        await expect(runHarden(io)).rejects.toThrow('settings are not writable');
        expect(calls.at(-1)).toBe('release');
    });

    // compat could have marked the machine strict beside a key it knows (settings.json and the
    // never-escrowed mark are both under the happy home it could write), so an explicit harden
    // resets it all again instead of trusting the mark.
    it('resets a machine already marked strict, under the lock', async () => {
        const { io, calls } = fakeIo([{ mode: 'strict', rawCredentials: dataKey({ neverEscrowed: true }), pendingExists: true }]);

        expect(await runHarden(io)).toEqual({ ok: true, markedStrict: true, reset: { neverEscrowed: true, pending: true } });
        expect(calls).toEqual(['read', 'lock', 'sessions', 'read', 'drop-never-escrowed', 'discard-pending', 'set-strict', 'release']);
    });

    // A session is a detached process that outlives `happy daemon stop`. One started under compat
    // keeps compat's RPC policy and a session key the server could have read, after the switch too.
    it('refuses while happy sessions are still running, and changes nothing', async () => {
        const sessions = [{ pid: 4242, command: 'node happy.mjs --started-by daemon' }];
        const { io, calls } = fakeIo([compat(dataKey({ neverEscrowed: true }), true)], { sessions });

        expect(await runHarden(io)).toEqual({ ok: false, reason: 'sessions-running', sessions });
        expect(calls).toEqual(['read', 'lock', 'sessions', 'release']);
    });

    it('refuses credentials it cannot harden without taking the lock', async () => {
        const { io, calls } = fakeIo([compat(null)]);

        expect(await runHarden(io)).toEqual({ ok: false, reason: 'no-credentials' });
        expect(calls).toEqual(['read']);
    });
});

describe('hardenBlockingSessions', () => {
    it('keeps session processes and leaves out the daemon, doctor, version checks and this process', () => {
        expect(hardenBlockingSessions([
            { pid: 1, command: 'happy --started-by daemon', type: 'daemon-spawned-session' },
            { pid: 2, command: 'tsx src/index.ts --started-by daemon', type: 'dev-daemon-spawned' },
            { pid: 3, command: 'happy', type: 'user-session' },
            { pid: 4, command: 'happy --yolo', type: 'dev-session' },
            { pid: 5, command: 'happy daemon start', type: 'daemon' },
            { pid: 6, command: 'happy doctor', type: 'doctor' },
            { pid: 7, command: 'happy --version', type: 'daemon-version-check' },
            { pid: 8, command: 'happy datakey harden', type: 'current' },
        ])).toEqual([
            { pid: 1, command: 'happy --started-by daemon' },
            { pid: 2, command: 'tsx src/index.ts --started-by daemon' },
            { pid: 3, command: 'happy' },
            { pid: 4, command: 'happy --yolo' },
        ]);
    });
});
