import { describe, it, expect, vi } from 'vitest';
import { IDBFactory, IDBObjectStore, IDBDatabase } from 'fake-indexeddb';
import { createBrowserServiceStorage } from './storage';
class Session implements Storage {
    private values = new Map<string, string>();
    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    getItem(k: string) { return this.values.get(k) ?? null; }
    key(i: number) { return [...this.values.keys()][i] ?? null; }
    removeItem(k: string) { this.values.delete(k); }
    setItem(k: string, v: string) { this.values.set(k, v); }
}
const options = { appId: 'advisor', origin: 'https://app.test', subject: 'user', connectionId: 'personal' };
describe('scoped browser connection storage', () => {
    it('restores only the same origin, app, login subject and connection', async () => {
        const session = new Session();
        let a = createBrowserServiceStorage({ ...options, sessionStorage: session, indexedDB: null, broadcastChannel: null });
        await a.set('connection', { key: 'sensitive' });
        a.dispose();
        a = createBrowserServiceStorage({ ...options, sessionStorage: session, indexedDB: null, broadcastChannel: null });
        expect(await a.get('connection')).toEqual({ key: 'sensitive' });
        for (const change of [{ origin: 'https://other.test' }, { appId: 'other' }, { subject: 'another' }, { connectionId: 'another' }]) {
            const b = createBrowserServiceStorage({ ...options, ...change, sessionStorage: session, indexedDB: null, broadcastChannel: null });
            expect(await b.get('connection')).toBeNull();
            b.dispose();
        }
        a.dispose();
    });
    it('uses explicit remember, restores after refresh, atomically retains one envelope, and clears every connection on logout', async () => {
        const indexedDB = new IDBFactory(), session = new Session();
        const a = createBrowserServiceStorage({ ...options, sessionStorage: session, indexedDB, broadcastChannel: null });
        await a.set('connection', { key: 'sensitive' });
        expect(a.getStatus().mode).toBe('session');
        expect((await a.remember!(true)).mode).toBe('remember');
        a.dispose();
        const b = createBrowserServiceStorage({ ...options, sessionStorage: new Session(), indexedDB, broadcastChannel: null }), c = createBrowserServiceStorage({ ...options, sessionStorage: new Session(), indexedDB, broadcastChannel: null });
        expect(await b.get('connection')).toEqual({ key: 'sensitive' });
        await c.remember!(true);
        const entries = await Promise.all([b.putIfAbsent('outbox', { ciphertext: 'one' }), c.putIfAbsent('outbox', { ciphertext: 'two' })]);
        expect(entries[0]).toEqual(entries[1]);
        const other = createBrowserServiceStorage({ ...options, connectionId: 'second', sessionStorage: new Session(), indexedDB, broadcastChannel: null });
        await other.remember!(true);
        await other.set('connection', { key: 'second' });
        await b.clear('forget');
        expect(await b.get('connection')).toBeNull();
        expect(await other.get('connection')).toEqual({ key: 'second' });
        await b.clear('logout');
        expect(await other.get('connection')).toBeNull();
        b.dispose();
        c.dispose();
        other.dispose();
    });
    it('reports remember fallback and retains session material when IndexedDB is unavailable', async () => {
        const a = createBrowserServiceStorage({ ...options, sessionStorage: new Session(), indexedDB: null, broadcastChannel: null });
        expect(await a.remember!(true)).toEqual({ mode: 'session', warning: 'remember-unavailable' });
        await a.set('connection', { id: 'grant' });
        expect(await a.get('connection')).toEqual({ id: 'grant' });
        a.dispose();
    });
    it('broadcasts connection invalidation to other tabs and releases listeners', async () => {
        const a = createBrowserServiceStorage({ ...options, sessionStorage: new Session(), indexedDB: null }), b = createBrowserServiceStorage({ ...options, sessionStorage: new Session(), indexedDB: null });
        await b.set('connection', { key: 'secret' });
        const notified = new Promise<string>(resolve => b.subscribe!(resolve));
        await a.clear('revoke');
        expect(await notified).toBe('revoke');
        expect(await b.get('connection')).toBeNull();
        a.dispose();
        b.dispose();
    });
});
it('keeps default session connections usable when the browser denies IndexedDB access',async()=>{
 const denied={open(){throw new DOMException('denied','SecurityError');}} as unknown as IDBFactory;
 const storage=createBrowserServiceStorage({...options,sessionStorage:new Session(),indexedDB:denied,broadcastChannel:null});expect(await storage.get('connection')).toBeNull();await storage.set('connection',{id:'grant'});expect(await storage.get('connection')).toEqual({id:'grant'});expect(storage.getStatus()).toEqual({mode:'session',warning:'remember-unavailable'});storage.dispose();
});

