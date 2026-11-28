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
type Touch = { key: string; accountKey: string; accessedAt: number; signal: AbortSignal; assertCurrent?: () => void };
type CacheState = {
    factory: IDBFactory;
    connection?: IDBDatabase;
    opening?: Promise<IDBDatabase>;
    touches: Map<string, Touch>;
    scheduled: boolean;
    flushing: boolean;
};
const caches = new WeakMap<IDBFactory, CacheState>();
function cacheState(): CacheState {
    let state = caches.get(indexedDB);
    if (!state) {
        state = { factory: indexedDB, touches: new Map(), scheduled: false, flushing: false };
        caches.set(indexedDB, state);
    }
    return state;
}
const cacheKey = (identity: CacheIdentity) => JSON.stringify([
    identity.accountKey, identity.machineId, identity.canvasId,
    identity.assetId, identity.versionId, identity.previewVersionId,
]);

function invalidateConnection(state: CacheState, db: IDBDatabase) {
    if (state.connection === db) state.connection = undefined;
    db.close();
}

function openCache(state: CacheState): Promise<IDBDatabase> {
    if (state.connection) return Promise.resolve(state.connection);
    if (state.opening) return state.opening;
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
        let settled = false;
        const finish = (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        };
        const timeout = setTimeout(() => finish(new Error('Canvas preview storage open timed out')), storageTimeoutMs);
        try {
            const opening = state.factory.open(databaseName, 1);
            opening.onupgradeneeded = () => {
                if (!opening.result.objectStoreNames.contains(byteStore)) opening.result.createObjectStore(byteStore);
                if (!opening.result.objectStoreNames.contains(metadataStore)) opening.result.createObjectStore(metadataStore, { keyPath: 'key' });
            };
            opening.onerror = () => finish(opening.error ?? new Error('Canvas preview storage unavailable'));
            opening.onblocked = () => finish(new Error('Canvas preview storage blocked'));
            opening.onsuccess = () => {
                const db = opening.result;
                if (settled) { db.close(); return; }
                settled = true;
                clearTimeout(timeout);
                state.connection = db;
                db.onversionchange = () => invalidateConnection(state, db);
                db.onclose = () => invalidateConnection(state, db);
                resolve(db);
            };
        } catch (error) { finish(error); }
    });
    state.opening = promise;
    const forgetOpening = () => { if (state.opening === promise) state.opening = undefined; };
    void promise.then(forgetOpening, forgetOpening);
    return promise;
}

// Reuse the connection, while keeping abort/timeout ownership per operation.
// Only a closed connection is reopened once; storage failures still fail open.
async function withCache<T>(state: CacheState, stores: string[], mode: IDBTransactionMode, signal: AbortSignal,
    action: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction | undefined;
        let settled = false;
        const finish = (error?: unknown, value?: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value as T);
        };
        const fail = (error: unknown) => {
            try { tx?.abort(); } catch { /* Already committed. */ }
            finish(error);
        };
        const abort = () => {
            fail(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const timeout = setTimeout(() => fail(new Error('Canvas preview storage timed out')), storageTimeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        const begin = (db: IDBDatabase, reopened = false) => {
            if (settled) return;
            try {
                tx = db.transaction(stores, mode);
            } catch (error) {
                if (!reopened && error instanceof Error && error.name === 'InvalidStateError') {
                    invalidateConnection(state, db);
                    void openCache(state).then(next => begin(next, true), fail);
                } else fail(error);
                return;
            }
            try {
                let result: T;
                tx.oncomplete = () => finish(undefined, result);
                tx.onabort = () => finish(tx?.error ?? new Error('Canvas preview storage aborted'));
                tx.onerror = () => finish(tx?.error ?? new Error('Canvas preview storage failed'));
                action(tx, value => { result = value; }, fail);
            } catch (error) { fail(error); }
        };
        void openCache(state).then(db => begin(db), fail);
    });
}

function currentTouch(touch: Touch): boolean {
    try {
        if (touch.signal.aborted || retiredAccounts.has(touch.accountKey)) return false;
        touch.assertCurrent?.();
        return true;
    } catch { return false; }
}

