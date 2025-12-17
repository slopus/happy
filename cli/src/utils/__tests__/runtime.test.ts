import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRuntime, isNode, isBun, isDeno } from '../runtime';

describe('Runtime Detection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('detects Node.js runtime correctly', () => {
        // Test actual runtime detection
        if (process.versions.node && !process.versions.bun && !process.versions.deno) {
            expect(getRuntime()).toBe('node');
            expect(isNode()).toBe(true);
            expect(isBun()).toBe(false);
            expect(isDeno()).toBe(false);
        }
    });

    it('detects Bun runtime correctly', () => {
        if (process.versions.bun) {
            expect(getRuntime()).toBe('bun');
            expect(isNode()).toBe(false);
            expect(isBun()).toBe(true);
            expect(isDeno()).toBe(false);
        }
    });

    it('detects Deno runtime correctly', () => {
        if (process.versions.deno) {
            expect(getRuntime()).toBe('deno');
            expect(isNode()).toBe(false);
            expect(isBun()).toBe(false);
            expect(isDeno()).toBe(true);
        }
    });

    it('returns valid runtime type', () => {
        const runtime = getRuntime();
        expect(['node', 'bun', 'deno', 'unknown']).toContain(runtime);
    });

    it('provides consistent predicate functions', () => {
        const runtime = getRuntime();

        // Only one should be true
        const trues = [isNode(), isBun(), isDeno()].filter(Boolean);
        expect(trues.length).toBeLessThanOrEqual(1);

        // If runtime is not unknown, exactly one should be true
        if (runtime !== 'unknown') {
            expect(trues.length).toBe(1);
        }
    });

    it('handles edge cases gracefully', () => {
        // Should not throw
        expect(() => getRuntime()).not.toThrow();

        // Should return string
        const runtime = getRuntime();
        expect(typeof runtime).toBe('string');
    });
});
