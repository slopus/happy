import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
    dbMock: {
        session: {
            findUnique: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
        machine: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
    },
}));

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/monitoring/metrics2", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

describe("ActivityCache session archive handling", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-08T00:00:00.000Z"));
        dbMock.session.findUnique.mockReset();
        dbMock.session.update.mockReset();
        dbMock.session.updateMany.mockReset();
        dbMock.machine.findUnique.mockReset();
        dbMock.machine.update.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not validate archived sessions for presence updates", async () => {
        dbMock.session.findUnique.mockResolvedValue({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(Date.now() - 60_000),
            archivedAt: new Date(Date.now() - 1_000),
        });

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(false);
        expect(activityCache.queueSessionUpdate("session-1", Date.now())).toBe(false);
    });

    it("flushes stale pending heartbeats only for non-archived sessions", async () => {
        dbMock.session.findUnique.mockResolvedValue({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(Date.now() - 60_000),
            archivedAt: null,
        });
        dbMock.session.updateMany.mockResolvedValue({ count: 1 });

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);
        expect(activityCache.queueSessionUpdate("session-1", Date.now())).toBe(true);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(dbMock.session.updateMany).toHaveBeenCalledWith({
            where: { id: "session-1", archivedAt: null },
            data: { lastActiveAt: new Date("2026-06-08T00:00:00.000Z"), active: true },
        });
        expect(dbMock.session.update).not.toHaveBeenCalled();
    });

    it("can invalidate a cached session after archive state changes", async () => {
        dbMock.session.findUnique
            .mockResolvedValueOnce({
                id: "session-1",
                accountId: "user-1",
                lastActiveAt: new Date(Date.now() - 60_000),
                archivedAt: null,
            })
            .mockResolvedValueOnce({
                id: "session-1",
                accountId: "user-1",
                lastActiveAt: new Date(Date.now() - 60_000),
                archivedAt: new Date(Date.now() - 1_000),
            });

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);
        activityCache.invalidateSession("session-1");
        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(false);

        expect(dbMock.session.findUnique).toHaveBeenCalledTimes(2);
    });
});
