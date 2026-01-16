import { describe, expect, it, vi } from 'vitest';
import { ignoreNextRowPress } from './ignoreNextRowPress';

describe('ignoreNextRowPress', () => {
    it('resets the ignore flag on the next tick', () => {
        vi.useFakeTimers();
        const ref = { current: false };

        ignoreNextRowPress(ref);
        expect(ref.current).toBe(true);

        vi.runAllTimers();
        expect(ref.current).toBe(false);

        vi.useRealTimers();
    });
});

