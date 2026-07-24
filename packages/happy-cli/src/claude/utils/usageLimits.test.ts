import { describe, it, expect } from 'vitest';
import { fromRateLimitEvent, mergeUsageLimits, synthesizeStatus, windowsFromGetUsage } from './usageLimits';

describe('windowsFromGetUsage', () => {
    it('normalizes ISO resets_at to epoch ms and keeps 0-100 utilization as-is', () => {
        const windows = windowsFromGetUsage({
            five_hour: { utilization: 42, resets_at: '2026-07-17T20:00:00Z' },
            seven_day: { utilization: 91.5, resets_at: null },
        });
        expect(windows).toHaveLength(2);
        const fiveHour = windows.find(w => w.id === 'five_hour')!;
        expect(fiveHour.utilization).toBe(42);
        expect(fiveHour.resetsAt).toBe(Date.parse('2026-07-17T20:00:00Z'));
        expect(fiveHour.status).toBe('allowed');
        const sevenDay = windows.find(w => w.id === 'seven_day')!;
        expect(sevenDay.resetsAt).toBeNull();
        expect(sevenDay.status).toBe('allowed_warning');
    });

    it('carries unknown window ids through and explicitly excludes extra_usage', () => {
        const windows = windowsFromGetUsage({
            seven_day_opus: { utilization: 10, resets_at: null },
            seven_day_oauth_apps: null,
            // The real SDK shape can include utilization, so shape detection
            // alone is not enough to distinguish this billing entry.
            extra_usage: { utilization: 55, resets_at: '2026-07-17T20:00:00Z' },
        });
        expect(windows.map(w => w.id)).toEqual(['seven_day_opus']);
    });

    it('degrades non-numeric utilization to null without a status', () => {
        const windows = windowsFromGetUsage({ five_hour: { utilization: null, resets_at: null } });
        expect(windows[0].utilization).toBeNull();
        expect(windows[0].status).toBeUndefined();
    });
});

describe('fromRateLimitEvent', () => {
    it('converts fraction utilization and unix-seconds resetsAt', () => {
        const { window } = fromRateLimitEvent({
            status: 'allowed',
            rateLimitType: 'five_hour',
            utilization: 0.63,
            resetsAt: 1784736000, // seconds
        });
        expect(window).toEqual({
            id: 'five_hour',
            status: 'allowed',
            utilization: 63,
            resetsAt: 1784736000_000,
        });
    });

    it('passes already-ms resetsAt and percent utilization through the guards unchanged', () => {
        const { window } = fromRateLimitEvent({
            status: 'allowed_warning',
            rateLimitType: 'seven_day',
            utilization: 92,
            resetsAt: 1784736000000,
        });
        expect(window!.utilization).toBe(92);
        expect(window!.resetsAt).toBe(1784736000000);
    });

    it('returns an unbound patch when rateLimitType is absent (including rejected)', () => {
        const { window, unbound } = fromRateLimitEvent({ status: 'rejected', utilization: 1 });
        expect(window).toBeUndefined();
        expect(unbound).toEqual({ status: 'rejected', utilization: 100, resetsAt: null });
    });
});

