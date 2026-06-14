/**
 * Unit coverage for the 'auto' effort mapping:
 *   toSdkEffort() collapses the Happy-only 'auto' level to `undefined`, so the
 *   SDK `effort` option is omitted and the model self-paces via adaptive
 *   thinking (Claude decides how much to think per turn).
 */
import { describe, it, expect } from 'vitest';
import { toSdkEffort } from './loop';

describe('toSdkEffort', () => {
    it("maps 'auto' to undefined (omit the SDK effort option)", () => {
        expect(toSdkEffort('auto')).toBeUndefined();
    });

    it('passes every real SDK effort through unchanged', () => {
        for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
            expect(toSdkEffort(e)).toBe(e);
        }
    });

    it('passes undefined through (SDK default)', () => {
        expect(toSdkEffort(undefined)).toBeUndefined();
    });
});
