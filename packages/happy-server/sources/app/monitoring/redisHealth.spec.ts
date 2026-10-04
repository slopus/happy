import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogThrottle, instrumentStreamReads, instrumentStreamWrites, readClusterPeerCount, redisErrorCode } from './redisHealth';

afterEach(() => vi.restoreAllMocks());

describe('redisErrorCode', () => {
    it('shouldLabelIoredisCommandTimeoutsSeparatelyFromUnknownErrors', () => {
        expect(redisErrorCode(new Error('Command timed out'))).toBe('TIMEOUT');
    });
    it('shouldLabelReadonlyReplyAsReadonly', () => {
        // The failure mode that silently killed the cluster bus: after a
        // Sentinel failover the client stays pinned to the demoted replica and
        // every XADD comes back -READONLY.
        expect(redisErrorCode(new Error("READONLY You can't write against a read only replica."))).toBe('READONLY');
    });

    it('shouldUseIoredisErrorCodeWhenPresent', () => {
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        expect(redisErrorCode(err)).toBe('ECONNREFUSED');
    });

    it('shouldLabelLoadingReplyAsLoading', () => {
        expect(redisErrorCode(new Error('LOADING Redis is loading the dataset in memory'))).toBe('LOADING');
    });

    it('shouldFallBackToUnknownForUnrecognizedErrors', () => {
        expect(redisErrorCode(new Error('something else entirely'))).toBe('UNKNOWN');
        expect(redisErrorCode('not an error')).toBe('UNKNOWN');
    });
});

describe('instrumentStreamReads', () => {
    it.each(['success', 'failure'])('preserves the read %s when the diagnostic clock throws before it starts', async (outcome) => {
        const failure = new Error('read failed');
        const result = [['socket.io', []]];
        const read = vi.fn(async (..._args: any[]) => {
            if (outcome === 'failure') throw failure;
            return result;
        });
        const client = { xread: read };
        const observe = vi.fn();
        instrumentStreamReads(client, observe);
        vi.spyOn(performance, 'now').mockImplementationOnce(() => { throw new Error('clock failed'); });
        const pending = client.xread('BLOCK', 100, 'STREAMS', 'socket.io', '1-0');
        if (outcome === 'failure') await expect(pending).rejects.toBe(failure);
        else expect(await pending).toBe(result);
        expect(read).toHaveBeenCalledExactlyOnceWith('BLOCK', 100, 'STREAMS', 'socket.io', '1-0');
        expect(observe).not.toHaveBeenCalled();
    });

    it('preserves read arguments, receiver and result and observes elapsed time', async () => {
        vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(850);
        const result = [['socket.io', []]];
        const observe = vi.fn();
        const client = { xread: vi.fn(async function (this: unknown, ..._args: any[]) {
            expect(this).toBe(client);
            return result;
        }) };
        const read = client.xread;
        instrumentStreamReads(client, observe);
        expect(await client.xread('BLOCK', 100, 'STREAMS', 'socket.io', '1-0')).toBe(result);
        expect(read).toHaveBeenCalledExactlyOnceWith('BLOCK', 100, 'STREAMS', 'socket.io', '1-0');
        expect(observe).toHaveBeenCalledExactlyOnceWith('success', 0.75);
    });

    it('preserves the read error even when its observer throws', async () => {
        const failure = new Error('Command timed out');
        const observe = vi.fn(() => { throw new Error('observer failed'); });
        const client = { xread: vi.fn(async (..._args: any[]) => { throw failure; }) };
        instrumentStreamReads(client, observe);
        await expect(client.xread()).rejects.toBe(failure);
        expect(observe).toHaveBeenCalledExactlyOnceWith('failure', expect.any(Number), failure);
    });

    it('does not turn a successful read into a failure when observation throws', async () => {
        const client = { xread: async (..._args: any[]) => null };
        const observe = vi.fn(() => { throw new Error('observer failed'); });
        instrumentStreamReads(client, observe);
        await expect(client.xread()).resolves.toBeNull();
        expect(observe).toHaveBeenCalledTimes(1);
    });
});

describe('createLogThrottle', () => {
    it('shouldAllowFirstOccurrenceOfEachKey', () => {
        const throttle = createLogThrottle(60_000, () => 0);
        expect(throttle('READONLY')).toBe(true);
        expect(throttle('ECONNREFUSED')).toBe(true);
    });

    it('shouldSuppressRepeatsOfTheSameKeyWithinTheInterval', () => {
        // 875k READONLY replies in 4h is ~65/s — logging each would drown the
        // log. One line per key per interval is enough to see it.
        let now = 0;
        const throttle = createLogThrottle(60_000, () => now);
        expect(throttle('READONLY')).toBe(true);
        now = 59_999;
        expect(throttle('READONLY')).toBe(false);
    });

    it('shouldAllowAgainOnceTheIntervalElapsed', () => {
        let now = 0;
        const throttle = createLogThrottle(60_000, () => now);
        throttle('READONLY');
        now = 60_000;
        expect(throttle('READONLY')).toBe(true);
    });
});

