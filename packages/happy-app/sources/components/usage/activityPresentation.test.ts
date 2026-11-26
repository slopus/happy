import { describe, expect, it } from 'vitest';
import type { ActivityDay, ActivityMonth } from './codexActivityCalendar';
import { filterActivityMonths, getActivityMetrics } from './activityPresentation';

const day: ActivityDay = {
    date: '2026-11-26',
    inputTokens: 1_000,
    cachedInputTokens: 800,
    outputTokens: 200,
    reasoningOutputTokens: 150,
    totalTokens: 1_200,
    tokenCountEvents: 3,
    sessions: 1,
    totalOnlyTokens: 0,
};

describe('activity presentation metrics', () => {
    it('partitions usage into three disjoint categories without charging cache or reasoning twice', () => {
        const metrics = getActivityMetrics(day);
        expect(metrics).toEqual([
            { key: 'input', value: 200 },
            { key: 'cache', value: 800 },
            { key: 'output', value: 200 },
        ]);
        expect(metrics.reduce((total, metric) => total + metric.value, 0)).toBe(day.totalTokens);
        expect(day.inputTokens).toBe(1_000);
    });

    it('never renders negative uncached input if a source reports more cache than input', () => {
        const metrics = getActivityMetrics({ ...day, inputTokens: 700 });
        expect(metrics[0]).toEqual({ key: 'input', value: 0 });
        expect(metrics[1]).toEqual({ key: 'cache', value: 800 });
    });
});

describe('activity month labels', () => {
    it('keeps a full next month instead of spending its label space on a leading fragment', () => {
        const months: readonly ActivityMonth[] = Object.freeze([
            { key: '2025-11', date: '2025-11-30', weekIndex: 0 },
            { key: '2025-12', date: '2025-12-01', weekIndex: 0 },
            { key: '2026-01', date: '2026-01-01', weekIndex: 4 },
        ]);
        expect(filterActivityMonths(months)).toEqual([months[1], months[2]]);
        expect(months).toHaveLength(3);
    });

    it('uses the supplied cell pitch and allows labels exactly at the spacing threshold', () => {
        const months: ActivityMonth[] = [
            { key: '2026-10', date: '2026-10-01', weekIndex: 0 },
            { key: '2026-11', date: '2026-11-01', weekIndex: 3 },
        ];
        expect(filterActivityMonths(months, 8)).toEqual([months[1]]);
        expect(filterActivityMonths(months, 16, 48)).toEqual(months);
        expect(filterActivityMonths(months, 16, 49)).toEqual([months[1]]);
    });

    it('retains the final visible month even when it is the only label', () => {
        const month: ActivityMonth = { key: '2026-11', date: '2026-11-26', weekIndex: 0 };
        expect(filterActivityMonths([])).toEqual([]);
        expect(filterActivityMonths([month])).toEqual([month]);
    });
});
