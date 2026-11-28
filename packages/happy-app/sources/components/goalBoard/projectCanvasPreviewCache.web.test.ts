import { createHash } from 'node:crypto';
import { IDBDatabase, IDBFactory, IDBObjectStore, IDBVersionChangeEvent } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProjectCanvasPreviewCache, readProjectCanvasPreviewCache, writeProjectCanvasPreviewCache } from './projectCanvasPreviewCache.web';

const bytes = new Uint8Array(64 * 1024).fill(7);
const previewVersionId = createHash('sha256').update(bytes).digest('hex');
const identity = (index: number) => ({ accountKey: 'account', machineId: 'machine', canvasId: 'canvas',
    assetId: `asset-${index}`, versionId: 'source', previewVersionId });
const signal = () => new AbortController().signal;
const keyFor = (item: ReturnType<typeof identity>) => JSON.stringify([
    item.accountKey, item.machineId, item.canvasId, item.assetId, item.versionId, item.previewVersionId,
]);
const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};

async function openDatabase() {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open('paws-project-canvas-previews-v1', 1);
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
    });
}

type Row = { key: string; size: number; accessedAt: number };
async function metadataRows(db: IDBDatabase): Promise<Row[]> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('metadata');
        const request = tx.objectStore('metadata').getAll();
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
    });
}

function holdTouches() {
    const callbacks: VoidFunction[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => { callbacks.push(callback); });
    return async (db: IDBDatabase) => {
        const batch = callbacks.splice(0);
        for (const callback of batch) callback();
        await Promise.resolve(); // Let the cached connection start the batch transaction.
        return metadataRows(db); // A later metadata transaction observes its real commit.
    };
}

