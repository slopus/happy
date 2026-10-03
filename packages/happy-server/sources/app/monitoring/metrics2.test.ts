import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, eventLoopHistogram } = vi.hoisted(() => {
    const dbMock = {
        account: { count: vi.fn() },
        session: { count: vi.fn() },
        sessionMessage: { count: vi.fn() },
        machine: { count: vi.fn() },
        $queryRaw: vi.fn()
    };

    const eventLoopHistogram = { enable: vi.fn(), percentile: vi.fn(() => 20_000_000), max: 0, reset: vi.fn() };
    return { dbMock, eventLoopHistogram };
});

vi.mock('node:perf_hooks', () => ({ monitorEventLoopDelay: () => eventLoopHistogram }));

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

import { register, updateDatabaseMetrics } from "./metrics2";

describe("updateDatabaseMetrics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.account.count.mockResolvedValue(10);
        dbMock.session.count.mockResolvedValue(20);
        dbMock.sessionMessage.count.mockResolvedValue(30);
        dbMock.machine.count.mockResolvedValue(40);
        dbMock.$queryRaw.mockResolvedValue([{ estimated_count: 123n }]);
    });

    it("uses estimated counts instead of exact table counts", async () => {
        await updateDatabaseMetrics();

        expect(dbMock.account.count).not.toHaveBeenCalled();
        expect(dbMock.session.count).not.toHaveBeenCalled();
        expect(dbMock.sessionMessage.count).not.toHaveBeenCalled();
        expect(dbMock.machine.count).not.toHaveBeenCalled();
        expect(dbMock.$queryRaw).toHaveBeenCalledTimes(4);

        const queriedTables = dbMock.$queryRaw.mock.calls.map((call) => call[1]);
        expect(queriedTables).toEqual(['"Account"', '"Session"', '"SessionMessage"', '"Machine"']);
    });
});

describe("event loop lag metric", () => {
    it('exposes a rare three-second pause alongside the same window p99 and resets once per scrape', async () => {
        eventLoopHistogram.max = 3_000_000_000;
        eventLoopHistogram.percentile.mockReturnValue(20_000_000);
        eventLoopHistogram.percentile.mockClear();
        eventLoopHistogram.reset.mockClear();
        eventLoopHistogram.reset.mockImplementation(() => {
            eventLoopHistogram.max = 0;
            eventLoopHistogram.percentile.mockReturnValue(0);
        });
        const first = await register.getMetricsAsJSON();
        expect(eventLoopHistogram.percentile).toHaveBeenCalledWith(99);
        expect(first.find(metric => metric.name === 'event_loop_lag_seconds')?.values[0].value).toBe(0.02);
        expect(first.find(metric => metric.name === 'event_loop_lag_max_seconds')?.values[0].value).toBe(3);
        expect(eventLoopHistogram.reset).toHaveBeenCalledTimes(1);
        const next = await register.getMetricsAsJSON();
        expect(next.find(metric => metric.name === 'event_loop_lag_seconds')?.values[0].value).toBe(0);
        expect(next.find(metric => metric.name === 'event_loop_lag_max_seconds')?.values[0].value).toBe(0);
        expect(eventLoopHistogram.reset).toHaveBeenCalledTimes(2);
        eventLoopHistogram.max = 4_000_000_000;
        eventLoopHistogram.percentile.mockReturnValue(30_000_000);
        const prometheus = await register.metrics();
        expect(prometheus).toContain('event_loop_lag_seconds{app="happy-server"} 0.03');
        expect(prometheus).toContain('event_loop_lag_max_seconds{app="happy-server"} 4');
        expect(eventLoopHistogram.reset).toHaveBeenCalledTimes(3);
        const nextPrometheus = await register.metrics();
        expect(nextPrometheus).toContain('event_loop_lag_seconds{app="happy-server"} 0');
        expect(nextPrometheus).toContain('event_loop_lag_max_seconds{app="happy-server"} 0');
        expect(eventLoopHistogram.reset).toHaveBeenCalledTimes(4);
    });

    it("is registered for prometheus scraping", async () => {
        const metrics = await register.metrics();

        expect(metrics).toContain("event_loop_lag_seconds");
    });
});
