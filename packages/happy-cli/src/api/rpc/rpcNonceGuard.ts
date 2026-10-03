/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R18 — remembers the
 * nonces of bound requests for as long as a replay could still pass the time
 * check, so each request runs once.
 *
 * Memory only: after a daemon restart a request from just before it can run
 * again until its window ends. When full, strict refuses new requests rather
 * than forget a nonce still inside its window, which would let its request run
 * again. Compat drops the oldest instead: there the server can mint requests
 * anyway, and refusing would only lock the owner out.
 */
export type NonceAdmission = 'admitted' | 'replayed' | 'full';

export class RpcNonceGuard {
    /** nonce → when a replay of it would fail the time check anyway. Insertion order ≈ expiry order. */
    private readonly seen = new Map<string, number>();

    constructor(private readonly options: { windowMs: number; maxEntries: number; whenFull: 'refuse' | 'evict-oldest' }) {}

    get size(): number {
        return this.seen.size;
    }

    admit(nonce: string, issuedAt: number, now: number): NonceAdmission {
        for (const [seenNonce, expiresAt] of this.seen) {
            if (expiresAt >= now) break;
            this.seen.delete(seenNonce);
        }
        if (this.seen.has(nonce)) return 'replayed';
        if (this.seen.size >= this.options.maxEntries) {
            // Issue times differ by up to the window either way, so an expired nonce can sit
            // behind one that is not; sweep them all before calling the guard full.
            for (const [seenNonce, expiresAt] of this.seen) {
                if (expiresAt < now) this.seen.delete(seenNonce);
            }
        }
        if (this.seen.size >= this.options.maxEntries) {
            if (this.options.whenFull === 'refuse') return 'full';
            const oldest = this.seen.keys().next().value;
            if (oldest !== undefined) this.seen.delete(oldest);
        }
        this.seen.set(nonce, issuedAt + this.options.windowMs);
        return 'admitted';
    }
}
