import { describe, expect, it } from 'vitest';
import {
    clampContextSize,
    formatUsageLimitAge,
    getContextUsageLevel,
    getContextUsagePercentage,
    getUsageLimitChips,
    getUsageLimitDisplayPercentage,
    getUsageLimitRows,
    getUsageLimitStatus,
    resolveStatusBarGitBranch,
} from './sessionStatusBar';

describe('session status bar helpers', () => {
    it('clamps context values to the valid range', () => {
        expect(clampContextSize(-10, 100)).toBe(0);
        expect(clampContextSize(50, 100)).toBe(50);
        expect(clampContextSize(120, 100)).toBe(100);
        expect(clampContextSize(Number.NaN, 100)).toBe(0);
    });

    it('calculates context percentages and levels', () => {
        expect(getContextUsagePercentage(45, 100)).toBe(45);
        expect(getContextUsageLevel(89, 100)).toBe('normal');
        expect(getContextUsageLevel(90, 100)).toBe('warning');
        expect(getContextUsageLevel(95, 100)).toBe('critical');
    });

    it('reports nothing when the window is not a usable size', () => {
        // Callers must supply the session's real window; there is no default to
        // fall back on, so an unusable one yields a neutral reading rather than
        // a percentage computed against a guess.
        expect(getContextUsagePercentage(45, 0)).toBe(0);
        expect(getContextUsagePercentage(45, -1)).toBe(0);
        expect(getContextUsagePercentage(45, Number.NaN)).toBe(0);
        expect(getContextUsageLevel(45, 0)).toBe('normal');
        expect(clampContextSize(45, 0)).toBe(0);
    });

    it('falls back to metadata git branch when git status has no branch', () => {
        expect(resolveStatusBarGitBranch('main', 'metadata-main')).toBe('main');
        expect(resolveStatusBarGitBranch(null, 'fix/session')).toBe('fix/session');
        expect(resolveStatusBarGitBranch('', 'fix/session')).toBe('fix/session');
        expect(resolveStatusBarGitBranch('   ', 'fix/session')).toBe('fix/session');
        expect(resolveStatusBarGitBranch(null, null)).toBe(null);
    });
});


describe('usage limit helpers', () => {
    const limits = {
        capturedAt: 1000,
        windows: [
            { id: 'five_hour', status: 'allowed', utilization: 42, resetsAt: 1 },
            { id: 'seven_day', status: 'allowed_warning', utilization: 91, resetsAt: 2 },
            { id: 'seven_day_opus', utilization: 10, resetsAt: null },
        ],
    };

    it('builds dual chips from the well-known windows only', () => {
        const chips = getUsageLimitChips(limits, false);
        expect(chips.map(c => c.id)).toEqual(['five_hour', 'seven_day']);
        expect(chips[0].shortLabel).toBe('5h');
        expect(chips[1].status).toBe('allowed_warning');
    });

    it('collapses to the window closest to its limit when narrow', () => {
        const chips = getUsageLimitChips(limits, true);
        expect(chips).toHaveLength(1);
        expect(chips[0].id).toBe('seven_day');
    });

    it('hides chips for windows without numeric utilization and for absent data', () => {
        expect(getUsageLimitChips({ capturedAt: 1, windows: [{ id: 'five_hour', utilization: null }] }, false)).toEqual([]);
        expect(getUsageLimitChips(undefined, false)).toEqual([]);
        expect(getUsageLimitChips({ capturedAt: 1, windows: 'garbage' as any }, false)).toEqual([]);
    });

    it('shows a critical fallback chip for an id-less rejected event', () => {
        expect(getUsageLimitChips({
            capturedAt: 1,
            windows: [
                { id: 'future_window', status: 'allowed_warning', utilization: 95 },
                { id: 'plan', status: 'rejected', utilization: null },
            ],
        }, false)).toEqual([{
            id: 'plan',
            shortLabel: 'Plan',
            utilization: 100,
            status: 'rejected',
        }]);
    });

    it('lists all windows in the popover rows, well-known ids first', () => {
        const rows = getUsageLimitRows({
            capturedAt: 1,
            windows: [
                { id: 'seven_day_opus', utilization: 10, resetsAt: null },
                { id: 'five_hour', utilization: 42, resetsAt: 5 },
            ],
        });
        expect(rows.map(r => r.id)).toEqual(['five_hour', 'seven_day_opus']);
        expect(rows[1].label).toBe('seven day opus');
    });

    it('trusts known status values and falls back to utilization thresholds otherwise', () => {
        expect(getUsageLimitStatus({ id: 'x', status: 'rejected', utilization: 10 })).toBe('rejected');
        expect(getUsageLimitStatus({ id: 'x', status: 'future_status', utilization: 95 })).toBe('allowed_warning');
        expect(getUsageLimitStatus({ id: 'x', utilization: 100 })).toBe('rejected');
        expect(getUsageLimitStatus({ id: 'x' })).toBe('allowed');
    });

    it('flips utilization for the remaining view without touching status', () => {
        expect(getUsageLimitDisplayPercentage(42, false)).toBe(42);
        expect(getUsageLimitDisplayPercentage(42, true)).toBe(58);
        expect(getUsageLimitDisplayPercentage(100, true)).toBe(0);
        // The collapsed chip still picks the window closest to its limit,
        // which is the one with the least remaining.
        expect(getUsageLimitChips(limits, true)[0].id).toBe('seven_day');
    });

    it('formats snapshot age compactly', () => {
        expect(formatUsageLimitAge(0, 30_000)).toBe('<1m');
        expect(formatUsageLimitAge(0, 3 * 60_000)).toBe('3m');
        expect(formatUsageLimitAge(0, 2 * 3600_000)).toBe('2h');
        expect(formatUsageLimitAge(0, 3 * 86400_000)).toBe('3d');
    });
});
