/**
 * Unit coverage for the 'auto' effort mapping: toSdkEffort() turns the
 * Happy-only 'auto' level into `undefined`, so the SDK `effort` option is left
 * out and Claude Code applies its own effort.
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
