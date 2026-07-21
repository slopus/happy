import { describe, expect, it } from 'vitest';
import {
    clampContextSize,
    getContextUsageLevel,
    getContextUsagePercentage,
    resolveContextMaxValue,
    resolveStatusBarGitBranch,
    SESSION_STATUS_CONTEXT_MAX,
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

    it('sizes the context window from the API value, then the model key', () => {
        // Explicit API-reported window always wins.
        expect(resolveContextMaxValue(500000, 'claude-opus-4-8[1m]')).toBe(500000);
        expect(resolveContextMaxValue(210000, 'claude-opus-4-8')).toBe(210000);
        // No API window: size from the selected model. A 1M model must NOT
        // clamp to the 190K default (regression #910 via SessionStatusBar).
        expect(resolveContextMaxValue(undefined, 'claude-opus-4-8[1m]')).toBe(1_000_000);
        expect(resolveContextMaxValue(0, 'claude-opus-4-8[1m]')).toBe(1_000_000);
        // Opus 4.8 always runs the 1M window on the Anthropic API, even without
        // the [1m] suffix — the gauge must not clamp it to 190K.
        expect(resolveContextMaxValue(null, 'claude-opus-4-8')).toBe(1_000_000);
        // Unknown model + no API window stays conservative at the 190K default.
        expect(resolveContextMaxValue(undefined, undefined)).toBe(SESSION_STATUS_CONTEXT_MAX);
    });

    it('falls back to metadata git branch when git status has no branch', () => {
        expect(resolveStatusBarGitBranch('main', 'metadata-main')).toBe('main');
        expect(resolveStatusBarGitBranch(null, 'fix/session')).toBe('fix/session');
        expect(resolveStatusBarGitBranch('', 'fix/session')).toBe('fix/session');
        expect(resolveStatusBarGitBranch('   ', 'fix/session')).toBe('fix/session');
        expect(resolveStatusBarGitBranch(null, null)).toBe(null);
    });
});
