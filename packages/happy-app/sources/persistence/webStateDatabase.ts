/** Web-only engine, independent of React and authentication module evaluation. */
type Row = { key: string; value: string | null; revision: number; bytes: number; touchedAt: number; cache: boolean };
type Source = Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>;
export class StorageConflictError extends Error { name = 'StorageConflictError'; }
export const isRebuildableWebKey = (key: string) => /^(session-warm-cache|session-history-pages-v1)(-account-[^\\]+)?\\/.test(key)
    || /\\project-workspace-cache-v1$/.test(key);
// Preserve existing physical namespace: importing another account never adopts it.
export const isMigratableWebKey = (key: string) => /^(mmkv.default|default(?:-account-[^\\]+|-signed-out)|compose-draft(?:-account-[^\\]+|-signed-out)?|message-staging-(?:index|[^\\]+)|public-session-share-queue[^\\]*|session-warm-cache[^\\]*|session-history-pages[^\\]*|session-continuations[^\\]*|cross-agent-continuations[^\\]*|first-submission-v1|changelog[^\\]*)\\/.test(key)
    || key.startsWith('first-submission-v1:');
const complete = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
    tx.onerror = () => { /* onabort is the authoritative failure */ };
});
const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const bytes = (value: string | null) => value === null ? 0 : new TextEncoder().encode(value).byteLength;