describe('mergeUsageLimits', () => {
    const base = {
        capturedAt: 1000,
        windows: [
            { id: 'five_hour', status: 'allowed' as const, utilization: 40, resetsAt: 1 },
            { id: 'seven_day', status: 'allowed' as const, utilization: 70, resetsAt: 2 },
        ],
    };

    it('upserts by id and preserves untouched windows (re-hydration across re-entries)', () => {
        const merged = mergeUsageLimits(base, {
            capturedAt: 2000,
            windows: [{ id: 'five_hour', status: 'allowed_warning', utilization: 93, resetsAt: 3 }],
        });
        expect(merged.capturedAt).toBe(2000);
        expect(merged.windows).toHaveLength(2);
        expect(merged.windows.find(w => w.id === 'five_hour')!.utilization).toBe(93);
        expect(merged.windows.find(w => w.id === 'seven_day')!.utilization).toBe(70);
    });

    it('keeps the last known utilization when an event window arrives without one', () => {
        // Allowed rate_limit_events report only status + resetsAt; a full
        // replace here would strip the percentage seeded by get_usage.
        const merged = mergeUsageLimits(base, {
            capturedAt: 2000,
            windows: [{ id: 'five_hour', status: 'allowed', utilization: null, resetsAt: 5 }],
        });
        const fiveHour = merged.windows.find(w => w.id === 'five_hour')!;
        expect(fiveHour.utilization).toBe(40);
        expect(fiveHour.resetsAt).toBe(5);
        expect(fiveHour.status).toBe('allowed');
    });

    it('keeps the last known resetsAt when an event window arrives without one', () => {
        const merged = mergeUsageLimits(base, {
            capturedAt: 2000,
            windows: [{ id: 'seven_day', status: 'allowed_warning', utilization: 91, resetsAt: null }],
        });
        const sevenDay = merged.windows.find(w => w.id === 'seven_day')!;
        expect(sevenDay.utilization).toBe(91);
        expect(sevenDay.resetsAt).toBe(2);
        expect(sevenDay.status).toBe('allowed_warning');
    });

    it('applies an unbound event to the max-utilization window', () => {
        const merged = mergeUsageLimits(base, {
            capturedAt: 2000,
            windows: [],
            unbound: { status: 'rejected', utilization: null, resetsAt: null },
        });
        expect(merged.windows.find(w => w.id === 'seven_day')!.status).toBe('rejected');
        expect(merged.windows.find(w => w.id === 'seven_day')!.utilization).toBe(70);
        expect(merged.windows.find(w => w.id === 'five_hour')!.status).toBe('allowed');
    });

    it('creates a synthetic window for an unbound event when no windows exist yet', () => {
        const merged = mergeUsageLimits(undefined, {
            capturedAt: 2000,
            windows: [],
            unbound: { status: 'rejected', utilization: 100, resetsAt: null },
        });
        expect(merged.windows).toEqual([{ id: 'plan', status: 'rejected', utilization: 100, resetsAt: null }]);
    });

    it('tolerates malformed current agent state (windows not an array)', () => {
        const merged = mergeUsageLimits({ capturedAt: 1, windows: 'garbage' as any }, {
            capturedAt: 2000,
            windows: [{ id: 'five_hour', utilization: 10, resetsAt: null }],
        });
        expect(merged.windows).toHaveLength(1);
    });
});

describe('synthesizeStatus', () => {
    it('maps thresholds', () => {
        expect(synthesizeStatus(89.9)).toBe('allowed');
        expect(synthesizeStatus(90)).toBe('allowed_warning');
        expect(synthesizeStatus(100)).toBe('rejected');
        expect(synthesizeStatus(null)).toBeUndefined();
    });
});

describe('mergeUsageLimits review fixes', () => {
    it('replace:true drops windows the snapshot no longer reports', () => {
        const merged = mergeUsageLimits(
            {
                capturedAt: 1,
                windows: [
                    { id: 'five_hour', utilization: 40, resetsAt: 1 },
                    { id: 'plan', status: 'rejected', utilization: null, resetsAt: null },
                ],
            },
            {
                capturedAt: 2000,
                windows: [{ id: 'five_hour', status: 'allowed', utilization: 41, resetsAt: 2 }],
                replace: true,
            },
        );
        expect(merged.windows.map(w => w.id)).toEqual(['five_hour']);
    });

    it('repeated unbound events without numeric windows upsert one plan window, not duplicates', () => {
        const first = mergeUsageLimits(undefined, {
            capturedAt: 1,
            windows: [],
            unbound: { status: 'rejected', utilization: null, resetsAt: null },
        });
        const second = mergeUsageLimits(first, {
            capturedAt: 2,
            windows: [],
            unbound: { status: 'allowed_warning', utilization: null, resetsAt: null },
        });
        expect(second.windows.filter(w => w.id === 'plan')).toHaveLength(1);
        expect(second.windows[0].status).toBe('allowed_warning');
    });
});
