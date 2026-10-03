/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R18 — remembers the
 * nonces of bound requests for as long as a replay could still pass the time
 * check, so each request runs once.
 *
 * Memory only: after a daemon restart a request from just before it can run
 * again until its window ends. When full, the nonce closest to expiry goes
 * first, so a burst of genuine requests never locks the owner out.
 */
export class RpcNonceGuard {
    /** nonce → when a replay of it would fail the time check anyway. Insertion order ≈ expiry order. */
    private readonly seen = new Map<string, number>();

    constructor(private readonly options: { windowMs: number; maxEntries: number }) {}

    get size(): number {
        return this.seen.size;
    }

    /** True the first time `nonce` is seen within its window. */
    admit(nonce: string, issuedAt: number, now: number): boolean {
        for (const [seenNonce, expiresAt] of this.seen) {
            if (expiresAt >= now) break;
            this.seen.delete(seenNonce);
        }
        if (this.seen.has(nonce)) return false;
        if (this.seen.size >= this.options.maxEntries) {
            const oldest = this.seen.keys().next().value;
            if (oldest !== undefined) this.seen.delete(oldest);
        }
        this.seen.set(nonce, issuedAt + this.options.windowMs);
        return true;
    }
}
