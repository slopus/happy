import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
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
