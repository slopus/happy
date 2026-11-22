import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect } from 'vitest';
import { WebStateDatabase } from './webStateDatabase';
const key = 'mmkv.default\\session-drafts';
function legacy(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
        getItem: (k: string) => data.get(k) ?? null, removeItem: (k: string) => { data.delete(k); },
        setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } };
}
describe('WebStateDatabase', () => {
    it('imports while localStorage is full, retains originals, and persists more than 5 MiB across reopen', async () => {
        const idb = new IDBFactory(), source = legacy({ [key]: '{"s":"draft"}' });
        const first = new WebStateDatabase(idb, source); await first.initialize();
        expect(first.get(key)).toBe('{"s":"draft"}');
        await first.write(key, 'x'.repeat(6 * 1024 * 1024));
        first.close();
        const second = new WebStateDatabase(idb, source); await second.initialize();
        expect(second.get(key)?.length).toBe(6 * 1024 * 1024);
        expect(source.getItem(key)).toBe('{"s":"draft"}');
    });
    it('does not resurrect a deleted record from the retained legacy source', async () => {
        const idb = new IDBFactory(), source = legacy({ [key]: 'old' });
        const first = new WebStateDatabase(idb, source); await first.initialize(); await first.write(key, null); first.close();
        const second = new WebStateDatabase(idb, source); await second.initialize();
        expect(second.get(key)).toBeUndefined();
    });
    it('keeps changed legacy queues in recovery rather than authorizing replay', async () => {
        const idb = new IDBFactory(); let value = 'old';
        const source = { ...legacy(), length: 1, key: () => key, getItem: () => value };
        const first = new WebStateDatabase(idb, source); await first.initialize(); await first.write(key, null); first.close();
        value = 'changed-by-old-tab';
        const second = new WebStateDatabase(idb, source); await second.initialize();
        expect(second.get(key)).toBeUndefined();
        expect((await second.exportRecovery()).legacyChanges[0].value).toBe(value);
    });
    it('rejects stale cross-tab writes and retains both committed and conflicting content', async () => {
        const idb = new IDBFactory(), source = legacy();
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize();
        await a.write(key, 'first');
        await expect(b.write(key, 'second')).rejects.toMatchObject({ name: 'StorageConflictError' });
        expect((await b.exportRecovery()).conflicts[0].value).toBe('second');
        await b.refresh(); expect(b.get(key)).toBe('first');
    });
    it('purges a namespace with tombstones and fences stale writers', async () => {
        const idb = new IDBFactory(), source = legacy({ [key]: 'old' });
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize(); await a.purgePrefix('mmkv.default\\');
        await expect(b.write(key, 'late')).rejects.toMatchObject({ name: 'StorageConflictError' });
        const c = new WebStateDatabase(idb, source); await c.initialize(); expect(c.get(key)).toBeUndefined();
    });
    it('removes only safely rebuildable localStorage cache keys after importing them', async () => {
        const warm = 'session-warm-cache\\encrypted-wire-v1';
        const source = legacy({ [key]: 'draft', [warm]: 'cache', 'paws.accounts.active': 'account' });
        const db = new WebStateDatabase(new IDBFactory(), source); await db.initialize();
        expect(source.getItem(key)).toBe('draft'); expect(source.getItem('paws.accounts.active')).toBe('account');
        expect(source.getItem(warm)).toBeNull();
    });
});

describe('legacy dispatch safety', () => {
    it('quarantines imported queued messages because copying does not prove the previous owner never sent them', async () => {
        const key = 'message-staging-tab\\queue-v1';
        const source = legacy({ [key]: JSON.stringify({ messages: [{ id: 'm', status: 'queued' }], barriers: {} }) });
        const db = new WebStateDatabase(new IDBFactory(), source); await db.initialize();
        expect(JSON.parse(db.get(key)!).messages[0]).toMatchObject({ id: 'm', status: 'failed', deliveryUncertain: true });
    });
});

describe('scope deletion fence', () => {
    it('rejects a new key from a tab loaded before another tab purged the namespace', async () => {
        const idb = new IDBFactory(), source = legacy();
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize(); await a.purgePrefix('mmkv.default\\');
        await expect(b.write('mmkv.default\\new-draft', 'late')).rejects.toMatchObject({ name: 'StorageConflictError' });
    });
});

describe('per-record revision isolation', () => {
    it('does not advance another record revision when this tab writes unrelated state', async () => {
        const idb = new IDBFactory(), source = legacy({ [key]: 'original' });
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize(); await a.write(key, 'other tab edit');
        await b.write('mmkv.default\\unrelated', 'navigation');
        await expect(b.write(key, 'stale local edit')).rejects.toMatchObject({ name: 'StorageConflictError' });
    });
});