export class WebStateDatabase {
    private db?: IDBDatabase;
    private rows = new Map<string, Row>();
    private tail: Promise<unknown> = Promise.resolve();
    private revokedAccounts = new Set<string>();
    private epochKey(key: string) { return '@epoch:' + key.split('\\')[0]; }
    private accountEpochKey(key: string) {
        const namespace = key.split('\\')[0];
        return '@account-epoch:' + (namespace === 'first-submission-v1' ? 'first-submission' : namespace.match(/-account-(.+)$/)?.[1] ?? 'legacy');
    }
    constructor(private factory: IDBFactory, private source: Source, private name = 'paws-web-state-v1', private budget = 32 * 1024 * 1024) {}
    async initialize() {
        const request = this.factory.open(this.name, 1);
        this.db = await new Promise<IDBDatabase>((resolve, reject) => {
            let expired = false;
            const timeout = setTimeout(() => { expired = true; reject(new Error('Storage open timed out; close other Paws tabs and retry')); }, 10_000);
            request.onupgradeneeded = () => {
                for (const name of ['records', 'migrations', 'legacyChanges', 'conflicts']) request.result.createObjectStore(name, { keyPath: 'key' });
            };
            request.onsuccess = () => { clearTimeout(timeout); if (expired) request.result.close(); else resolve(request.result); };
            request.onerror = () => { clearTimeout(timeout); reject(request.error); };
            // blocked remains bounded by the one-shot timeout; no open retry loop.
        });
        this.db.onversionchange = () => this.close();
        await this.importLegacy();
        await this.refresh();
    }
    private connection() { if (!this.db) throw new Error('Storage not ready'); return this.db; }
    get(key: string) { return this.rows.get(key)?.value ?? undefined; }
    keys() { return [...this.rows.values()].filter(row => row.value !== null).map(row => row.key); }
    async refresh() {
        await this.tail;
        const tx = this.connection().transaction('records', 'readonly'), done = complete(tx);
        const rows = await requestValue<Row[]>(tx.objectStore('records').getAll()); await done;
        this.rows = new Map(rows.map(row => [row.key, row]));
    }
    private async importLegacy() {
        const keys = Array.from({ length: this.source.length }, (_, i) => this.source.key(i)).filter((key): key is string => !!key && isMigratableWebKey(key));
        for (const key of keys) {
            const value = this.source.getItem(key); if (value === null) continue;
            const destination = key.startsWith('first-submission-v1:') ? `first-submission-v1\\${key.slice('first-submission-v1:'.length)}` : key;
            const tx = this.connection().transaction(['records', 'migrations', 'legacyChanges'], 'readwrite'), done = complete(tx);
            const records = tx.objectStore('records'), migrations = tx.objectStore('migrations');
            const accountEpoch = records.get(this.accountEpochKey(destination));
            const namespaceEpoch = records.get(this.epochKey(destination));
            const marker = migrations.get(key);
            marker.onsuccess = () => {
                if (accountEpoch.result || namespaceEpoch.result || marker.result?.retired) {
                    migrations.put({ key, retired: true }); return;
                }
                if (marker.result) {
                    if (marker.result.sourceValue !== value) tx.objectStore('legacyChanges').put({ key, value, observedAt: Date.now() });
                    return;
                }
                const existing = records.get(destination);
                existing.onsuccess = () => {
                    if (existing.result?.value === null) { migrations.put({ key, retired: true }); return; }
                    let imported = value;
                    // An imported snapshot can predate an old owner's last send.
                    // Copying it never authorizes automatic replay.
                    try {
                        if (/\\(local-settings|settings|pending-settings|profile|purchases|session-drafts|new-session-draft-v1|project-workspace-cache-v1|project-library-v1|file-workspace-drafts:.*|file-workspace-v1:.*|message-annotation-v1:.*)$/.test(key)) JSON.parse(value);
                        if (key.endsWith('\\queue-v1')) {
                            const queue = JSON.parse(value);
                            if (!Array.isArray(queue.messages)) throw new Error('Invalid legacy queue');
                            imported = JSON.stringify({ ...queue, messages: queue.messages.map((m: any) => ({ ...m, status: 'failed', deliveryUncertain: true })) });
                        } else if (key.endsWith('\\jobs-v1') && key.startsWith('public-session-share-queue')) {
                            imported = JSON.stringify(JSON.parse(value).map((job: any) => ['queued', 'running'].includes(job.status)
                                ? { ...job, status: 'failed', error: 'publication-result-unknown', notificationPending: false } : job));
                        }
                    } catch {
                        tx.objectStore('legacyChanges').put({ key, value, reason: 'corrupt', observedAt: Date.now() });
                        migrations.put({ key, sourceValue: value, importedAt: Date.now(), corrupt: true });
                        return;
                    }
                    if (!existing.result) records.put({ key: destination, value: imported, revision: 1, bytes: bytes(imported), touchedAt: Date.now(), cache: isRebuildableWebKey(key) } satisfies Row);
                    migrations.put({ key, sourceValue: value, importedAt: Date.now() });
                };
            };
            await done;
            // Only rebuildable caches may be discarded. Never remove critical legacy records.
            if (isRebuildableWebKey(key)) { try { if (this.source.getItem(key) === value) this.source.removeItem(key); } catch { /* optional cleanup */ } }
        }
    }
    write(key: string, value: string | null, options?: { addString: string }): Promise<void> {
        const apply = async () => {
            if (this.revokedAccounts.has(this.accountEpochKey(key))) throw new StorageConflictError('Account storage was cleared; reload required');
            let expected = this.rows.get(key)?.revision ?? 0;
            let conflicted = false;
            const tx = this.connection().transaction(['records', 'conflicts'], 'readwrite'), done = complete(tx);
            const store = tx.objectStore('records');
            const epochKey = this.epochKey(key), epoch = store.get(epochKey);
            const accountKey = this.accountEpochKey(key), accountEpoch = store.get(accountKey);
            const recordEpochKey = `@record-epoch:${key}`, recordEpoch = store.get(recordEpochKey), request = store.get(key);
            const expectedEpoch = this.rows.get(epochKey)?.revision ?? 0;
            const expectedAccountEpoch = this.rows.get(accountKey)?.revision ?? 0;
            const expectedRecordEpoch = this.rows.get(recordEpochKey)?.revision ?? 0;
            let row: Row;
            const changed = new Map<string, Row>();
            request.onsuccess = () => {
                if ((epoch.result?.revision ?? 0) !== expectedEpoch || (accountEpoch.result?.revision ?? 0) !== expectedAccountEpoch || (recordEpoch.result?.revision ?? 0) !== expectedRecordEpoch) {
                    conflicted = true; return; // Revocation must not retain a new copy of cleared private content.
                }
                if (options) {
                    try {
                        const previous: unknown = JSON.parse(request.result?.value ?? '[]');
                        if (!Array.isArray(previous) || previous.some(item => typeof item !== 'string')) throw new Error('Invalid namespace index');
                        value = JSON.stringify([...new Set([...previous, options.addString])]);
                        expected = request.result?.revision ?? 0;
                    } catch { tx.abort(); return; }
                }
                const equivalent = () => {
                    if (request.result?.value === value) return true;
                    // These timestamps describe local observation/autosave, not user edits.
                    const ignored = key.endsWith('\\profile') ? 'timestamp' : key.endsWith('\\new-session-draft-v1') ? 'updatedAt' : null;
                    if (!ignored || !request.result?.value || value === null) return false;
                    try {
                        const previous = JSON.parse(request.result.value), next = JSON.parse(value);
                        delete previous[ignored]; delete next[ignored];
                        return JSON.stringify(previous) === JSON.stringify(next);
                    } catch { return false; }
                };
                // Re-saving an unchanged snapshot is not a mutation, including
                // when this runtime already owns the current revision. Keep the
                // existing tombstone/revision so other tabs see only real edits.
                if (equivalent() || ((request.result?.revision ?? 0) !== expected && isRebuildableWebKey(key))) {
                    if (request.result) changed.set(key, request.result);
                    return;
                }
                if ((request.result?.revision ?? 0) !== expected) {
                    conflicted = true;
                    tx.objectStore('conflicts').put({ key: `${key}:${Date.now()}:${Math.random()}`, sourceKey: key, value });
                    return;
                }
                row = { key, value, revision: expected + 1, bytes: bytes(value), touchedAt: Date.now(), cache: isRebuildableWebKey(key) };
                if (row.cache && row.bytes > 2 * 1024 * 1024) { row.value = null; row.bytes = 0; }
                store.put(row); changed.set(key, row);
                const all = store.getAll();
                all.onsuccess = () => {
                    const caches: Row[] = all.result.filter((r: Row) => r.cache && r.value !== null).sort((a: Row, b: Row) => a.touchedAt - b.touchedAt);
                    let total = caches.reduce((sum, r) => sum + r.bytes, 0);
                    for (const cached of caches) {
                        if (total <= this.budget) break;
                        total -= cached.bytes; const evicted = { ...cached, value: null, bytes: 0, revision: cached.revision + 1 }; store.put(evicted); changed.set(cached.key, evicted);
                    }
                };
            };
            await done;
            if (conflicted) throw new StorageConflictError('Another tab changed this record. Local content is retained for recovery.');
            // Only advance revisions for mutations this runtime actually applied.
            // Refreshing unrelated rows would hide stale application-state conflicts.
            for (const [changedKey, committed] of changed) this.rows.set(changedKey, committed);
        };
        const operation = this.tail.then(async () => {
            try { await apply(); } catch (error) {
                if (!(error instanceof Error) || error.name !== 'QuotaExceededError') throw error;
                await this.clearCaches();
                await apply(); // one retry only, never a loop
            }
        });
        this.tail = operation.catch(() => {});
        return operation;
    }
    clearOptionalCaches(): Promise<void> {
        const operation = this.tail.then(() => this.clearCaches());
        this.tail = operation.catch(() => {}); return operation;
    }
    async clearCaches() {
        const changed = new Map<string, Row>();
        const tx = this.connection().transaction('records', 'readwrite'), done = complete(tx), store = tx.objectStore('records');
        const cursor = store.openCursor(); cursor.onsuccess = () => {
            const current = cursor.result; if (!current) return;
            const row = current.value as Row;
            if (row.cache && row.value !== null) {
                const removed = { ...row, value: null, bytes: 0, revision: row.revision + 1 };
                current.update(removed); changed.set(row.key, removed);
            }
            current.continue();
        };
        await done;
        for (const [key, row] of changed) this.rows.set(key, row);
    }
    async hasExternalChanges(): Promise<boolean> {
        await this.tail;
        const tx = this.connection().transaction('records', 'readonly'), done = complete(tx);
        const rows = await requestValue<Row[]>(tx.objectStore('records').getAll()); await done;
        return rows.some(row => !row.cache && row.revision !== (this.rows.get(row.key)?.revision ?? 0));
    }
    async authoritativeKeys(): Promise<string[]> {
        await this.tail;
        const tx = this.connection().transaction('records', 'readonly'), done = complete(tx);
        const keys = await requestValue<IDBValidKey[]>(tx.objectStore('records').getAllKeys()); await done;
        return keys.filter((key): key is string => typeof key === 'string' && !key.startsWith('@'));
    }
    purgeExact(key: string): Promise<void> { return this.purge(candidate => candidate === key, `@record-epoch:${key}`); }
    purgePrefix(prefix: string): Promise<void> { return this.purge(key => key.startsWith(prefix), this.epochKey(prefix)); }
    purgeAccount(scope: string): Promise<void> {
        this.revokedAccounts.add(`@account-epoch:${scope}`);
        return this.purge(key => this.accountEpochKey(key) === `@account-epoch:${scope}`, `@account-epoch:${scope}`);
    }
    private purge(matches: (key: string) => boolean, epochKey: string): Promise<void> {
        const operation = this.tail.then(async () => {
            const changed = new Map<string, Row>();
            const names = ['records', 'migrations', 'legacyChanges', 'conflicts'];
            const tx = this.connection().transaction(names, 'readwrite'), done = complete(tx), store = tx.objectStore('records');
            const epoch = store.get(epochKey);
            epoch.onsuccess = () => {
                const row: Row = { key: epochKey, value: null, revision: (epoch.result?.revision ?? 0) + 1, bytes: 0, touchedAt: Date.now(), cache: false };
                store.put(row); changed.set(epochKey, row);
                if (epochKey.startsWith('@record-epoch:')) {
                    const key = epochKey.slice('@record-epoch:'.length), existing = store.get(key);
                    existing.onsuccess = () => {
                        const removed: Row = { key, value: null, revision: (existing.result?.revision ?? 0) + 1, bytes: 0, touchedAt: Date.now(), cache: false };
                        store.put(removed); changed.set(key, removed);
                    };
                }
            };
            for (const name of names) {
                const cursor = tx.objectStore(name).openCursor();
                cursor.onsuccess = () => {
                    const current = cursor.result; if (!current) return;
                    const value = current.value;
                    const sourceKey = value.sourceKey ?? value.key;
                    const normalized = sourceKey.startsWith('first-submission-v1:') ? `first-submission-v1\\${sourceKey.slice('first-submission-v1:'.length)}` : sourceKey;
                    if (!sourceKey.startsWith('@') && matches(normalized)) {
                        if (name === 'records') {
                            const row: Row = { ...value, value: null, revision: value.revision + 1, bytes: 0 };
                            current.update(row); changed.set(row.key, row);
                        } else if (name === 'migrations') current.update({ key: value.key, retired: true });
                        else current.delete();
                    }
                    current.continue();
                };
            }
            await done;
            for (const [key, row] of changed) this.rows.set(key, row);
            // Explicit logout/clear authorizes removing this namespace's old
            // originals. Retirement fences prevent old tabs from importing again.
            const oldKeys = Array.from({ length: this.source.length }, (_, i) => this.source.key(i)).filter((key): key is string => !!key);
            for (const key of oldKeys) {
                const normalized = key.startsWith('first-submission-v1:') ? `first-submission-v1\\${key.slice('first-submission-v1:'.length)}` : key;
                if (isMigratableWebKey(key) && matches(normalized)) this.source.removeItem(key);
            }
        });
        this.tail = operation.catch(() => {}); return operation;
    }
    async exportRecovery() {
        await this.tail;
        const tx = this.connection().transaction(['records', 'legacyChanges', 'conflicts', 'migrations'], 'readonly'), done = complete(tx);
        const [records, legacyChanges, conflicts, migrations] = await Promise.all(['records', 'legacyChanges', 'conflicts', 'migrations'].map(name => requestValue<any[]>(tx.objectStore(name).getAll())));
        await done; return { version: 1, records, legacyChanges, conflicts, migrations };
    }
    close() { this.db?.close(); this.db = undefined; }
}
