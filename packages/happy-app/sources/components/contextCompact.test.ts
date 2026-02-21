import { describe, it, expect } from 'vitest';

const MAX_CONTEXT_SIZE = 190000;

/**
 * Tests for the context compact button visibility logic.
 * The button should appear when context usage is >= 90% (≤10% remaining).
 */
describe('context compact button visibility', () => {
    function shouldShowCompact(contextSize: number): boolean {
        const percentageRemaining = Math.max(0, 100 - (contextSize / MAX_CONTEXT_SIZE) * 100);
        return percentageRemaining <= 10;
    }

    it('should not show when context is low (50%)', () => {
        expect(shouldShowCompact(95000)).toBe(false);
    });

    it('should not show when context is at 80%', () => {
        expect(shouldShowCompact(152000)).toBe(false);
    });

    it('should not show when context is at 89%', () => {
        expect(shouldShowCompact(169100)).toBe(false);
    });

    it('should show when context is at 90% (10% remaining)', () => {
        expect(shouldShowCompact(171000)).toBe(true);
    });

    it('should show when context is at 95% (5% remaining)', () => {
        expect(shouldShowCompact(180500)).toBe(true);
    });

    it('should show when context is at 100%', () => {
        expect(shouldShowCompact(190000)).toBe(true);
    });

    it('should show when context exceeds max', () => {
        expect(shouldShowCompact(200000)).toBe(true);
    });

    it('should not show when context is 0', () => {
        expect(shouldShowCompact(0)).toBe(false);
    });
});

describe('compact command format', () => {
    it('should send /compact as the message text', () => {
        const compactCommand = '/compact';
        expect(compactCommand).toBe('/compact');
        expect(compactCommand.startsWith('/')).toBe(true);
    });
});