describe('readClusterPeerCount', () => {
    it('shouldReportPeersAsServerCountMinusSelf', async () => {
        // replicas=2 with a healthy bus → 1 peer.
        await expect(readClusterPeerCount({ serverCount: async () => 2 })).resolves.toBe(1);
    });

    it('shouldReportZeroPeersWhenTheBusIsDead', async () => {
        // The decisive signal: serverCount collapses to 1 (self only) because
        // no heartbeats arrive, so fetchSockets silently returns local-only
        // results instead of erroring.
        await expect(readClusterPeerCount({ serverCount: async () => 1 })).resolves.toBe(0);
    });

    it('shouldReportMinusOneWhenServerCountIsUnavailable', async () => {
        await expect(readClusterPeerCount({})).resolves.toBe(-1);
        await expect(readClusterPeerCount({ serverCount: async () => { throw new Error('boom'); } })).resolves.toBe(-1);
    });
});

describe('instrumentStreamWrites', () => {
    it.each(['success', 'failure'] as const)('observes %s write elapsed without changing command arguments or outcome', async (result) => {
        let now = 10;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const error = new Error('Command timed out');
        const command = vi.fn(async (..._args: any[]) => {
            now = 410;
            if (result === 'failure') throw error;
            return '2-0';
        });
        const client = { xadd: command };
        const failure = vi.fn(), observe = vi.fn();
        instrumentStreamWrites(client, failure, observe);
        if (result === 'success') await expect(client.xadd('stream', '*', 'data', 'private')).resolves.toBe('2-0');
        else await expect(client.xadd('stream', '*', 'data', 'private')).rejects.toBe(error);
        expect(command).toHaveBeenCalledExactlyOnceWith('stream', '*', 'data', 'private');
        expect(observe).toHaveBeenCalledExactlyOnceWith(result, 0.4);
        if (result === 'failure') expect(failure).toHaveBeenCalledExactlyOnceWith('TIMEOUT', error);
        else expect(failure).not.toHaveBeenCalled();
    });

    it.each(['success', 'failure'] as const)('preserves %s outcome when observation callbacks throw', async (result) => {
        const error = new Error('READONLY write failed');
        const command = vi.fn(async () => { if (result === 'failure') throw error; return '2-0'; });
        const client = { xadd: command };
        const observe = vi.fn(() => { throw new Error('metrics unavailable'); });
        instrumentStreamWrites(client, () => { throw new Error('logger unavailable'); }, observe);
        if (result === 'success') await expect(client.xadd()).resolves.toBe('2-0');
        else await expect(client.xadd()).rejects.toBe(error);
        expect(command).toHaveBeenCalledOnce();
        expect(observe).toHaveBeenCalledOnce();
    });

    it.each(['success', 'failure'] as const)('still executes %s writes if the elapsed clock is unavailable', async (result) => {
        vi.spyOn(performance, 'now').mockImplementation(() => { throw new Error('clock unavailable'); });
        const error = new Error('Command timed out');
        const command = vi.fn(async () => { if (result === 'failure') throw error; return '2-0'; });
        const client = { xadd: command }, failure = vi.fn(), observe = vi.fn();
        instrumentStreamWrites(client, failure, observe);
        if (result === 'success') await expect(client.xadd()).resolves.toBe('2-0');
        else await expect(client.xadd()).rejects.toBe(error);
        expect(command).toHaveBeenCalledOnce();
        expect(observe).not.toHaveBeenCalled();
        if (result === 'failure') expect(failure).toHaveBeenCalledExactlyOnceWith('TIMEOUT', error);
    });

    it('observes a synchronous write throw once and keeps the original error', async () => {
        vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(260);
        const error = new Error('Command timed out');
        const client = { xadd: vi.fn(() => { throw error; }) };
        const failure = vi.fn(), observe = vi.fn();
        instrumentStreamWrites(client, failure, observe);
        await expect(client.xadd()).rejects.toBe(error);
        expect(observe).toHaveBeenCalledExactlyOnceWith('failure', 0.25);
        expect(failure).toHaveBeenCalledExactlyOnceWith('TIMEOUT', error);
    });

    it('shouldPassThroughSuccessfulWrites', async () => {
        const onFailure = vi.fn();
        const client = { xadd: vi.fn(async (..._args: any[]) => '1-0') };
        instrumentStreamWrites(client, onFailure);
        await expect(client.xadd('socket.io')).resolves.toBe('1-0');
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('shouldReportFailureCodeAndStillRejectSoCallerBehaviourIsUnchanged', async () => {
        // socket.io-adapter swallows publish rejections into debug() logs
        // (cluster-adapter.js publish()), so wrapping the command is the only
        // place a failed XADD becomes observable. It must still reject.
        const onFailure = vi.fn();
        const err = new Error("READONLY You can't write against a read only replica.");
        const client = { xadd: vi.fn(async (..._args: any[]) => { throw err; }) };
        instrumentStreamWrites(client, onFailure);
        await expect(client.xadd('socket.io')).rejects.toThrow(err);
        expect(onFailure).toHaveBeenCalledWith('READONLY', err);
    });
});