describe('account revocation and recovery privacy', () => {
    it('does not reimport new legacy keys after namespace clear and erases retained source bodies', async () => {
        const idb = new IDBFactory();
        const data = new Map([[key, JSON.stringify({ text: 'private draft' })]]);
        const source = { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
            getItem: (k: string) => data.get(k) ?? null, removeItem: (k: string) => { data.delete(k); } };
        const a = new WebStateDatabase(idb, source); await a.initialize(); await a.purgePrefix('mmkv.default\\');
        expect(JSON.stringify(await a.exportRecovery())).not.toContain('private draft');
        data.set('mmkv.default\\file-workspace-drafts:new', '{"late":"old client"}');
        const b = new WebStateDatabase(idb, source); await b.initialize();
        expect(b.get('mmkv.default\\file-workspace-drafts:new')).toBeUndefined();
        expect(JSON.stringify(await b.exportRecovery())).not.toContain('old client');
    });
    it('fences namespaces created by a stale account runtime after logout', async () => {
        const idb = new IDBFactory(), source = legacy();
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize(); await a.purgeAccount('scope-a');
        await expect(b.write('message-staging-new-account-scope-a\\queue-v1', 'late')).rejects.toMatchObject({ name: 'StorageConflictError' });
        await b.write('default-account-scope-b\\session-drafts', 'other account is unaffected');
        expect(b.get('default-account-scope-b\\session-drafts')).toBe('other account is unaffected');
    });
});

describe('bounded rebuildable caches', () => {
    it('evicts cache rows without deleting user drafts', async () => {
        const db = new WebStateDatabase(new IDBFactory(), legacy(), 'budget-test', 16);
        await db.initialize(); await db.write(key, 'user draft');
        await db.write('session-warm-cache\\a', '1234567890');
        await db.write('session-warm-cache\\b', 'abcdefghij');
        expect(db.get(key)).toBe('user draft');
        expect(db.get('session-warm-cache\\a')).toBeUndefined();
        expect(db.get('session-warm-cache\\b')).toBe('abcdefghij');
    });
});

describe('revoked writes never repopulate recovery bodies', () => {
    it('rejects a stale account write without saving it as a conflict copy', async () => {
        const idb = new IDBFactory(), source = legacy();
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize(); await a.purgeAccount('owner');
        await expect(b.write('default-account-owner\\draft', 'private late text')).rejects.toMatchObject({ name: 'StorageConflictError' });
        expect(JSON.stringify(await a.exportRecovery())).not.toContain('private late text');
    });
    it('rejects a stale exact-key write without persisting its cleared recovery content', async () => {
        const idb = new IDBFactory(), source = legacy();
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize(); await a.purgeExact('first-submission-v1\\account');
        await expect(b.write('first-submission-v1\\account', 'private recovery')).rejects.toMatchObject({ name: 'StorageConflictError' });
        expect(JSON.stringify(await a.exportRecovery())).not.toContain('private recovery');
    });
});

describe('real multi-tab boot convergence', () => {
    it('atomically unions queue namespaces created from the same initial revision', async () => {
        const idb = new IDBFactory(), source = legacy();
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize();
        const index = 'message-staging-index\\namespaces';
        await Promise.all([a.write(index, '[]', { addString: 'tab-a' }), b.write(index, '[]', { addString: 'tab-b' })]);
        const c = new WebStateDatabase(idb, source); await c.initialize();
        expect(JSON.parse(c.get(index)!)).toEqual(['tab-a', 'tab-b']);
        expect((await c.exportRecovery()).conflicts).toHaveLength(0);
    });
    it('accepts a stale identical authoritative snapshot without creating a user conflict', async () => {
        const idb = new IDBFactory(), source = legacy();
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize();
        await a.write('mmkv.default\\settings', '{"settings":{},"version":2}');
        await expect(b.write('mmkv.default\\settings', '{"settings":{},"version":2}')).resolves.toBeUndefined();
        expect((await b.exportRecovery()).conflicts).toHaveLength(0);
    });
    it('drops a stale optional cache without retaining an unnecessary conflict copy', async () => {
        const idb = new IDBFactory(), source = legacy();
        const a = new WebStateDatabase(idb, source), b = new WebStateDatabase(idb, source);
        await a.initialize(); await b.initialize();
        await a.write('session-warm-cache\\encrypted-wire-v1', 'newer');
        await expect(b.write('session-warm-cache\\encrypted-wire-v1', 'older')).resolves.toBeUndefined();
        expect((await b.exportRecovery()).conflicts).toHaveLength(0);
        expect(b.get('session-warm-cache\\encrypted-wire-v1')).toBe('newer');
    });
});
