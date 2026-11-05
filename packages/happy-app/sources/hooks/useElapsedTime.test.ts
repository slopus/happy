import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeToTick } from './useElapsedTime';

describe('subscribeToTick', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.restoreAllMocks());

    it('runs a single shared interval for many subscribers and stops when the last leaves', () => {
        const setSpy = vi.spyOn(global, 'setInterval');
        const clearSpy = vi.spyOn(global, 'clearInterval');

        const a = vi.fn();
        const b = vi.fn();
        const offA = subscribeToTick(a);
        const offB = subscribeToTick(b);

        // Two subscribers, still only one timer.
        expect(setSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1000);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);

        // Removing one keeps the timer running for the other.
        offA();
        vi.advanceTimersByTime(1000);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(2);
        expect(clearSpy).not.toHaveBeenCalled();

        // Removing the last clears the timer.
        offB();
        expect(clearSpy).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5000);
        expect(b).toHaveBeenCalledTimes(2);
    });
});
