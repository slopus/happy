import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// specs/session-list-keepalive-bump — regression test for the bug where
// keepalive flushes were calling `db.session.update`, which triggered
// Prisma's `@updatedAt` decorator and bumped `Session.updatedAt` on every
// flush. The fix replaces that path with `db.$executeRaw` so only the
// intended `lastActiveAt` + `active` columns are touched.

let sessionUpdateMock: any;
let machineUpdateMock: any;
let executeRawMock: any;
let executeRawCalls: Array<{ strings: TemplateStringsArray; values: any[] }>;

vi.mock("@/storage/db", () => ({
    db: {
        get session() {
            return { update: sessionUpdateMock };
        },
        get machine() {
            return { update: machineUpdateMock };
        },
        $executeRaw: (strings: TemplateStringsArray, ...values: any[]) => {
            executeRawCalls.push({ strings, values });
            return Promise.resolve(1);
        },
    },
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn(),
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

// Import after mocks are wired so the module-load-time `setInterval` and
// `new ActivityCache()` see the mocked db.
import { activityCache } from "./sessionCache";

function primeCacheEntry(sessionId: string, userId: string, validUntilOffset = 60_000) {
    // Reach into the private map via cast — the public surface only exposes
    // queue/flush, but tests need to seed an entry without hitting the DB.
    const cache = (activityCache as any).sessionCache as Map<string, any>;
    cache.set(sessionId, {
        validUntil: Date.now() + validUntilOffset,
        lastUpdateSent: 0,
        pendingUpdate: null,
        userId,
    });
}

function primeMachineCacheEntry(machineId: string, userId: string, validUntilOffset = 60_000) {
    const cache = (activityCache as any).machineCache as Map<string, any>;
    cache.set(machineId, {
        validUntil: Date.now() + validUntilOffset,
        lastUpdateSent: 0,
        pendingUpdate: null,
        userId,
    });
}

async function flushNow(): Promise<void> {
    await (activityCache as any).flushPendingUpdates();
}

beforeEach(() => {
    sessionUpdateMock = vi.fn();
    machineUpdateMock = vi.fn();
    executeRawCalls = [];
    // Clear any leftover state between tests.
    const sCache = (activityCache as any).sessionCache as Map<string, any>;
    sCache.clear();
    const mCache = (activityCache as any).machineCache as Map<string, any>;
    mCache.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("sessionCache.flushPendingUpdates — keepalive must not bump Session.updatedAt", () => {
    it("queueSessionUpdate + flush uses $executeRaw (NOT db.session.update)", async () => {
        primeCacheEntry("sess-A", "user-1");
        const queued = activityCache.queueSessionUpdate("sess-A", Date.now());
        expect(queued).toBe(true);

        await flushNow();

        // Critical invariant: prisma's session.update must NOT be called.
        // That path triggers @updatedAt and is the source of the bug.
        expect(sessionUpdateMock).not.toHaveBeenCalled();
        expect(executeRawCalls.length).toBe(1);
    });

    it("raw SQL UPDATE only references lastActiveAt + active + id (NOT updatedAt)", async () => {
        primeCacheEntry("sess-B", "user-1");
        activityCache.queueSessionUpdate("sess-B", Date.now());
        await flushNow();

        expect(executeRawCalls.length).toBe(1);
        const sql = executeRawCalls[0].strings.join("?");
        // The keepalive UPDATE must touch only these columns. If a future
        // contributor adds "updatedAt" to the SET list, this test catches it.
        expect(sql).toMatch(/UPDATE\s+"Session"/);
        expect(sql).toMatch(/"lastActiveAt"/);
        expect(sql).toMatch(/"active"/);
        expect(sql).toMatch(/WHERE\s+"id"/);
        expect(sql).not.toMatch(/"updatedAt"/);
    });

    it("flushes multiple queued sessions in parallel via $executeRaw", async () => {
        primeCacheEntry("sess-X", "user-1");
        primeCacheEntry("sess-Y", "user-1");
        activityCache.queueSessionUpdate("sess-X", Date.now());
        activityCache.queueSessionUpdate("sess-Y", Date.now());

        await flushNow();

        expect(executeRawCalls.length).toBe(2);
        expect(sessionUpdateMock).not.toHaveBeenCalled();
    });

    it("session + machine flushed in same tick → both use $executeRaw", async () => {
        primeCacheEntry("sess-Z", "user-1");
        primeMachineCacheEntry("mach-Z", "user-1");
        activityCache.queueSessionUpdate("sess-Z", Date.now());
        activityCache.queueMachineUpdate("mach-Z", Date.now());
        await flushNow();
        // Both branches must now use raw SQL — symmetric semantics, neither
        // should call the Prisma model accessor that triggers @updatedAt.
        expect(executeRawCalls.length).toBe(2);
        expect(sessionUpdateMock).not.toHaveBeenCalled();
        expect(machineUpdateMock).not.toHaveBeenCalled();
    });
});

describe("sessionCache.flushPendingUpdates — Machine keepalive must not bump Machine.updatedAt", () => {
    it("queueMachineUpdate + flush uses $executeRaw (NOT db.machine.update)", async () => {
        primeMachineCacheEntry("mach-A", "user-1");
        const queued = activityCache.queueMachineUpdate("mach-A", Date.now());
        expect(queued).toBe(true);

        await flushNow();

        // Critical invariant: prisma's machine.update must NOT be called.
        // That path triggers @updatedAt and is the source of the symmetric
        // bug. See specs/machine-keepalive-bump.
        expect(machineUpdateMock).not.toHaveBeenCalled();
        expect(executeRawCalls.length).toBe(1);
    });

    it("raw SQL UPDATE only references lastActiveAt + accountId + id (NOT updatedAt)", async () => {
        primeMachineCacheEntry("mach-B", "user-1");
        activityCache.queueMachineUpdate("mach-B", Date.now());
        await flushNow();

        expect(executeRawCalls.length).toBe(1);
        const sql = executeRawCalls[0].strings.join("?");
        expect(sql).toMatch(/UPDATE\s+"Machine"/);
        expect(sql).toMatch(/"lastActiveAt"/);
        expect(sql).toMatch(/"accountId"/);
        expect(sql).toMatch(/"id"/);
        // Same regression guard as the session branch — adding "updatedAt"
        // to the SET list would defeat the whole fix.
        expect(sql).not.toMatch(/SET[^W]*"updatedAt"/);
        // active is NOT touched in the machine branch — keepalive flush
        // preserves the original behavior (only lastActiveAt is bumped here;
        // active toggling lives in presence/timeout.ts).
        expect(sql).not.toMatch(/SET[^W]*"active"/);
    });

    it("flushes multiple queued machines in parallel via $executeRaw", async () => {
        primeMachineCacheEntry("mach-X", "user-1");
        primeMachineCacheEntry("mach-Y", "user-2");
        activityCache.queueMachineUpdate("mach-X", Date.now());
        activityCache.queueMachineUpdate("mach-Y", Date.now());

        await flushNow();

        expect(executeRawCalls.length).toBe(2);
        expect(machineUpdateMock).not.toHaveBeenCalled();
    });
});
