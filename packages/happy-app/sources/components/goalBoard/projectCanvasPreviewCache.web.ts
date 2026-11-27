import { GOAL_CANVAS_LIMITS } from '@slopus/happy-wire';
import { projectFileHash } from '@/sync/projectFileHash';

const databaseName = 'paws-project-canvas-previews-v1';
const byteStore = 'previews';
const metadataStore = 'metadata';
const maxBytes = 32 * 1024 * 1024;
const maxEntries = 1024;
const storageTimeoutMs = 1500;
// Logout/remove fences also cover opens and writes that were already pending.
// A newly selected account enters a fresh runtime before using this cache.
const retiredAccounts = new Set<string>();
type CacheIdentity = {
    accountKey: string;
    machineId: string;
    canvasId: string;
    assetId: string;
    versionId: string;
    previewVersionId: string;
};
type Metadata = { key: string; size: number; accessedAt: number };
const cacheKey = (identity: CacheIdentity) => JSON.stringify([
    identity.accountKey, identity.machineId, identity.canvasId,
    identity.assetId, identity.versionId, identity.previewVersionId,
]);

// Like staged attachments, store binary bytes and wait for transaction commit.
// Keep eviction metadata separate so writing one thumbnail never clones every
// cached thumbnail. A blocked/unavailable database must not stall image RPCs.
async function withCache<T>(signal: AbortSignal, action: (tx: IDBTransaction, done: (value: T) => void) => void): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        let db: IDBDatabase | undefined;
        let tx: IDBTransaction | undefined;
        let settled = false;
        const finish = (error?: unknown, value?: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            db?.close();
            if (error) reject(error); else resolve(value as T);
        };
        const abort = () => {
            try { tx?.abort(); } catch { /* Already committed. */ }
            finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const timeout = setTimeout(() => {
            try { tx?.abort(); } catch { /* Already committed. */ }
            finish(new Error('Canvas preview storage timed out'));
        }, storageTimeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        try {
            const opening = indexedDB.open(databaseName, 1);
            opening.onupgradeneeded = () => {
                opening.result.createObjectStore(byteStore);
                opening.result.createObjectStore(metadataStore, { keyPath: 'key' });
            };
            opening.onerror = () => finish(opening.error ?? new Error('Canvas preview storage unavailable'));
            opening.onblocked = () => finish(new Error('Canvas preview storage blocked'));
            opening.onsuccess = () => {
                db = opening.result;
                if (settled) { db.close(); return; }
                try {
                    tx = db.transaction([byteStore, metadataStore], 'readwrite');
                    let result: T;
                    tx.oncomplete = () => finish(undefined, result);
                    tx.onabort = () => finish(tx?.error ?? new Error('Canvas preview storage aborted'));
                    tx.onerror = () => finish(tx?.error ?? new Error('Canvas preview storage failed'));
                    action(tx, value => { result = value; });
                } catch (error) {
                    try { tx?.abort(); } catch { /* No live transaction. */ }
                    finish(error);
                }
            };
        } catch (error) { finish(error); }
    });
}

export async function readProjectCanvasPreviewCache(identity: CacheIdentity, size: number, signal: AbortSignal, assertCurrent?: () => void): Promise<Uint8Array | undefined> {
    try {
        if (retiredAccounts.has(identity.accountKey)) return;
        const key = cacheKey(identity);
        const bytes = await withCache<unknown>(signal, (tx, done) => {
            if (retiredAccounts.has(identity.accountKey)) { done(undefined); return; }
            assertCurrent?.();
            const request = tx.objectStore(byteStore).get(key);
            request.onsuccess = () => {
                done(request.result);
                if (request.result instanceof Uint8Array) tx.objectStore(metadataStore).put({ key, size: request.result.length, accessedAt: Date.now() });
            };
        });
        signal.throwIfAborted();
        if (retiredAccounts.has(identity.accountKey)) return;
        if (!(bytes instanceof Uint8Array) || bytes.length !== size || bytes.length > GOAL_CANVAS_LIMITS.previewBytes ||
            await projectFileHash(bytes) !== identity.previewVersionId) return;
        signal.throwIfAborted();
        return bytes;
    } catch {
        signal.throwIfAborted();
        return;
    }
}

export async function writeProjectCanvasPreviewCache(identity: CacheIdentity, bytes: Uint8Array, signal: AbortSignal, assertCurrent?: () => void): Promise<void> {
    try {
        signal.throwIfAborted();
        if (retiredAccounts.has(identity.accountKey) || !bytes.length || bytes.length > GOAL_CANVAS_LIMITS.previewBytes) return;
        const key = cacheKey(identity);
        await withCache<void>(signal, (tx, done) => {
            if (retiredAccounts.has(identity.accountKey)) { done(); return; }
            assertCurrent?.();
            const entries = tx.objectStore(byteStore);
            const metadata = tx.objectStore(metadataStore);
            entries.put(bytes.slice(), key);
            metadata.put({ key, size: bytes.length, accessedAt: Date.now() });
            const request = metadata.getAll();
            request.onsuccess = () => {
                const rows = (request.result as Metadata[]).sort((a, b) => a.accessedAt - b.accessedAt);
                let total = rows.reduce((sum, item) => sum + item.size, 0);
                let count = rows.length;
                for (const item of rows) {
                    if (total <= maxBytes && count <= maxEntries) break;
                    entries.delete(item.key);
                    metadata.delete(item.key);
                    total -= item.size;
                    count--;
                }
                done();
            };
        });
    } catch { signal.throwIfAborted(); }
}

/** Optional cache cleanup cannot prevent signing out when storage is disabled. */
export async function clearProjectCanvasPreviewCache(accountKey: string): Promise<void> {
    retiredAccounts.add(accountKey);
    try {
        await withCache<void>(new AbortController().signal, (tx, done) => {
            const metadata = tx.objectStore(metadataStore);
            const entries = tx.objectStore(byteStore);
            const request = metadata.getAllKeys();
            request.onsuccess = () => {
                for (const key of request.result) {
                    try {
                        if (JSON.parse(String(key))[0] !== accountKey) continue;
                    } catch { continue; }
                    metadata.delete(key);
                    entries.delete(key);
                }
                done();
            };
        });
    } catch { /* Keep logout available if the browser rejects optional storage. */ }
}
