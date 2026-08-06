import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
    dbMock,
    counterIncMock,
    resetMocks,
} = vi.hoisted(() => {
    const dbMock = {
        session: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        machine: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
    };
    const counterIncMock = vi.fn();
    const resetMocks = () => {
        dbMock.session.findUnique.mockReset();
        dbMock.session.update.mockReset();
        dbMock.machine.findUnique.mockReset();
        dbMock.machine.update.mockReset();
        counterIncMock.mockReset();
    };
    return { dbMock, counterIncMock, resetMocks };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/monitoring/metrics2", () => ({
    sessionCacheCounter: { inc: counterIncMock },
    databaseUpdatesSkippedCounter: { inc: counterIncMock },
}));

describe("ActivityCache machine heartbeats", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        resetMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("persists active=true for a fresh inactive machine heartbeat", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        dbMock.machine.findUnique.mockResolvedValue({
            id: "machine-1",
            accountId: "user-1",
            active: false,
            lastActiveAt: new Date(now),
        });
        dbMock.machine.update.mockResolvedValue({});

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isMachineValid("machine-1", "user-1")).resolves.toBe(true);
        expect(activityCache.queueMachineUpdate("machine-1", now + 1000)).toBe(true);

        await vi.advanceTimersByTimeAsync(5000);

        expect(dbMock.machine.update).toHaveBeenCalledWith({
            where: {
                accountId_id: {
                    accountId: "user-1",
                    id: "machine-1",
                },
            },
            data: {
                lastActiveAt: new Date(now + 1000),
                active: true,
            },
        });

        activityCache.shutdown();
    });

    it("discards a queued session heartbeat when the session is stopped", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        dbMock.session.findUnique.mockResolvedValue({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(now - 60_000),
        });

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);
        expect(activityCache.queueSessionUpdate("session-1", now)).toBe(true);
        activityCache.clearSessionUpdates("session-1");

        await vi.advanceTimersByTimeAsync(5000);

        expect(dbMock.session.update).not.toHaveBeenCalled();
        activityCache.shutdown();
    });

    it("ignores a heartbeat that arrives while the stopping write is still in flight", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        // Session row is still active - the stop has not been committed yet
        dbMock.session.findUnique.mockResolvedValue({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(now - 60_000),
        });

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);

        // Stop route clears the cache, then awaits its database write
        activityCache.clearSessionUpdates("session-1");

        // Heartbeat lands in that window and would otherwise repopulate the cache
        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(false);
        expect(activityCache.queueSessionUpdate("session-1", now)).toBe(false);

        await vi.advanceTimersByTimeAsync(5000);

        expect(dbMock.session.update).not.toHaveBeenCalled();
        activityCache.shutdown();
    });

    it("does not revive a session that was deleted while a heartbeat was reading the database", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        let resolveFindUnique: (session: unknown) => void = () => { };
        dbMock.session.findUnique.mockReturnValue(new Promise((resolve) => {
            resolveFindUnique = resolve;
        }));

        const { activityCache } = await import("./sessionCache");

        const heartbeat = activityCache.isSessionValid("session-1", "user-1");

        // Session is deleted while the validation query is still in flight
        activityCache.clearSessionUpdates("session-1");
        resolveFindUnique({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(now - 60_000),
        });

        await expect(heartbeat).resolves.toBe(false);
        expect(activityCache.queueSessionUpdate("session-1", now)).toBe(false);

        await vi.advanceTimersByTimeAsync(5000);

        // Updating a deleted row would throw P2025 and fail the whole batch
        expect(dbMock.session.update).not.toHaveBeenCalled();
        activityCache.shutdown();
    });

    it("marks a restarted session active again", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        dbMock.session.findUnique.mockResolvedValue({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(now - 60_000),
        });
        dbMock.session.update.mockResolvedValue({});

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);
        activityCache.clearSessionUpdates("session-1");
        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(false);

        // Session comes back through POST /v1/sessions
        activityCache.resumeSessionUpdates("session-1");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);
        expect(activityCache.queueSessionUpdate("session-1", now)).toBe(true);

        await vi.advanceTimersByTimeAsync(5000);

        expect(dbMock.session.update).toHaveBeenCalledWith({
            where: { id: "session-1" },
            data: {
                lastActiveAt: new Date(now),
                active: true,
            },
        });

        activityCache.shutdown();
    });

    it("stops ignoring heartbeats once the stop window expires", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        dbMock.session.findUnique.mockResolvedValue({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(now - 60_000),
        });

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);
        activityCache.clearSessionUpdates("session-1");
        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(false);

        await vi.advanceTimersByTimeAsync(60_000);

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);
        activityCache.shutdown();
    });
});