// Hold notification of a real metadata commit without blocking the IDB engine.
function holdMetadataCompletions() {
    const started = deferred();
    const release = deferred();
    const completed: Promise<void>[] = [];
    const original = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof original>) {
        const tx = original.apply(this, args);
        if (tx.mode === 'readwrite' && tx.objectStoreNames.contains('metadata')) {
            Object.defineProperty(tx, 'oncomplete', { set(handler) {
                tx.addEventListener('complete', event => {
                    started.resolve();
                    completed.push(release.promise.then(() => handler?.call(tx, event)));
                });
            } });
        }
        return tx;
    });
    return { started: started.promise, release: async () => { release.resolve(); await Promise.all(completed); } };
}

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bounded canvas preview storage', () => {
    it('returns verified bytes without waiting for a metadata commit', async () => {
        await writeProjectCanvasPreviewCache(identity(0), bytes, signal());
        const gate = holdMetadataCompletions();
        let result: Uint8Array | undefined;
        const reading = readProjectCanvasPreviewCache(identity(0), bytes.length, signal()).then(value => { result = value; });
        try {
            await gate.started;
            expect(result?.length).toBe(bytes.length);
        } finally { await gate.release(); await reading; }
    });

    it('shares one connection across concurrent reads and uses readonly preview transactions', async () => {
        const opening = vi.spyOn(indexedDB, 'open');
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
        await Promise.all(Array.from({ length: 12 }, (_, index) => readProjectCanvasPreviewCache(identity(index), bytes.length, signal())));
        expect(opening).toHaveBeenCalledTimes(1);
        const reads = transactions.mock.calls.filter(([, mode]) => mode !== 'versionchange');
        expect(reads).toHaveLength(12);
        for (const [stores, mode] of reads) {
            expect(stores).toEqual(['previews']);
            expect(mode).toBe('readonly');
        }
    });

    it('reopens a closed connection and ignores lifecycle events from its replacement', async () => {
        const opening = vi.spyOn(indexedDB, 'open');
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
        await writeProjectCanvasPreviewCache(identity(0), bytes, signal());
        const old = transactions.mock.contexts[0] as IDBDatabase;
        old.close();
        expect(await readProjectCanvasPreviewCache(identity(0), bytes.length, signal())).toEqual(bytes);
        old.dispatchEvent(new IDBVersionChangeEvent('close'));
        old.dispatchEvent(new IDBVersionChangeEvent('versionchange'));
        expect(await readProjectCanvasPreviewCache(identity(0), bytes.length, signal())).toEqual(bytes);
        expect(opening).toHaveBeenCalledTimes(2);
    });

    it.each(['versionchange', 'close'])('invalidates the shared connection on %s', async event => {
        const opening = vi.spyOn(indexedDB, 'open');
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
        await writeProjectCanvasPreviewCache(identity(0), bytes, signal());
        (transactions.mock.contexts[0] as IDBDatabase).dispatchEvent(new IDBVersionChangeEvent(event));
        expect(await readProjectCanvasPreviewCache(identity(0), bytes.length, signal())).toEqual(bytes);
        expect(opening).toHaveBeenCalledTimes(2);
    });

    it('keeps a shared open usable when one waiting reader is cancelled', async () => {
        const actualOpen = indexedDB.open.bind(indexedDB);
        const opening = {} as IDBOpenDBRequest;
        const open = vi.spyOn(indexedDB, 'open').mockReturnValueOnce(opening);
        const cancelled = new AbortController();
        const first = readProjectCanvasPreviewCache(identity(0), bytes.length, cancelled.signal);
        const second = readProjectCanvasPreviewCache(identity(1), bytes.length, signal());
        const rejected = expect(first).rejects.toHaveProperty('name', 'AbortError');
        cancelled.abort();
        const real = actualOpen('paws-project-canvas-previews-v1', 1);
        real.onupgradeneeded = () => { real.result.createObjectStore('previews'); real.result.createObjectStore('metadata', { keyPath: 'key' }); };
        await new Promise<void>(resolve => { real.onsuccess = () => resolve(); });
        Object.defineProperty(opening, 'result', { value: real.result });
        opening.onsuccess?.call(opening, new Event('success'));
        await rejected;
        expect(await second).toBeUndefined();
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('coalesces queued touches and never replaces newer persisted recency with an older hit', async () => {
        let now = 100;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        await writeProjectCanvasPreviewCache(identity(0), bytes, signal());
        const db = await openDatabase();
        const flush = holdTouches();
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
        try {
            now = 300;
            await readProjectCanvasPreviewCache(identity(0), bytes.length, signal());
            now = 200;
            await readProjectCanvasPreviewCache(identity(0), bytes.length, signal());
            expect((await flush(db))[0].accessedAt).toBe(300);
            now = 150;
            await readProjectCanvasPreviewCache(identity(0), bytes.length, signal());
            expect((await flush(db))[0].accessedAt).toBe(300);
            const writes = transactions.mock.calls.filter(([, mode]) => mode === 'readwrite');
            expect(writes).toHaveLength(2);
            expect(writes.every(([stores]) => JSON.stringify(stores) === '["metadata"]')).toBe(true);
        } finally { db.close(); }
    });

    it('retains newer touches received while an earlier batch is awaiting completion', async () => {
        let now = 100;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        await writeProjectCanvasPreviewCache(identity(0), bytes, signal());
        await writeProjectCanvasPreviewCache(identity(1), bytes, signal());
        const db = await openDatabase();
        const gate = holdMetadataCompletions();
        const newerWritten = deferred();
        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
            const result = put.apply(this, args);
            if (this.name === 'metadata' && args[0].accessedAt === 300) newerWritten.resolve();
            return result;
        });
        try {
            now = 200;
            await readProjectCanvasPreviewCache(identity(0), bytes.length, signal());
            await gate.started;
            now = 300;
            await Promise.all([0, 1].map(index => readProjectCanvasPreviewCache(identity(index), bytes.length, signal())));
            await gate.release();
            await newerWritten.promise;
            expect((await metadataRows(db)).map(row => row.accessedAt)).toEqual([300, 300]);
        } finally { await gate.release(); db.close(); }
    });

    it.each(['abort', 'runtime', 'logout', 'delete'])('does not apply a queued touch after %s', async boundary => {
        vi.spyOn(Date, 'now').mockReturnValue(100);
        const item = { ...identity(0), accountKey: `queued-${boundary}` };
        await writeProjectCanvasPreviewCache(item, bytes, signal());
        const db = await openDatabase();
        const flush = holdTouches();
        const controller = new AbortController();
        let current = true;
        try {
            vi.mocked(Date.now).mockReturnValue(200);
            expect((await readProjectCanvasPreviewCache(item, bytes.length, controller.signal, () => {
                if (!current) throw new Error('Account changed');
            }))?.length).toBe(bytes.length);
            if (boundary === 'abort') controller.abort();
            if (boundary === 'runtime') current = false;
            if (boundary === 'logout') await clearProjectCanvasPreviewCache(item.accountKey);
            if (boundary === 'delete') await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(['metadata', 'previews'], 'readwrite');
                tx.objectStore('metadata').delete(keyFor(item));
                tx.objectStore('previews').delete(keyFor(item));
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(tx.error);
            });
            const rows = await flush(db);
            if (boundary === 'delete' || boundary === 'logout') expect(rows).toHaveLength(0);
            else expect(rows[0].accessedAt).toBe(100);
        } finally { db.close(); }
    });

    it('drops a failed touch batch and waits for a new hit before another write', async () => {
        let now = 100;
        vi.spyOn(Date, 'now').mockImplementation(() => now++);
        await writeProjectCanvasPreviewCache(identity(0), bytes, signal());
        const db = await openDatabase();
        let failed = deferred();
        const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
            failed.resolve();
            throw new DOMException('full', 'QuotaExceededError');
        });
        try {
            expect((await readProjectCanvasPreviewCache(identity(0), bytes.length, signal()))?.length).toBe(bytes.length);
            await failed.promise;
            await metadataRows(db);
            expect(put).toHaveBeenCalledOnce();
            failed = deferred();
            expect((await readProjectCanvasPreviewCache(identity(0), bytes.length, signal()))?.length).toBe(bytes.length);
            await failed.promise;
            await metadataRows(db);
            expect(put).toHaveBeenCalledTimes(2);
        } finally { db.close(); }
    });

    it.each(['blocked', 'error', 'timeout'])('recovers after an open %s and closes its late success', async failure => {
        vi.useFakeTimers();
        const failed = {} as IDBOpenDBRequest;
        const opening = vi.spyOn(indexedDB, 'open').mockReturnValueOnce(failed);
        try {
            const reading = readProjectCanvasPreviewCache(identity(0), bytes.length, signal());
            if (failure === 'timeout') await vi.advanceTimersByTimeAsync(1500);
            else if (failure === 'blocked') failed.onblocked?.call(failed, new IDBVersionChangeEvent('blocked'));
            else failed.onerror?.call(failed, new Event('error'));
            expect(await reading).toBeUndefined();
            vi.useRealTimers();
            await writeProjectCanvasPreviewCache(identity(0), bytes, signal());
            const late = await openDatabase();
            const close = vi.spyOn(late, 'close');
            Object.defineProperty(failed, 'result', { value: late });
            failed.onsuccess?.call(failed, new Event('success'));
            expect(close).toHaveBeenCalledOnce();
            expect(await readProjectCanvasPreviewCache(identity(0), bytes.length, signal())).toEqual(bytes);
            expect(opening).toHaveBeenCalledTimes(3); // failed, pooled replacement, test inspection
        } finally { vi.useRealTimers(); }
    });

    it('checks account ownership after a delayed database open before committing bytes', async () => {
        let current = true;
        const writing = writeProjectCanvasPreviewCache(identity(9), bytes, signal(), () => {
            if (!current) throw new Error('Account changed');
        });
        current = false;
        await writing;
        expect(await readProjectCanvasPreviewCache(identity(9), bytes.length, signal())).toBeUndefined();
    });
    it('purges only the signed-out account and fences late writes', async () => {
        const retired = { ...identity(0), accountKey: 'retired-account' };
        const other = { ...identity(0), accountKey: 'other-account' };
        await writeProjectCanvasPreviewCache(retired, bytes, signal());
        await writeProjectCanvasPreviewCache(other, bytes, signal());
        const delayedWrite = writeProjectCanvasPreviewCache(retired, bytes, signal());
        await clearProjectCanvasPreviewCache(retired.accountKey);
        await delayedWrite;
        await writeProjectCanvasPreviewCache(retired, bytes, signal());
        expect(await readProjectCanvasPreviewCache(retired, bytes.length, signal())).toBeUndefined();
        expect(await readProjectCanvasPreviewCache(other, bytes.length, signal())).toEqual(bytes);
        const db = await new Promise<IDBDatabase>(resolve => {
            const opening = indexedDB.open('paws-project-canvas-previews-v1', 1);
            opening.onsuccess = () => resolve(opening.result);
        });
        try {
            const keys = await new Promise<IDBValidKey[]>(resolve => {
                const request = db.transaction('previews').objectStore('previews').getAllKeys();
                request.onsuccess = () => resolve(request.result);
            });
            expect(keys).toHaveLength(1);
            expect(JSON.parse(String(keys[0]))[0]).toBe('other-account');
        } finally { db.close(); }
    });
    it('evicts the least recently used binary preview before exceeding 32 MiB', async () => {
        let now = 100;
        vi.spyOn(Date, 'now').mockImplementation(() => now++);
        for (let index = 0; index < 512; index++) await writeProjectCanvasPreviewCache(identity(index), bytes, signal());
        const db = await openDatabase();
        const flush = holdTouches();
        expect(await readProjectCanvasPreviewCache(identity(0), bytes.length, signal())).toEqual(bytes);
        await writeProjectCanvasPreviewCache(identity(512), bytes, signal());
        expect(await readProjectCanvasPreviewCache(identity(1), bytes.length, signal())).toBeUndefined();
        expect(await readProjectCanvasPreviewCache(identity(0), bytes.length, signal())).toEqual(bytes);
        expect(await readProjectCanvasPreviewCache(identity(512), bytes.length, signal())).toEqual(bytes);
        try {
            const rows = await flush(db);
            expect(rows).toHaveLength(512);
            expect(rows.reduce((sum, row) => sum + row.size, 0)).toBe(32 * 1024 * 1024);
        } finally { db.close(); }
    });

    it('includes pending touches when enforcing the 1024-entry LRU bound', async () => {
        let now = 100;
        vi.spyOn(Date, 'now').mockImplementation(() => now++);
        const small = bytes.slice(0, 4);
        const version = createHash('sha256').update(small).digest('hex');
        const item = (index: number) => ({ ...identity(index), previewVersionId: version });
        for (let index = 0; index < 1024; index++) await writeProjectCanvasPreviewCache(item(index), small, signal());
        const db = await openDatabase();
        const flush = holdTouches();
        try {
            expect(await readProjectCanvasPreviewCache(item(0), small.length, signal())).toEqual(small);
            await writeProjectCanvasPreviewCache(item(1024), small, signal());
            expect(await readProjectCanvasPreviewCache(item(1), small.length, signal())).toBeUndefined();
            expect(await readProjectCanvasPreviewCache(item(0), small.length, signal())).toEqual(small);
            const rows = await flush(db);
            expect(rows).toHaveLength(1024);
            expect(rows.some(row => row.key === keyFor(item(1024)))).toBe(true);
        } finally { db.close(); }
    });

    it('returns promptly from a blocked database so the caller can use RPC', async () => {
        vi.useFakeTimers();
        const opening = {} as IDBOpenDBRequest;
        vi.spyOn(indexedDB, 'open').mockReturnValue(opening);
        try {
            const reading = readProjectCanvasPreviewCache(identity(0), bytes.length, signal());
            await vi.advanceTimersByTimeAsync(1500);
            expect(await reading).toBeUndefined();
        } finally { vi.useRealTimers(); }
    });
});
