const owners = new Set<string>();
const claims = new Map<string, Promise<boolean>>();
export const ownsQueue = (name: string) => owners.has(name);
/** A lifetime lock, never a migration lock or a timed business-state poll. */
export function claimQueue(name: string): Promise<boolean> {
    if (owners.has(name)) return Promise.resolve(true);
    const pending = claims.get(name); if (pending) return pending;
    if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(false);
    const claim = new Promise<boolean>((resolve, reject) => {
        void navigator.locks.request(`paws-durable-queue:${name}`, { ifAvailable: true }, async lock => {
            if (!lock) { resolve(false); return; }
            owners.add(name); resolve(true);
            await new Promise<void>(() => { /* browser document owns the lease */ });
        }).catch(reject);
    });
    claims.set(name, claim);
    void claim.then(() => claims.delete(name), () => claims.delete(name));
    return claim;
}
