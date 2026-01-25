import { describe, expect, it, vi } from 'vitest';
import { linearBackoffDelay } from './time';

describe('linearBackoffDelay', () => {
    it('clamps to the configured min/max range', () => {
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
        try {
            expect(linearBackoffDelay(0, 250, 1000, 8)).toBe(250);
            expect(linearBackoffDelay(8, 250, 1000, 8)).toBe(1000);
            expect(linearBackoffDelay(50, 250, 1000, 8)).toBe(1000);
        } finally {
            randomSpy.mockRestore();
        }
    });
});

