import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, eventLoopHistogram, gcObserver, initialUtilization, utilization } = vi.hoisted(() => {
    const dbMock = {
        account: { count: vi.fn() },
        session: { count: vi.fn() },
        sessionMessage: { count: vi.fn() },
        machine: { count: vi.fn() },
        $queryRaw: vi.fn()
    };

    const eventLoopHistogram = { enable: vi.fn(), percentile: vi.fn(() => 20_000_000), max: 0, reset: vi.fn() };
    const gcObserver = { observe: vi.fn(), callback: undefined as ((list: { getEntries: () => { duration: number }[] }) => void) | undefined };
    const initialUtilization = { idle: 0, active: 0, utilization: 0 };
    const utilization = vi.fn(() => initialUtilization);
    return { dbMock, eventLoopHistogram, gcObserver, initialUtilization, utilization };
});

vi.mock('node:perf_hooks', () => ({
    monitorEventLoopDelay: () => eventLoopHistogram,
    performance: { eventLoopUtilization: utilization },
    PerformanceObserver: class {
        constructor(callback: typeof gcObserver.callback) { gcObserver.callback = callback; }
        observe = gcObserver.observe;
    }
}));

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

import { register, updateDatabaseMetrics } from "./metrics2";
const gcObservationOptions = gcObserver.observe.mock.calls[0];

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
    beforeEach(() => {
        utilization.mockReset().mockReturnValue(initialUtilization);
        eventLoopHistogram.max = 0;
        eventLoopHistogram.percentile.mockReset().mockReturnValue(20_000_000);
        eventLoopHistogram.reset.mockReset();
    });

    it('reports utilization for each scrape interval rather than the process lifetime', async () => {
        await register.metrics(); // Prime the baseline independently of test order.
        const firstSnapshot = { idle: 100, active: 400, utilization: 0.8 };
        const secondSnapshot = { idle: 900, active: 600, utilization: 0.4 };
        utilization.mockClear();
        utilization.mockReturnValueOnce(firstSnapshot).mockReturnValueOnce({ idle: 100, active: 400, utilization: 0.8 });
        const first = await register.getMetricsAsJSON();
        expect(first.find(metric => metric.name === 'event_loop_utilization_ratio')?.values[0].value).toBe(0.8);
        expect(utilization).toHaveBeenCalledWith(firstSnapshot, initialUtilization);
        utilization.mockReturnValueOnce(secondSnapshot).mockReturnValueOnce({ idle: 800, active: 200, utilization: 0.2 });
        const second = await register.getMetricsAsJSON();
        expect(second.find(metric => metric.name === 'event_loop_utilization_ratio')?.values[0].value).toBe(0.2);
        expect(utilization).toHaveBeenCalledWith(secondSnapshot, firstSnapshot);
    });

    it('exports zero rather than NaN when an ELU interval has no elapsed activity', async () => {
        utilization.mockReturnValueOnce(initialUtilization).mockReturnValueOnce({ idle: 0, active: 0, utilization: NaN });
        const metrics = await register.getMetricsAsJSON();
        expect(metrics.find(metric => metric.name === 'event_loop_utilization_ratio')?.values[0].value).toBe(0);
    });

    it('exposes the largest reported GC pause once then resets for the next scrape', async () => {
        expect(gcObserver.callback).toBeTypeOf('function');
        expect(gcObservationOptions).toEqual([{ entryTypes: ['gc'] }]);
        gcObserver.callback!({ getEntries: () => [{ duration: 25 }, { duration: 3_200 }, { duration: 10 }] });
        const first = await register.metrics();
        expect(first).toContain('gc_pause_max_seconds{app="happy-server"} 3.2\n');
        const second = await register.getMetricsAsJSON();
        expect(second.find(metric => metric.name === 'gc_pause_max_seconds')?.values[0].value).toBe(0);
    });

    it('ignores invalid GC durations without losing the last finite pause', async () => {
        expect(gcObserver.callback).toBeTypeOf('function');
        gcObserver.callback!({ getEntries: () => [{ duration: 400 }, { duration: NaN }, { duration: Infinity }, { duration: -10 }] });
        const metrics = await register.getMetricsAsJSON();
        expect(metrics.find(metric => metric.name === 'gc_pause_max_seconds')?.values[0].value).toBe(0.4);
    });

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
        expect(nextPrometheus).toContain('event_loop_lag_seconds{app="happy-server"} 0\n');
        expect(nextPrometheus).toContain('event_loop_lag_max_seconds{app="happy-server"} 0\n');
        expect(eventLoopHistogram.reset).toHaveBeenCalledTimes(4);
    });

    it("is registered for prometheus scraping", async () => {
        const metrics = await register.metrics();

        expect(metrics).toContain("event_loop_lag_seconds");
    });
});
