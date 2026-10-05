import { AIServiceClientError } from './types';
export interface StorageScope {
    appId: string;
    origin: string;
    subject: string;
    connectionId: string;
}
export interface StorageStatus {
    mode: 'session' | 'remember' | 'memory';
    warning: 'remember-unavailable' | 'session-unavailable' | null;
}
export type StorageInvalidation = 'forget' | 'logout' | 'revoke';
export interface ServiceStorage {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    putIfAbsent<T>(key: string, value: T): Promise<T>;
    remove(key: string): Promise<void>;
    clear(reason: StorageInvalidation): Promise<void>;
    remember?(enabled: boolean): Promise<StorageStatus>;
    getStatus(): StorageStatus;
    subscribe?(listener: (reason: StorageInvalidation) => void): () => void;
    dispose(): void;
}
/** Node hosts should supply a durable database implementation for platform outboxes. */
export function createMemoryServiceStorage(): ServiceStorage {
    const values = new Map<string, unknown>();
    return { async get<T>(key: string) { return values.has(key) ? structuredClone(values.get(key)) as T : null; }, async set(key, value) { values.set(key, structuredClone(value)); }, async putIfAbsent<T>(key: string, value: T) { if (!values.has(key))
            values.set(key, structuredClone(value)); return structuredClone(values.get(key)) as T; }, async remove(key) { values.delete(key); }, async clear() { values.clear(); }, getStatus: () => ({ mode: 'memory', warning: null }), dispose() { values.clear(); } };
}
export interface BrowserStorageOptions extends StorageScope {
    sessionStorage?: Storage;
    indexedDB?: IDBFactory | null;
    broadcastChannel?: typeof BroadcastChannel | null;
}
/** Secrets are accessible to same-origin scripts. Remember is opt-in; localStorage is never used. */
export function createBrowserServiceStorage(options: BrowserStorageOptions): ServiceStorage {
    const scope = [new URL(options.origin).origin, options.appId, options.subject];
    if (scope.some(x => !x) || !options.connectionId || scope[0] !== options.origin)
        throw new AIServiceClientError('invalid-request');
    const subjectPrefix = JSON.stringify(scope) + ':';
    const prefix = subjectPrefix + JSON.stringify(options.connectionId) + ':';
    let session: Storage | null = null;
    try {
        session = options.sessionStorage ?? globalThis.sessionStorage;
    }
    catch { /* visible memory fallback below */ }
    const memory = new Map<string, unknown>();
    let status: StorageStatus = { mode: session ? 'session' : 'memory', warning: session ? null : 'session-unavailable' };
    const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    const Channel = options.broadcastChannel === undefined ? globalThis.BroadcastChannel : options.broadcastChannel;
    const channel = Channel ? new Channel('paws-ai-services:' + subjectPrefix) : null;
    const listeners = new Set<(reason: StorageInvalidation) => void>();
    let persistentAvailable = Boolean(factory);
    let disposed = false, db: IDBDatabase | null = null;
    let queue = Promise.resolve();
    function assertOpen() { if (disposed)
        throw new AIServiceClientError('disposed'); }
    async function database() {
        if (db)
            return db;
        if (!factory)
            throw new Error('IndexedDB unavailable');
        db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open('paws-ai-services-v1', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('connections');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error('IndexedDB unavailable'));
            request.onblocked = () => reject(new Error('IndexedDB blocked'));
        });
        db.onversionchange = () => { db?.close(); db = null; };
        return db;
    }
    async function idb<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
        const databaseHandle = await database();
        return new Promise((resolve, reject) => {
            const tx = databaseHandle.transaction('connections', mode), request = action(tx.objectStore('connections'));
            tx.oncomplete = () => resolve(request.result);
            tx.onabort = tx.onerror = () => reject(new AIServiceClientError('storage-unavailable'));
        });
    }
    const sessionKeys = (start: string) => { const keys: string[] = []; if (session)
        for (let i = 0; i < session.length; i++) {
            const k = session.key(i);
            if (k?.startsWith(start))
                keys.push(k);
        } return keys; };
    const get = async <T>(key: string): Promise<T | null> => {
        assertOpen();
        try {
            // Read remembered material on refresh. Session data wins when remember has been disabled.
            const local = session?.getItem(prefix + key);
            if (local !== null && local !== undefined)
                return JSON.parse(local) as T;
            if (memory.has(key))
                return structuredClone(memory.get(key)) as T;
            if (persistentAvailable) {
                try {
                    const saved = await idb<T | undefined>('readonly', store => store.get(prefix + key));
                    if (saved !== undefined) {
                        status = { mode: 'remember', warning: null };
                        return saved;
                    }
                } catch {
                    if (status.mode === 'remember') throw new AIServiceClientError('storage-unavailable');
                    persistentAvailable = false;
                    status = { mode: session ? 'session' : 'memory', warning: 'remember-unavailable' };
                }
            }
            return null;
        }
        catch {
            throw new AIServiceClientError('storage-unavailable');
        }
    };
    async function write(key: string, value: unknown) {
        assertOpen();
        try {
            if (status.mode === 'remember')
                await idb('readwrite', s => s.put(value, prefix + key));
            else if (session)
                session.setItem(prefix + key, JSON.stringify(value));
            else
                memory.set(key, structuredClone(value));
        }
        catch {
            throw new AIServiceClientError('storage-unavailable');
        }
    }
    async function clearLocal(reason: StorageInvalidation) {
        const start = reason === 'logout' ? subjectPrefix : prefix;
        for (const key of sessionKeys(start))
            session!.removeItem(key);
        memory.clear();
        if (persistentAvailable) {
            const keys = await idb<IDBValidKey[]>('readonly', s => s.getAllKeys());
            for (const key of keys)
                if (typeof key === 'string' && key.startsWith(start))
                    await idb('readwrite', s => s.delete(key));
        }
    }
    function serial<T>(run: () => Promise<T>): Promise<T> { const task = queue.then(run); queue = task.then(() => undefined, () => undefined); return task; }
    channel?.addEventListener('message', onMessage);
    function onMessage(event: MessageEvent) {
        const value = event.data;
        if (!value || !['forget', 'logout', 'revoke'].includes(value.reason) || (value.reason !== 'logout' && value.connectionId !== options.connectionId))
            return;
        void serial(async () => { await clearLocal(value.reason); for (const listener of listeners)
            listener(value.reason); }).catch(() => { for (const listener of listeners)
            listener(value.reason); });
    }
    return {
        get: key => serial(() => get(key)), set: (key, value) => serial(() => write(key, value)),
        putIfAbsent: <T>(key: string, value: T) => serial(async () => {
            assertOpen();
            if (status.mode !== 'remember') {
                const existing = await get<T>(key);
                if (existing !== null)
                    return existing;
            }
            if (status.mode === 'remember') {
                const databaseHandle = await database();
                return new Promise<T>((resolve, reject) => {
                    const tx = databaseHandle.transaction('connections', 'readwrite'), store = tx.objectStore('connections'), request = store.get(prefix + key);
                    let result: T;
                    request.onsuccess = () => { result = request.result === undefined ? value : request.result; if (request.result === undefined)
                        store.put(value, prefix + key); };
                    tx.oncomplete = () => resolve(result);
                    tx.onabort = tx.onerror = () => reject(new AIServiceClientError('storage-unavailable'));
                });
            }
            await write(key, value);
            return structuredClone(value);
        }),
        remove: key => serial(async () => { assertOpen(); session?.removeItem(prefix + key); memory.delete(key); if (persistentAvailable)
            await idb('readwrite', s => s.delete(prefix + key)); }),
        clear: reason => serial(async () => { assertOpen(); await clearLocal(reason); channel?.postMessage({ reason, connectionId: options.connectionId }); for (const listener of listeners)
            listener(reason); }),
        remember: enabled => serial(async () => {
            assertOpen();
            if (enabled) {
                try {
                    persistentAvailable = Boolean(factory);
                    await database();
                    for (const key of sessionKeys(prefix)) {
                        const value = JSON.parse(session!.getItem(key)!);
                        await idb('readwrite', s => s.put(value, key));
                        session!.removeItem(key);
                    }
                    for (const [key, value] of memory)
                        await idb('readwrite', s => s.put(value, prefix + key));
                    memory.clear();
                    status = { mode: 'remember', warning: null };
                }
                catch {
                    persistentAvailable = false;
                    status = { mode: session ? 'session' : 'memory', warning: 'remember-unavailable' };
                }
            }
            else {
                if (factory) {
                    const keys = await idb<IDBValidKey[]>('readonly', s => s.getAllKeys());
                    for (const key of keys)
                        if (typeof key === 'string' && key.startsWith(prefix)) {
                            const value = await idb('readonly', s => s.get(key));
                            if (session)
                                session.setItem(key, JSON.stringify(value));
                            else
                                memory.set(key.slice(prefix.length), value);
                            await idb('readwrite', s => s.delete(key));
                        }
                }
                status = { mode: session ? 'session' : 'memory', warning: session ? null : 'session-unavailable' };
            }
            return { ...status };
        }),
        getStatus: () => ({ ...status }), subscribe: listener => { assertOpen(); listeners.add(listener); return () => listeners.delete(listener); },
        dispose() { disposed = true; channel?.removeEventListener('message', onMessage); channel?.close(); db?.close(); listeners.clear(); memory.clear(); },
    };
}
