/** In-memory for this frontend runtime only; a page refresh starts cold. Never stores documents, permissions or native bindings. */
type Limits = { bytes: number; entries: number; ownerBytes: number; ownerEntries: number; owners: number; ttlMs: number };
type Owner = { key: string; isCurrent(): boolean; entries: Map<string, Entry>; bytes: number };
type Entry = { owner: Owner; key: string; bytes: Uint8Array; expiresAt: number };
export type StudioResourceCacheLease = {
    get(key: string): Uint8Array | undefined;
    putVerified(key: string, bytes: Uint8Array): void;
    remove(key: string): void;
    invalidate(): void;
};
const defaults: Limits = { bytes: 160 * 1024 * 1024, entries: 256, ownerBytes: 128 * 1024 * 1024, ownerEntries: 192, owners: 16, ttlMs: 15 * 60 * 1000 };

export function createStudioResourceCache(overrides: Partial<Limits> = {}, now = Date.now) {
    const limits = { ...defaults, ...overrides };
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid studio resource cache limit');
    const owners = new Map<string, Owner>();
    const entries = new Map<Entry, true>();
    let size = 0;
    const remove = (entry: Entry) => {
        entries.delete(entry); entry.owner.entries.delete(entry.key);
        size -= entry.bytes.length; entry.owner.bytes -= entry.bytes.length;
    };
    const invalidate = (owner: Owner) => {
        for (const entry of owner.entries.values()) remove(entry);
        // An old lease must never remove a replacement owner or repopulate after invalidation.
        if (owners.get(owner.key) === owner) owners.delete(owner.key);
    };
    const current = (owner: Owner) => {
        if (owners.get(owner.key) !== owner) return false;
        if (owner.isCurrent()) return true;
        invalidate(owner); return false;
    };
    const prune = () => {
        for (const owner of owners.values()) current(owner);
        const time = now();
        for (const entry of entries.keys()) if (entry.expiresAt <= time) remove(entry);
    };
    return {
        // Expiry/account invalidation is checked on use; no background timers or status queries.
        prune,
        clear() { for (const owner of owners.values()) invalidate(owner); },
        acquire(key: string, isCurrent: () => boolean): StudioResourceCacheLease {
            prune();
            let owner = owners.get(key);
            if (!owner) {
                while (owners.size >= limits.owners) invalidate(owners.values().next().value!);
                owner = { key, isCurrent, entries: new Map(), bytes: 0 }; owners.set(key, owner);
            }
            const captured = owner;
            const touch = (entry: Entry) => {
                entries.delete(entry); entries.set(entry, true);
                captured.entries.delete(entry.key); captured.entries.set(entry.key, entry);
                owners.delete(key); owners.set(key, captured);
            };
            return {
                get(resourceKey) {
                    prune(); if (!current(captured) || !isCurrent()) { invalidate(captured); return; }
                    const entry = captured.entries.get(resourceKey); if (!entry) return;
                    touch(entry);
                    // Iframe messages may transfer/detach or mutate their buffers; retain a private copy.
                    return entry.bytes.slice();
                },
                putVerified(resourceKey, bytes) {
                    prune(); if (!current(captured) || !isCurrent()) { invalidate(captured); return; }
                    if (bytes.length > Math.min(limits.bytes, limits.ownerBytes)) return;
                    const previous = captured.entries.get(resourceKey); if (previous) remove(previous);
                    while (captured.bytes + bytes.length > limits.ownerBytes || captured.entries.size >= limits.ownerEntries) remove(captured.entries.values().next().value!);
                    while (size + bytes.length > limits.bytes || entries.size >= limits.entries) remove(entries.keys().next().value!);
                    const entry: Entry = { owner: captured, key: resourceKey, bytes: bytes.slice(), expiresAt: now() + limits.ttlMs };
                    captured.entries.set(resourceKey, entry); entries.set(entry, true);
                    captured.bytes += entry.bytes.length; size += entry.bytes.length; touch(entry);
                },
                remove(resourceKey) { const entry = captured.entries.get(resourceKey); if (entry) remove(entry); },
                invalidate() { invalidate(captured); },
            };
        },
    };
}
export type StudioResourceCache = ReturnType<typeof createStudioResourceCache>;
export const studioResourceCache = createStudioResourceCache();
