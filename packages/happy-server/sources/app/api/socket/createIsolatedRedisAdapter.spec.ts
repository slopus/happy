import { describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import { createIsolatedRedisAdapter, RESTORE_SESSION_TIMEOUT_MS } from './createIsolatedRedisAdapter';
import { redisStreamReadDuration, redisStreamWriteDuration, register } from '@/app/monitoring/metrics2';
import { instrumentStreamWrites } from '@/app/monitoring/redisHealth';
import { log } from '@/utils/log';

vi.mock('@/utils/log', () => ({ log: vi.fn() }));

function redisConnection(restore: { exec: () => Promise<unknown>; xrange: () => Promise<unknown> } = {
    exec: () => new Promise(() => {}),
    xrange: () => new Promise(() => {}),
}) {
    let blocked = false;
    let unblock!: () => void;
    const pendingRead = new Promise<null>(resolve => { unblock = () => resolve(null); });
    const published: unknown[][] = [];
    let setResult: () => Promise<unknown> = async () => 'OK';
    // A plain function, not vi.fn(): vitest attaches its own handlers to a
    // mock's returned promise to record how it settled, which would mark a
    // rejection as handled and make the assertion below vacuous.
    const setCalls: unknown[][] = [];
    const client = {
        set: (...args: unknown[]) => { setCalls.push(args); return setResult(); },
        xread: vi.fn(() => { blocked = true; return pendingRead; }),
        xadd: vi.fn(async (...args: unknown[]) => {
            if (blocked) await pendingRead;
            published.push(args);
            return '1-0';
        }),
        disconnect: vi.fn(() => unblock()),
        multi: () => ({ get() { return this; }, del() { return this; }, exec: restore.exec }),
        xrange: vi.fn(restore.xrange),
    };
    return { client: client as unknown as Redis, xread: client.xread,
        disconnect: client.disconnect, published, setCalls,
        rejectSetWith: (error: Error) => { setResult = () => Promise.reject(error); } };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('createIsolatedRedisAdapter', () => {
    it.each(['success', 'failure'] as const)('observes %s XADD through the actual streams adapter publish path', async (result) => {
        const writer = redisConnection(), reader = redisConnection();
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const observe = vi.fn((outcome: 'success' | 'failure', seconds: number) => redisStreamWriteDuration.observe({ result: outcome }, seconds));
        const failure = vi.fn(), error = new Error('Command timed out');
        const command = vi.fn(async () => '2-0');
        writer.client.xadd = command as unknown as Redis['xadd'];
        instrumentStreamWrites(writer.client, failure, observe);
        let io: Server | undefined;
        try {
            redisStreamWriteDuration.reset();
            io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
            await flush();
            // Prime startup handshakes, then observe one actual broadcast publish.
            command.mockClear();
            observe.mockClear();
            failure.mockClear();
            redisStreamWriteDuration.reset();
            command.mockImplementation(async () => { now = 400; if (result === 'failure') throw error; return '2-0'; });
            io.emit('probe', 'value');
            await flush();
            expect(command).toHaveBeenCalledOnce();
            expect(observe).toHaveBeenCalledExactlyOnceWith(result, 0.4);
            const metrics = (await register.metrics());
            expect(metrics).toContain(`redis_stream_write_duration_seconds_count{app="happy-server",result="${result}"} 1\n`);
            expect(metrics).toContain(`redis_stream_write_duration_seconds_sum{app="happy-server",result="${result}"} 0.4\n`);
            if (result === 'failure') expect(failure).toHaveBeenCalledExactlyOnceWith('TIMEOUT', error);
            else expect(failure).not.toHaveBeenCalled();
        } finally {
            io?.of('/').adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
            await flush();
            clock.mockRestore();
            redisStreamWriteDuration.reset();
        }
    });

    it.each(['socket.io', 'socket.io.managed'])('logs only successful %s reads over one second and throttles for one minute', async (streamName) => {
        const writer = redisConnection();
        const reader = redisConnection();
        const bus = streamName === 'socket.io.managed' ? 'managed' : 'account';
        let elapsed = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
        const wallClock = vi.spyOn(Date, 'now').mockReturnValue(100);
        let resolveRead!: (value: null) => void;
        reader.xread.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
        vi.mocked(log).mockClear();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, { streamName }) });
        const finishRead = async (milliseconds: number) => {
            elapsed += milliseconds;
            resolveRead(null);
            await flush();
        };
        const slowLogs = () => vi.mocked(log).mock.calls.filter(([, message]) => String(message).includes('cluster stream read slow'));
        try {
            await finishRead(1_000);
            expect(slowLogs()).toHaveLength(0);
            await finishRead(1_201);
            expect(slowLogs()).toEqual([[{ module: 'websocket', level: 'warn' },
                `cluster stream read slow (${bus}, 1201ms, throttled to 1/min)`]]);
            await finishRead(2_000);
            expect(slowLogs()).toHaveLength(1);
            wallClock.mockReturnValue(60_100);
            await finishRead(1_500);
            expect(slowLogs()).toHaveLength(2);
            expect(slowLogs()[1][1]).toBe(`cluster stream read slow (${bus}, 1500ms, throttled to 1/min)`);
            expect(reader.xread).toHaveBeenCalledTimes(5);
            io.of('/').adapter.close();
            await finishRead(2_000);
            expect(slowLogs()).toHaveLength(2);
            expect(reader.xread).toHaveBeenCalledTimes(5);
        } finally {
            io.of('/').adapter.close();
            resolveRead(null);
            await flush();
            writer.client.disconnect();
            clock.mockRestore();
            wallClock.mockRestore();
        }
    });

    it('does not let an account slow-read log suppress the managed bus log', async () => {
        let elapsed = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
        const connections = ['socket.io', 'socket.io.managed'].map(streamName => {
            const writer = redisConnection();
            const reader = redisConnection();
            let resolveRead!: (value: null) => void;
            reader.xread.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
            const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, { streamName }) });
            return { writer, io, resolve: () => resolveRead(null) };
        });
        vi.mocked(log).mockClear();
        try {
            elapsed = 2_000;
            connections.forEach(connection => connection.resolve());
            await flush();
            expect(vi.mocked(log).mock.calls.filter(([, message]) => String(message).includes('cluster stream read slow')))
                .toEqual(['account', 'managed'].map(bus => [{ module: 'websocket', level: 'warn' },
                    `cluster stream read slow (${bus}, 2000ms, throttled to 1/min)`]));
        } finally {
            connections.forEach(connection => {
                connection.io.of('/').adapter.close();
                connection.resolve();
                connection.writer.client.disconnect();
            });
            await flush();
            clock.mockRestore();
        }
    });

    it.each(['socket.io', 'socket.io.managed'])('exposes a %s read failure swallowed by the adapter and continues polling', async (streamName) => {
        const writer = redisConnection();
        const reader = redisConnection();
        const bus = streamName === 'socket.io.managed' ? 'managed' : 'account';
        const failure = new Error('Command timed out');
        const metric = () => register.getSingleMetric('redis_stream_read_failures_total');
        const count = async () => (await metric()?.get())?.values.find(value => value.labels.bus === bus && value.labels.code === 'TIMEOUT')?.value ?? 0;
        const before = await count();
        vi.mocked(log).mockClear();
        reader.xread.mockRejectedValueOnce(failure);
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, { streamName }) });
        try {
            await flush();
            expect(reader.xread).toHaveBeenCalledTimes(2);
            expect(await count()).toBe(before + 1);
            expect(log).toHaveBeenCalledWith({ module: 'websocket', level: 'warn' },
                expect.stringContaining(`cluster stream read failed (${bus}, TIMEOUT`));
        } finally {
            io.of('/').adapter.close();
            writer.client.disconnect();
        }
    });

    it('counts every failed read, throttles its log and records the next successful read', async () => {
        const writer = redisConnection();
        const reader = redisConnection();
        const readMetrics = async () => (await redisStreamReadDuration.get()).values
            .filter(value => value.metricName === 'redis_stream_read_duration_seconds_count' && value.labels.bus === 'account');
        const before = await readMetrics();
        const count = (values: typeof before, result: string) => values.find(value => value.labels.result === result)?.value ?? 0;
        reader.xread.mockRejectedValueOnce(new Error('Command timed out'))
            .mockRejectedValueOnce(new Error('Command timed out')).mockResolvedValueOnce(null);
        vi.mocked(log).mockClear();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
        try {
            await flush();
            const after = await readMetrics();
            expect(reader.xread).toHaveBeenCalledTimes(4);
            expect(count(after, 'failure') - count(before, 'failure')).toBe(2);
            expect(count(after, 'success') - count(before, 'success')).toBe(1);
            expect(vi.mocked(log).mock.calls.filter(([, message]) => String(message).includes('cluster stream read failed'))).toHaveLength(1);
        } finally {
            io.of('/').adapter.close();
            writer.client.disconnect();
        }
    });

    it('does not count the intentional shutdown rejection as a read failure', async () => {
        const writer = redisConnection();
        const reader = redisConnection();
        let rejectRead!: (error: Error) => void;
        reader.xread.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
        const metrics = async () => (await register.getSingleMetric('redis_stream_read_failures_total')!.get()).values;
        const before = await metrics();
        vi.mocked(log).mockClear();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
        io.of('/').adapter.close();
        rejectRead(new Error('Connection is closed.'));
        await flush();
        expect(await metrics()).toEqual(before);
        expect(reader.xread).toHaveBeenCalledTimes(1);
        expect(vi.mocked(log).mock.calls.filter(([, message]) => String(message).includes('cluster stream read failed'))).toEqual([]);
        writer.client.disconnect();
    });

    it.each(['socket.io', 'socket.io.managed'])('publishes %s requests while the stream reader is blocked', async (streamName) => {
        const writer = redisConnection();
        const reader = redisConnection();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client,
            { streamName, maxLen: 200000, readCount: 2000 }) });
        try {
            io.serverSideEmit('probe');
            await flush();
            expect(reader.xread).toHaveBeenCalledWith('BLOCK', 100, 'COUNT', 2000, 'STREAMS', streamName, '$');
            expect(writer.xread).not.toHaveBeenCalled();
            expect(writer.published.some(([fields]) => (fields as string[]).includes('9'))).toBe(true);
        } finally {
            io.of('/').adapter.close();
            io._nsps.get('/other')?.adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });

    it('keeps the reader for other namespaces and disconnects it only after the last closes', async () => {
        const writer = redisConnection();
        const reader = redisConnection();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
        const root = io.of('/').adapter;
        const other = io.of('/other').adapter;
        try {
            root.close();
            expect(reader.disconnect).not.toHaveBeenCalled();
            other.close();
            expect(reader.disconnect).toHaveBeenCalledTimes(1);
            other.close();
            expect(reader.disconnect).toHaveBeenCalledTimes(1);
            expect(writer.disconnect).not.toHaveBeenCalled();
        } finally {
            io.of('/').adapter.close();
            io._nsps.get('/other')?.adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });

    /*
     * 2026-09-23 prod: the Redis connection went half-open for ~17 minutes.
     * socket.io awaits restoreSession BEFORE auth middleware for every client
     * reconnecting with a pid, so every reconnect hung until the client's
     * 20s connect timeout — daemons fell out of their RPC rooms and callers
     * got "RPC method not available". A stalled restore must degrade to a
     * plain (unrecovered) connection instead.
     */
    it('gives up on a stalled session restore so the reconnect proceeds without recovery', async () => {
        vi.useFakeTimers();
        const writer = redisConnection();
        const reader = redisConnection();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
        try {
            let outcome: unknown = 'pending';
            io.of('/').adapter.restoreSession('pid', '1-0').then(
                session => { outcome = session; },
                error => { outcome = error; });
            await vi.advanceTimersByTimeAsync(RESTORE_SESSION_TIMEOUT_MS - 1);
            expect(outcome).toBe('pending');
            await vi.advanceTimersByTimeAsync(1);
            expect(outcome).toEqual(new Error('restoreSession timed out'));
        } finally {
            vi.useRealTimers();
            io.of('/').adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });

    /*
     * The adapter's persistSession() drops the promise of its session-state
     * SET, and socket.io calls persistSession un-awaited for every recoverable
     * disconnect. main.ts ends an unhandled rejection in process.exit(1), so
     * once Redis commands have a deadline one disconnecting client during a
     * stall would take the whole replica down.
     */
    it('does not leave a failed session-state write unhandled', async () => {
        const writer = redisConnection();
        const reader = redisConnection();
        const io = new Server({
            connectionStateRecovery: { maxDisconnectionDuration: 60_000, skipMiddlewares: true },
            adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}),
        });
        const unhandled: string[] = [];
        const onUnhandledRejection = (reason: unknown) => { unhandled.push(String(reason)); };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            writer.rejectSetWith(new Error('Command timed out'));
            io.of('/').adapter.persistSession({ sid: 's1', pid: 'p1', rooms: new Set(), data: {} } as never);
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(writer.setCalls).toHaveLength(1);
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
            io.of('/').adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });

    it('passes a prompt restore result through unchanged', async () => {
        const writer = redisConnection({
            exec: async () => [[null, null], [null, 0]],
            xrange: async () => [],
        });
        const reader = redisConnection();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
        try {
            await expect(io.of('/').adapter.restoreSession('pid', '1-0')).rejects.toBe('session or offset not found');
        } finally {
            io.of('/').adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });
});
