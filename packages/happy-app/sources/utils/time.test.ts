import { afterEach, describe, expect, it, vi } from 'vitest';
import { exponentialBackoffDelay } from './time';

afterEach(() => vi.restoreAllMocks());

describe('exponentialBackoffDelay', () => {
    it('doubles the ceiling per failure from minDelay up to maxDelay', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        expect(exponentialBackoffDelay(1, 250, 30_000, 50)).toBe(250);
        expect(exponentialBackoffDelay(3, 250, 30_000, 50)).toBe(1000);
        expect(exponentialBackoffDelay(8, 250, 30_000, 50)).toBe(30_000);
        expect(exponentialBackoffDelay(50, 250, 1000, 50)).toBe(1000);
    });
});
