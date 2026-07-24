import { describe, expect, it } from 'vitest';
import {
    clampContextSize,
    getContextUsageLevel,
    getContextUsagePercentage,
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
