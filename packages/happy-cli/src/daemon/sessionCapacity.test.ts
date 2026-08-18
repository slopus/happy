import { describe, expect, it } from 'vitest';
import { createSessionCapacityLimiter } from './sessionCapacity';

describe('createSessionCapacityLimiter', () => {
    it('atomically reserves pending slots', () => {
        const limiter = createSessionCapacityLimiter({
            maxConcurrentSessions: 2,
            countActiveSessions: () => 0,
        });

        const first = limiter.tryReserve();
        const second = limiter.tryReserve();

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(limiter.tryReserve()).toBeNull();
        expect(limiter.pendingCount()).toBe(2);

        first!.release();
        expect(limiter.tryReserve()).not.toBeNull();
    });

    it('counts active sessions and transfers committed reservations', () => {
        let active = 1;
        const limiter = createSessionCapacityLimiter({
            maxConcurrentSessions: 2,
            countActiveSessions: () => active,
        });

        const reservation = limiter.tryReserve();
        expect(reservation).not.toBeNull();
        expect(limiter.tryReserve()).toBeNull();

        active += 1;
        reservation!.commit();
        expect(limiter.pendingCount()).toBe(0);
        expect(limiter.tryReserve()).toBeNull();

        active -= 1;
        expect(limiter.tryReserve()).not.toBeNull();
    });

    it('is unlimited when no maximum is configured', () => {
        const limiter = createSessionCapacityLimiter({
            countActiveSessions: () => 100,
        });

        expect(limiter.tryReserve()).not.toBeNull();
        expect(limiter.tryReserve()).not.toBeNull();
    });
});
