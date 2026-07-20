import { describe, it, expect } from 'vitest';
import { classifyLaunchError, ERR_RESULT_PREFIX } from './claudeRemoteLauncher';

// ---------------------------------------------------------------------------
// Unit tests for classifyLaunchError (pure function, no mocks needed)
// ---------------------------------------------------------------------------
// The function classifies the value caught in claudeRemoteLauncher's inner
// try/catch and returns the message string to be sent to the app via
// sendSessionEvent.  Because it is a pure function the entire test suite runs
// without mocking any module.
// ---------------------------------------------------------------------------

describe('classifyLaunchError', () => {
    // -----------------------------------------------------------------------
    // T1 — SDK error result (Error with prefix) → strip prefix, return real text
    // -----------------------------------------------------------------------
    it('T1: SDK error result with prefix → returns SDK error text (no prefix)', () => {
        const sdkText = "You've hit your limit. Try again at 10:00";
        const e = new Error(ERR_RESULT_PREFIX + sdkText);

        const result = classifyLaunchError(e);

        expect(result).toBe(sdkText);
        expect(result).not.toContain(ERR_RESULT_PREFIX);
        expect(result).not.toBe('Process exited unexpectedly');
    });

    // -----------------------------------------------------------------------
    // T2 — True crash: Error without prefix → crash message
    // -----------------------------------------------------------------------
    it('T2: Error without prefix → "Process exited unexpectedly"', () => {
        const e = new Error('boom');
        expect(classifyLaunchError(e)).toBe('Process exited unexpectedly');
    });

    // -----------------------------------------------------------------------
    // T3 — Non-Error throw: raw string → safe fallback crash message
    // -----------------------------------------------------------------------
    it('T3: thrown string → "Process exited unexpectedly" (safe fallback)', () => {
        expect(classifyLaunchError('raw string error')).toBe('Process exited unexpectedly');
    });

    // -----------------------------------------------------------------------
    // T4 — Non-Error throw: undefined → safe fallback
    // -----------------------------------------------------------------------
    it('T4: thrown undefined → "Process exited unexpectedly"', () => {
        expect(classifyLaunchError(undefined)).toBe('Process exited unexpectedly');
    });

    // -----------------------------------------------------------------------
    // T5 — Non-Error throw: object → safe fallback
    // -----------------------------------------------------------------------
    it('T5: thrown plain object → "Process exited unexpectedly"', () => {
        expect(classifyLaunchError({ code: 42 })).toBe('Process exited unexpectedly');
    });

    // -----------------------------------------------------------------------
    // T6 — Prefix contract pin (SDK upgrade regression probe)
    // If the SDK changes its internal error prefix this test turns CI red,
    // giving immediate warning before silent misclassification happens.
    // -----------------------------------------------------------------------
    it('T6: ERR_RESULT_PREFIX is exactly the expected literal (SDK contract pin)', () => {
        expect(ERR_RESULT_PREFIX).toBe('Claude Code returned an error result: ');
    });

    // -----------------------------------------------------------------------
    // T7 — Slice boundary: prefix present but no text after it → empty string
    // -----------------------------------------------------------------------
    it('T7: Error message is exactly the prefix → returns empty string (not crash message)', () => {
        const e = new Error(ERR_RESULT_PREFIX);
        const result = classifyLaunchError(e);
        expect(result).toBe('');
    });

    // -----------------------------------------------------------------------
    // T8 — Empty message (empty string) → crash message (no prefix match)
    // -----------------------------------------------------------------------
    it('T8: Error with empty message → "Process exited unexpectedly"', () => {
        const e = new Error('');
        expect(classifyLaunchError(e)).toBe('Process exited unexpectedly');
    });

    // -----------------------------------------------------------------------
    // T9 — SDK error result with tool failure text variant
    // -----------------------------------------------------------------------
    it('T9: SDK tool-failure error result → returns joined errors text', () => {
        const sdkText = 'tool failed: permission denied; tool failed: file not found';
        const e = new Error(ERR_RESULT_PREFIX + sdkText);

        const result = classifyLaunchError(e);

        expect(result).toBe(sdkText);
        expect(result).not.toContain(ERR_RESULT_PREFIX);
    });

    // -----------------------------------------------------------------------
    // T10 — null throw → safe fallback
    // -----------------------------------------------------------------------
    it('T10: thrown null → "Process exited unexpectedly"', () => {
        expect(classifyLaunchError(null)).toBe('Process exited unexpectedly');
    });
});
