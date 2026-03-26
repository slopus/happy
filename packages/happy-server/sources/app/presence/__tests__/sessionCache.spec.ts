import { afterEach, describe, expect, it, vi } from "vitest";

type SessionRecord = {
    lastActiveAt: Date;
};

type MachineRecord = {
    lastActiveAt?: Date | null;
};

type SessionCacheModule = typeof import("../sessionCache");

type TestContext = {
    module: SessionCacheModule;
    cache: InstanceType<SessionCacheModule['ActivityCache']>;
    db: {
        session: {
            findUnique: ReturnType<typeof vi.fn>;
            update: ReturnType<typeof vi.fn>;
        };
        machine: {
            findUnique: ReturnType<typeof vi.fn>;
            update: ReturnType<typeof vi.fn>;
        };
    };
    metrics: {
        sessionCacheInc: ReturnType<typeof vi.fn>;
        databaseUpdatesSkippedInc: ReturnType<typeof vi.fn>;
    };
    log: ReturnType<typeof vi.fn>;
};

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function createTestContext(): Promise<TestContext> {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const db = {
        session: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        machine: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
    };
    const metrics = {
        sessionCacheInc: vi.fn(),
        databaseUpdatesSkippedInc: vi.fn(),
    };
    const log = vi.fn();

    vi.doMock('@/storage/db', () => ({ db }));
    vi.doMock('@/app/monitoring/metrics2', () => ({
        sessionCacheCounter: {
            inc: metrics.sessionCacheInc,
        },
        databaseUpdatesSkippedCounter: {
            inc: metrics.databaseUpdatesSkippedInc,
        },
    }));
    vi.doMock('@/utils/log', () => ({ log }));

    const module = await import('../sessionCache');
    module.activityCache.shutdown();

    return {
        module,
        cache: new module.ActivityCache(),
        db,
        metrics,
        log,
    };
}

async function shutdownContext(context: TestContext): Promise<void> {
    context.cache.shutdown();
    await flushMicrotasks();
}

afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('ActivityCache', () => {
    it('uses the database on cache miss, serves cache hits, and revalidates after ttl expiry', async () => {
        const context = await createTestContext();
        const { cache, db, metrics } = context;
        const initialLastActiveAt = new Date('2024-01-01T00:00:00.000Z');

        db.session.findUnique.mockResolvedValue({ lastActiveAt: initialLastActiveAt } satisfies SessionRecord);

        await expect(cache.isSessionValid('session-1', 'user-1')).resolves.toBe(true);
        expect(db.session.findUnique).toHaveBeenCalledTimes(1);
        expect(metrics.sessionCacheInc).toHaveBeenNthCalledWith(1, {
            operation: 'session_validation',
            result: 'miss',
        });

        await expect(cache.isSessionValid('session-1', 'user-1')).resolves.toBe(true);
        expect(db.session.findUnique).toHaveBeenCalledTimes(1);
        expect(metrics.sessionCacheInc).toHaveBeenNthCalledWith(2, {
            operation: 'session_validation',
            result: 'hit',
        });

        vi.setSystemTime(new Date('2024-01-01T00:00:30.001Z'));

        await expect(cache.isSessionValid('session-1', 'user-1')).resolves.toBe(true);
        expect(db.session.findUnique).toHaveBeenCalledTimes(2);
        expect(metrics.sessionCacheInc).toHaveBeenNthCalledWith(3, {
            operation: 'session_validation',
            result: 'miss',
        });

        await shutdownContext(context);
    });

    it('returns false and logs when session validation lookup fails', async () => {
        const context = await createTestContext();
        const { cache, db, log, metrics } = context;

        db.session.findUnique.mockRejectedValue(new Error('database unavailable'));

        await expect(cache.isSessionValid('session-1', 'user-1')).resolves.toBe(false);
        expect(metrics.sessionCacheInc).toHaveBeenCalledWith({
            operation: 'session_validation',
            result: 'miss',
        });
        expect(log).toHaveBeenCalledWith(
            { module: 'session-cache', level: 'error' },
            expect.stringContaining('Error validating session session-1: Error: database unavailable')
        );

        await shutdownContext(context);
    });

    it('queues session updates only when they exceed the debounce threshold', async () => {
        const context = await createTestContext();
        const { cache, db, metrics } = context;
        const initialLastActiveAt = new Date('2024-01-01T00:00:00.000Z');

        db.session.findUnique.mockResolvedValue({ lastActiveAt: initialLastActiveAt } satisfies SessionRecord);
        await cache.isSessionValid('session-1', 'user-1');

        expect(cache.queueSessionUpdate('missing-session', Date.parse('2024-01-01T00:00:40.000Z'))).toBe(false);

        const nearTimestamp = Date.parse('2024-01-01T00:00:10.000Z');
        expect(cache.queueSessionUpdate('session-1', nearTimestamp)).toBe(false);
        expect(metrics.databaseUpdatesSkippedInc).toHaveBeenCalledWith({ type: 'session' });
        expect((cache as any).sessionCache.get('session-1')?.pendingUpdate).toBeNull();

        const farTimestamp = Date.parse('2024-01-01T00:00:31.000Z');
        expect(cache.queueSessionUpdate('session-1', farTimestamp)).toBe(true);
        expect((cache as any).sessionCache.get('session-1')?.pendingUpdate).toBe(farTimestamp);

        await shutdownContext(context);
    });

    it('flushes queued session and machine updates to the database', async () => {
        const context = await createTestContext();
        const { cache, db } = context;

        const baseTime = new Date('2024-01-01T00:00:00.000Z');
        db.session.findUnique.mockResolvedValue({ lastActiveAt: baseTime } satisfies SessionRecord);
        db.machine.findUnique.mockResolvedValue({ lastActiveAt: baseTime } satisfies MachineRecord);
        db.session.update.mockResolvedValue({});
        db.machine.update.mockResolvedValue({});

        await cache.isSessionValid('session-1', 'user-1');
        await cache.isMachineValid('machine-1', 'user-1');

        const sessionTimestamp = Date.parse('2024-01-01T00:00:31.000Z');
        const machineTimestamp = Date.parse('2024-01-01T00:00:45.000Z');
        expect(cache.queueSessionUpdate('session-1', sessionTimestamp)).toBe(true);
        expect(cache.queueMachineUpdate('machine-1', machineTimestamp)).toBe(true);

        await (cache as any).flushPendingUpdates();

        expect(db.session.update).toHaveBeenCalledWith({
            where: { id: 'session-1' },
            data: {
                lastActiveAt: new Date(sessionTimestamp),
                active: true,
            },
        });
        expect(db.machine.update).toHaveBeenCalledWith({
            where: {
                accountId_id: {
                    accountId: 'user-1',
                    id: 'machine-1',
                },
            },
            data: {
                lastActiveAt: new Date(machineTimestamp),
            },
        });
        expect((cache as any).sessionCache.get('session-1')).toMatchObject({
            lastUpdateSent: sessionTimestamp,
            pendingUpdate: null,
        });
        expect((cache as any).machineCache.get('machine-1')).toMatchObject({
            lastUpdateSent: machineTimestamp,
            pendingUpdate: null,
        });

        await shutdownContext(context);
    });

    it('cleanup removes expired session and machine cache entries', async () => {
        const context = await createTestContext();
        const { cache, db } = context;
        const baseTime = new Date('2024-01-01T00:00:00.000Z');

        db.session.findUnique.mockResolvedValue({ lastActiveAt: baseTime } satisfies SessionRecord);
        db.machine.findUnique.mockResolvedValue({ lastActiveAt: baseTime } satisfies MachineRecord);

        await cache.isSessionValid('session-1', 'user-1');
        await cache.isMachineValid('machine-1', 'user-1');

        expect((cache as any).sessionCache.size).toBe(1);
        expect((cache as any).machineCache.size).toBe(1);

        vi.setSystemTime(new Date('2024-01-01T00:00:30.001Z'));
        cache.cleanup();

        expect((cache as any).sessionCache.size).toBe(0);
        expect((cache as any).machineCache.size).toBe(0);
        expect(cache.queueSessionUpdate('session-1', Date.parse('2024-01-01T00:00:40.000Z'))).toBe(false);
        expect(cache.queueMachineUpdate('machine-1', Date.parse('2024-01-01T00:00:40.000Z'))).toBe(false);

        await shutdownContext(context);
    });

    it('shutdown clears timers and flushes any remaining queued updates', async () => {
        const context = await createTestContext();
        const { cache, db } = context;
        const baseTime = new Date('2024-01-01T00:00:00.000Z');

        db.session.findUnique.mockResolvedValue({ lastActiveAt: baseTime } satisfies SessionRecord);
        db.session.update.mockResolvedValue({});
        await cache.isSessionValid('session-1', 'user-1');

        const timestamp = Date.parse('2024-01-01T00:00:31.000Z');
        expect(cache.queueSessionUpdate('session-1', timestamp)).toBe(true);

        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

        cache.shutdown();
        await flushMicrotasks();

        expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
        expect((cache as any).batchTimer).toBeNull();
        expect((cache as any).cleanupTimer).toBeNull();
        expect(db.session.update).toHaveBeenCalledWith({
            where: { id: 'session-1' },
            data: {
                lastActiveAt: new Date(timestamp),
                active: true,
            },
        });
    });
});
