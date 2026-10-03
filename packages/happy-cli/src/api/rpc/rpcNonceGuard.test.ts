/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R18 — each bound request
 * runs once within its window.
 */
import { describe, expect, it } from 'vitest';
import { RpcNonceGuard } from './rpcNonceGuard';

describe('RpcNonceGuard', () => {
    it('admits a nonce once while a replay could still pass the time check', () => {
        const guard = new RpcNonceGuard({ windowMs: 1_000, maxEntries: 10, whenFull: 'refuse' });

        expect(guard.admit('a', 100, 100)).toBe('admitted');
        expect(guard.admit('a', 100, 900)).toBe('replayed');
        expect(guard.admit('a', 100, 1_100)).toBe('replayed');
    });

    it('forgets a nonce once its window has passed', () => {
        const guard = new RpcNonceGuard({ windowMs: 1_000, maxEntries: 10, whenFull: 'refuse' });
        guard.admit('a', 100, 100);

        guard.admit('b', 1_200, 1_200);
        expect(guard.size).toBe(1);
    });

    // Strict: forgetting a nonce still inside its window would let its request run again.
    it('refuses a new nonce when full of nonces still inside their window, and keeps them all', () => {
        const guard = new RpcNonceGuard({ windowMs: 1_000, maxEntries: 2, whenFull: 'refuse' });
        guard.admit('a', 100, 100);
        guard.admit('b', 110, 110);

        expect(guard.admit('c', 120, 120)).toBe('full');
        expect(guard.admit('a', 100, 130)).toBe('replayed');
        expect(guard.size).toBe(2);
    });

    // Issue times differ by up to the window either way, so insertion order is not expiry order.
    it('sweeps every expired nonce before calling itself full', () => {
        const guard = new RpcNonceGuard({ windowMs: 1_000, maxEntries: 2, whenFull: 'refuse' });
        guard.admit('ahead', 5_000, 100);
        guard.admit('b', 100, 100);

        expect(guard.admit('c', 2_000, 2_000)).toBe('admitted');
        expect(guard.admit('ahead', 5_000, 2_000)).toBe('replayed');
    });

    // Compat: the server can mint requests anyway, so a full guard drops its oldest nonce rather
    // than refuse the customer.
    it('drops the oldest nonce when full under compat', () => {
        const guard = new RpcNonceGuard({ windowMs: 1_000, maxEntries: 2, whenFull: 'evict-oldest' });
        guard.admit('a', 100, 100);
        guard.admit('b', 110, 110);

        expect(guard.admit('c', 120, 120)).toBe('admitted');
        expect(guard.size).toBe(2);
        expect(guard.admit('b', 110, 130)).toBe('replayed');
    });
});
