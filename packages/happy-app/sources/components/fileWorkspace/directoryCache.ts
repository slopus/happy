import type { DirectoryEntry } from '@/sync/ops';

export type CachedDirectory = { entries?: DirectoryEntry[]; error?: string; loading?: boolean };
type Loader = () => Promise<{ success: boolean; entries?: DirectoryEntry[]; error?: string }>;
/** Bounded metadata cache. Only navigation, explicit refresh or a change event triggers reads. */
export class DirectoryCache {
    private snapshot: Record<string, CachedDirectory> = {};
    private pending = new Map<string, Promise<void>>();
    private listeners = new Set<() => void>();
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    getSnapshot = () => this.snapshot;
    private update(path: string, value: CachedDirectory) {
        const entries = Object.entries(this.snapshot).filter(([key]) => key !== path).slice(-79);
        this.snapshot = { ...Object.fromEntries(entries), [path]: value };
        for (const listener of this.listeners) listener();
    }
    load(path: string, loader: Loader, isCurrent: () => boolean): Promise<void> {
        const pending = this.pending.get(path);
        if (pending) return pending;
        this.update(path, { ...this.snapshot[path], loading: true, error: undefined });
        const request = Promise.resolve().then(loader).then(result => {
            if (!isCurrent()) return;
            this.update(path, result.success ? { entries: result.entries ?? [] } : { ...this.snapshot[path], loading: false, error: result.error ?? 'Unable to read directory' });
        }).catch(error => {
            if (isCurrent()) this.update(path, { ...this.snapshot[path], loading: false, error: String(error) });
        }).finally(() => { this.pending.delete(path); });
        this.pending.set(path, request);
        return request;
    }
}
const caches = new Map<string, DirectoryCache>();
export function getDirectoryCache(key: string): DirectoryCache {
    let cache = caches.get(key);
    if (!cache) {
        if (caches.size >= 30) caches.delete(caches.keys().next().value!);
        cache = new DirectoryCache(); caches.set(key, cache);
    }
    return cache;
}
