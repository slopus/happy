import { WebStateDatabase, StorageConflictError, isRebuildableWebKey } from './webStateDatabase';
let database: WebStateDatabase | undefined;
let initializing: Promise<void> | undefined;
const pending = new Map<string, Promise<void>>();
const failed = new Map<string, { value: string | null; error: unknown }>();
const optimistic = new Map<string, string | null>();
const scheduledDrafts = new Map<object, () => void>();
// Persistence state is diagnostic data, not a global page notification. Routine
// autosaves must not change the application layout or ask users to export data.
export const getWebStorageStatus = () => ({
    pending: pending.size + scheduledDrafts.size,
    failed: failed.size,
    conflict: [...failed.values()].some(e => e.error instanceof StorageConflictError),
});
export async function initializeWebStorage() {
    initializing ??= (async () => {
        const db = new WebStateDatabase(indexedDB, localStorage);
        try { await db.initialize(); } catch (error) { db.close(); throw error; }
        database = db;
        if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
            if (scheduledDrafts.size || [...pending.keys()].some(key => !isRebuildableWebKey(key)) || failed.size) {
                event.preventDefault(); event.returnValue = '';
            }
        });
    })().catch(error => { initializing = undefined; throw error; });
    return initializing;
}
function currentDatabase() { if (!database) throw new Error('Browser storage is not initialized'); return database; }
function persist(key: string, value: string | null) {
    optimistic.set(key, value);
    const clearing = key.endsWith('\\@clear');
    const prefix = clearing ? key.slice(0, -'@clear'.length) : undefined;
    const operation = clearing ? currentDatabase().purgePrefix(prefix!) : currentDatabase().write(key, value);
    pending.set(key, operation);
    void operation.then(() => {
        if (pending.get(key) === operation) {
            pending.delete(key); optimistic.delete(key); failed.delete(key);
            if (prefix) for (const k of optimistic.keys()) if (k.startsWith(prefix) && !pending.has(k)) { optimistic.delete(k); failed.delete(k); }
        }
    }, error => {
        if (pending.get(key) === operation) {
            pending.delete(key);
            if (isRebuildableWebKey(key)) optimistic.delete(key);
            else failed.set(key, { value, error });
        }
    });
    return operation;
}
/** Synchronous hydrated reads for selectors; set is an observed draft write,
 * NOT a durable completion receipt. Network side effects must await flush. */
export class MMKV {
    readonly id: string;
    constructor(config?: { id?: string }) { this.id = config?.id ?? 'mmkv.default'; }
    private key(key: string) { if (key.includes('\\')) throw new Error('Invalid storage key'); return `${this.id}\\${key}`; }
    getString(key: string) { const full = this.key(key); return (optimistic.has(full) ? optimistic.get(full) : currentDatabase().get(full)) ?? undefined; }
    getBoolean(key: string) { const value = this.getString(key); return value === undefined ? undefined : value === 'true'; }
    getNumber(key: string) { const value = this.getString(key); return value === undefined ? undefined : Number(value); }
    contains(key: string) { return this.getString(key) !== undefined; }
    set(key: string, value: string | number | boolean) { void persist(this.key(key), String(value)); }
    delete(key: string) { void persist(this.key(key), null); }
    getAllKeys() {
        return [...new Set([...currentDatabase().keys(), ...optimistic.keys()])].filter(key => key.startsWith(`${this.id}\\`) && this.getString(key.slice(this.id.length + 1)) !== undefined).map(key => key.slice(this.id.length + 1));
    }
    clearAll() {
        for (const key of this.getAllKeys()) optimistic.set(this.key(key), null);
        void persist(`${this.id}\\@clear`, null);
    }
    get size() { return this.getAllKeys().reduce((sum, key) => sum + new TextEncoder().encode(this.getString(key) ?? '').length, 0); }
}
export async function flushDeviceStorageWrites(store?: MMKV) {
    if (!store) for (const flush of [...scheduledDrafts.values()]) flush();
    const matches = (key: string) => !store || key.startsWith(`${store.id}\\`);
    await Promise.all([...pending].filter(([key]) => matches(key) && !isRebuildableWebKey(key)).map(([, promise]) => promise));
    const error = [...failed].find(([key]) => matches(key)); if (error) throw error[1].error;
}
export async function writeDeviceStorage(store: MMKV, key: string, value: string) { store.set(key, value); await flushDeviceStorageWrites(store); }
export async function retryWebStorageWrites() {
    const writes = [...failed].filter(([, record]) => !(record.error instanceof StorageConflictError));
    await Promise.all(writes.map(([key, record]) => persist(key, record.value)));
}
export async function listDeviceStorageIds(prefix: string, suffix: string): Promise<string[]> {
    const keys = await currentDatabase().authoritativeKeys();
    return [...new Set(keys.map(key => key.split('\\')[0]).filter(id => id.startsWith(prefix) && (suffix ? id.endsWith(suffix) : !id.includes('-account-'))))];
}
export async function purgeAccountDeviceStorage(scope: string): Promise<void> {
    await flushDeviceStorageWrites(); await currentDatabase().purgeAccount(scope);
    for (const key of optimistic.keys()) if ((key.split('\\')[0].match(/-account-(.+)$/)?.[1] ?? 'legacy') === scope) { optimistic.delete(key); failed.delete(key); }
}

export async function eraseDeviceStorageRecord(store: MMKV, key: string): Promise<void> {
    await flushDeviceStorageWrites(store); await currentDatabase().purgeExact(`${store.id}\\${key}`);
}

export async function webStorageDiagnostics() {
    const report = await currentDatabase().exportRecovery();
    const visible = report.records.filter(row => !row.key.startsWith('@') && row.value !== null);
    let localBytes = 0;
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key) localBytes += new TextEncoder().encode(localStorage.getItem(key) ?? '').length; }
    return { indexedDbRecords: visible.length, indexedDbEstimatedBytes: visible.reduce((sum, row) => sum + row.bytes, 0),
        rebuildableCacheEstimatedBytes: visible.filter(row => row.cache).reduce((sum, row) => sum + row.bytes, 0),
        localStorageKeys: localStorage.length, localStorageEstimatedBytes: localBytes,
        migrationRecords: report.migrations.length, recoveryRecords: report.conflicts.length + report.legacyChanges.length,
        ...getWebStorageStatus() };
}
export async function clearWebStorageCaches() { await currentDatabase().clearOptionalCaches(); }

export async function addDeviceStorageString(store: MMKV, key: string, value: string): Promise<void> {
    await currentDatabase().write(`${store.id}\\${key}`, '[]', { addString: value });
}

export function markDeviceStorageDraftPending(owner: object, pending: boolean, flush?: () => void): void {
    if (pending && flush) scheduledDrafts.set(owner, flush);
    else scheduledDrafts.delete(owner);
}
