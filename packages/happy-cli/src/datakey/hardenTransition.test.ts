/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R17 — `happy datakey
 * harden` drops the trust marks compat left while no daemon can run.
 */
import { describe, expect, it } from 'vitest';
import { runHarden, type HardenIo, type HardenState } from './hardenTransition';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const dataKey = (extra: Record<string, unknown> = {}) => ({ token: 't', encryption: { publicKey: key(2), machineKey: key(3), ...extra } });

function fakeIo(states: HardenState[], options: { locked?: boolean; failSetStrict?: boolean } = {}) {
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

        expect(await runHarden(io)).toEqual({ ok: true, alreadyStrict: false, reset: { neverEscrowed: true, pending: true } });
        expect(calls).toEqual(['read', 'lock', 'read', 'drop-never-escrowed', 'discard-pending', 'set-strict', 'release']);
    });

    it('judges the files again once no daemon can write them', async () => {
        const { io, calls } = fakeIo([compat(dataKey()), compat(dataKey({ neverEscrowed: true }))]);

        expect(await runHarden(io)).toEqual({ ok: true, alreadyStrict: false, reset: { neverEscrowed: true, pending: false } });
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

    it('changes nothing on a machine that is already strict', async () => {
        const { io, calls } = fakeIo([{ mode: 'strict', rawCredentials: dataKey({ neverEscrowed: true }), pendingExists: true }]);

        expect(await runHarden(io)).toEqual({ ok: true, alreadyStrict: true });
        expect(calls).toEqual(['read']);
    });

    it('refuses credentials it cannot harden without taking the lock', async () => {
        const { io, calls } = fakeIo([compat(null)]);

        expect(await runHarden(io)).toEqual({ ok: false, reason: 'no-credentials' });
        expect(calls).toEqual(['read']);
    });
});