it('disables remember in the session fallback without retrying denied IndexedDB', async () => {
    let attempts = 0;
    const denied = { open() { attempts++; throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory;
    const storage = createBrowserServiceStorage({ ...options, sessionStorage: new Session(), indexedDB: denied, broadcastChannel: null });
    try {
        expect(await storage.get('missing')).toBeNull();
        await storage.set('connection', { id: 'saved-grant' });
        expect(await storage.remember!(false)).toEqual({ mode: 'session', warning: 'remember-unavailable' });
        expect(await storage.get('connection')).toEqual({ id: 'saved-grant' });
        expect(attempts).toBe(1);
    } finally { storage.dispose(); }
});
it('reports a failure instead of claiming remembered material was migrated when it is inaccessible', async () => {
    const indexedDB = new IDBFactory(), storage = createBrowserServiceStorage({ ...options, sessionStorage: new Session(), indexedDB, broadcastChannel: null });
    try {
        await storage.set('connection', { id: 'remembered-grant' });
        await storage.remember!(true);
        const deny = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
        try {
            await expect(storage.remember!(false)).rejects.toMatchObject({ code: 'storage-unavailable' });
            expect(storage.getStatus().mode).toBe('remember');
        } finally { deny.mockRestore(); }
        expect(await storage.get('connection')).toEqual({ id: 'remembered-grant' });
    } finally { storage.dispose(); }
});
it.each(['session', 'memory'] as const)('retains all %s originals and rolls back every remembered entry if the second migration write aborts', async mode => {
    const indexedDB = new IDBFactory(), session = mode === 'session' ? new Session() : undefined;
    if (mode === 'memory') vi.stubGlobal('sessionStorage', undefined);
    const storage = createBrowserServiceStorage({ ...options, sessionStorage: session, indexedDB, broadcastChannel: null });
    let restored: ReturnType<typeof createBrowserServiceStorage> | undefined;
    try {
        await storage.set('connection', { id: 'original-grant', key: 'original-key' });
        await storage.set('outbox', { requestId: 'original-request', ciphertext: 'original-ciphertext' });
        const originalPut = IDBObjectStore.prototype.put;
        let writes = 0;
        const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
            const request = originalPut.call(this, value, key);
            if (++writes === 2) this.transaction.abort();
            return request;
        });
        try { expect(await storage.remember!(true)).toEqual({ mode, warning: 'remember-unavailable' }); }
        finally { fail.mockRestore(); }
        expect(await storage.get('connection')).toEqual({ id: 'original-grant', key: 'original-key' });
        expect(await storage.get('outbox')).toEqual({ requestId: 'original-request', ciphertext: 'original-ciphertext' });
        if (session) expect(session.length).toBe(2);
        restored = createBrowserServiceStorage({ ...options, sessionStorage: new Session(), indexedDB, broadcastChannel: null });
        expect(await restored.get('connection')).toBeNull();
        expect(await restored.get('outbox')).toBeNull();
        // Retry after access returns migrates both originals, then removes their session copies.
        expect((await storage.remember!(true)).mode).toBe('remember');
        expect(await restored.get('connection')).toEqual({ id: 'original-grant', key: 'original-key' });
        expect(await restored.get('outbox')).toEqual({ requestId: 'original-request', ciphertext: 'original-ciphertext' });
        if (session) expect(session.length).toBe(0);
    } finally { storage.dispose(); restored?.dispose(); vi.unstubAllGlobals(); }
});