// Metadata-only batches cannot hold up readonly preview transactions. Keep each
// captured touch visible to eviction until its commit, including newer hits that
// arrive while that batch is in flight. Failed batches are dropped, not retried.
function scheduleTouches(state: CacheState) {
    if (state.scheduled || state.flushing || !state.touches.size) return;
    state.scheduled = true;
    queueMicrotask(() => {
        state.scheduled = false;
        const touches = [...state.touches.values()];
        if (!touches.length) return;
        state.flushing = true;
        void withCache<void>(state, [metadataStore], 'readwrite', new AbortController().signal, (tx, done, fail) => {
            const metadata = tx.objectStore(metadataStore);
            for (const touch of touches) {
                if (!currentTouch(touch)) continue;
                const request = metadata.get(touch.key);
                request.onsuccess = () => {
                    if (!currentTouch(touch) || !request.result) return;
                    const row = request.result as Metadata;
                    const accessedAt = Math.max(row.accessedAt, touch.accessedAt);
                    if (accessedAt <= row.accessedAt) return;
                    try { metadata.put({ ...row, accessedAt }); } catch (error) { fail(error); }
                };
            }
            done();
        }).catch(() => { /* Optional recency maintenance never turns a hit into a miss. */ }).finally(() => {
            for (const touch of touches) {
                if (state.touches.get(touch.key) === touch) state.touches.delete(touch.key);
            }
            state.flushing = false;
            scheduleTouches(state);
        });
    });
}

function touchPreview(state: CacheState, touch: Touch) {
    const previous = state.touches.get(touch.key);
    if (previous && currentTouch(previous)) touch.accessedAt = Math.max(previous.accessedAt, touch.accessedAt);
    state.touches.set(touch.key, touch);
    scheduleTouches(state);
}

export async function readProjectCanvasPreviewCache(identity: CacheIdentity, size: number, signal: AbortSignal, assertCurrent?: () => void): Promise<Uint8Array | undefined> {
    try {
        if (retiredAccounts.has(identity.accountKey)) return;
        const state = cacheState();
        const key = cacheKey(identity);
        const bytes = await withCache<unknown>(state, [byteStore], 'readonly', signal, (tx, done) => {
            if (retiredAccounts.has(identity.accountKey)) { done(undefined); return; }
            assertCurrent?.();
            const request = tx.objectStore(byteStore).get(key);
            request.onsuccess = () => done(request.result);
        });
        signal.throwIfAborted();
        if (retiredAccounts.has(identity.accountKey)) return;
        if (!(bytes instanceof Uint8Array) || bytes.length !== size || bytes.length > GOAL_CANVAS_LIMITS.previewBytes ||
            await projectFileHash(bytes) !== identity.previewVersionId) return;
        signal.throwIfAborted();
        if (retiredAccounts.has(identity.accountKey)) return;
        assertCurrent?.();
        touchPreview(state, { key, accountKey: identity.accountKey, accessedAt: Date.now(), signal, assertCurrent });
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
        const state = cacheState();
        const key = cacheKey(identity);
        await withCache<void>(state, [byteStore, metadataStore], 'readwrite', signal, (tx, done, fail) => {
            if (retiredAccounts.has(identity.accountKey)) { done(); return; }
            assertCurrent?.();
            const entries = tx.objectStore(byteStore);
            const metadata = tx.objectStore(metadataStore);
            entries.put(bytes.slice(), key);
            metadata.put({ key, size: bytes.length, accessedAt: Date.now() });
            const request = metadata.getAll();
            request.onsuccess = () => {
                try {
                    signal.throwIfAborted();
                    if (retiredAccounts.has(identity.accountKey)) throw new Error('Canvas preview account retired');
                    assertCurrent?.();
                    const rows = (request.result as Metadata[]).map(row => {
                        const touch = state.touches.get(row.key);
                        if (!touch || !currentTouch(touch) || touch.accessedAt <= row.accessedAt) return row;
                        const updated = { ...row, accessedAt: touch.accessedAt };
                        metadata.put(updated);
                        return updated;
                    }).sort((a, b) => a.accessedAt - b.accessedAt);
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
                } catch (error) { fail(error); }
            };
        });
    } catch { signal.throwIfAborted(); }
}

/** Optional cache cleanup cannot prevent signing out when storage is disabled. */
export async function clearProjectCanvasPreviewCache(accountKey: string): Promise<void> {
    retiredAccounts.add(accountKey);
    try {
        const state = cacheState();
        for (const [key, touch] of state.touches) if (touch.accountKey === accountKey) state.touches.delete(key);
        await withCache<void>(state, [byteStore, metadataStore], 'readwrite', new AbortController().signal, (tx, done) => {
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
