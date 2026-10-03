/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R18 — each bound request
 * runs once within its window.
 */
import { describe, expect, it } from 'vitest';
import { RpcNonceGuard } from './rpcNonceGuard';

describe('RpcNonceGuard', () => {
    it('admits a nonce once while a replay could still pass the time check', () => {
        const guard = new RpcNonceGuard({ windowMs: 1_000, maxEntries: 10 });

        expect(guard.admit('a', 100, 100)).toBe(true);
        expect(guard.admit('a', 100, 900)).toBe(false);
        expect(guard.admit('a', 100, 1_100)).toBe(false);
    });

    it('forgets a nonce once its window has passed', () => {
        const guard = new RpcNonceGuard({ windowMs: 1_000, maxEntries: 10 });
        guard.admit('a', 100, 100);

        guard.admit('b', 1_200, 1_200);
        expect(guard.size).toBe(1);
    });

    it('drops the oldest nonce when full rather than refusing new requests', () => {
        const guard = new RpcNonceGuard({ windowMs: 1_000, maxEntries: 2 });
        guard.admit('a', 100, 100);
        guard.admit('b', 110, 110);

        expect(guard.admit('c', 120, 120)).toBe(true);
        expect(guard.size).toBe(2);
        expect(guard.admit('b', 110, 130)).toBe(false);
    });
});
