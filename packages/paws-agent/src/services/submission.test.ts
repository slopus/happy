import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { beginSubmission } from './submission';
import { AIServiceClientError } from './types';
import { createMemoryServiceStorage, createBrowserServiceStorage, type ServiceStorage } from './storage';
import { createNodePlatformTransport } from './nodePlatformTransport';
import { createBrowserPersonalTransport } from './personalTransport';
import { createBrowserPlatformTransport } from './platformTransport';
import { binding, fixture, makeReceipt } from './testFixtures';

class Session implements Storage {
    private values = new Map<string, string>();
    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    getItem(key: string) { return this.values.get(key) ?? null; }
    key(index: number) { return [...this.values.keys()][index] ?? null; }
    removeItem(key: string) { this.values.delete(key); }
    setItem(key: string, value: string) { this.values.set(key, value); }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
async function sharedStores(mode: 'memory' | 'session' | 'remember'): Promise<[ServiceStorage, ServiceStorage]> {
    if (mode === 'memory') { const store = createMemoryServiceStorage(); return [{ ...store }, { ...store }]; }
    const session = new Session(), indexedDB = new IDBFactory();
    const options = { appId: 'advisor', origin: 'https://app.test', subject: 'subject', connectionId: 'shared', sessionStorage: session, indexedDB, broadcastChannel: null };
    const stores: [ServiceStorage, ServiceStorage] = [createBrowserServiceStorage(options), createBrowserServiceStorage(options)];
    if (mode === 'remember') { await stores[0].remember!(true); await stores[1].remember!(true); }
    return stores;
}
for (const mode of ['memory', 'session', 'remember'] as const) describe(`immutable admission outcome in shared ${mode} storage`, () => {
    it('atomically retains one owner across separate handles', async () => {
        const [a, b] = await sharedStores(mode);
        try {
            const owners = await Promise.all([a.putIfAbsent('owner', 'a'), b.putIfAbsent('owner', 'b')]);
            expect(owners[0]).toBe(owners[1]);
        } finally { a.dispose(); b.dispose(); }
    });
    it('prevents a contender from posting after the owner commits rejection', async () => {
        const [a, b] = await sharedStores(mode);
        try {
            const first = await beginSubmission(a, 'outbox', { admissionOwner: 'first' }, 'first', 'request');
            expect((await first.failure(new AIServiceClientError('model-unavailable', false, 'request', 'not-submitted'))).submission).toBe('not-submitted');
            await expect(beginSubmission(b, 'outbox', { admissionOwner: 'first' }, 'second', 'request')).rejects.toMatchObject({ code: 'model-unavailable', submission: 'not-submitted' });
        } finally { a.dispose(); b.dispose(); }
    });
    it('permanently forbids refusal certainty once a contender can post, in either response order', async () => {
        const [a, b] = await sharedStores(mode);
        try {
            const first = await beginSubmission(a, 'outbox', { admissionOwner: 'first' }, 'first', 'request');
            const second = await beginSubmission(b, 'outbox', { admissionOwner: 'first' }, 'second', 'request');
            expect((await first.failure(new AIServiceClientError('model-unavailable', false, 'request', 'not-submitted'))).submission).toBe('uncertain');
            expect((await second.failure(new AIServiceClientError('transport-error', true, 'request'))).submission).toBe('uncertain');
            const retry = await beginSubmission(a, 'outbox', { admissionOwner: 'first' }, 'retry', 'request');
            expect((await retry.failure(new AIServiceClientError('authorization-revoked', false, 'request', 'not-submitted'))).submission).toBe('uncertain');
        } finally { a.dispose(); b.dispose(); }
    });
});
for (const source of ['node', 'personal', 'platform'] as const) for (const order of ['accepted-first', 'refusing-creator'] as const) {
    it(`${source}: two transport instances preserve shared request after ${order}`, async () => {
        const base = createMemoryServiceStorage(), absent = deferred(), contenderAccepted = deferred();
        let initialReads = 0, posts = 0, accepted = 0;
        const bodies: Record<string, unknown>[] = [];
        const stores = [0, 1].map(() => ({ ...base, async get<T>(key: string) {
            const value = await base.get<T>(key);
            if (/^(outbox|bridge-outbox):/.test(key) && !key.endsWith(':admission-outcome-v1')) {
                if (++initialReads === 2) absent.resolve();
                await absent.promise;
            }
            return value;
        } }));
        const original = fixture();
        const fetcher: typeof fetch = async (url, init) => {
            if (String(url).endsWith('/connection')) return Response.json({ id: 'grant', appId: 'advisor', source: 'platform', serviceId: 'service', expiresAt: null });
            if (String(url).endsWith('/turns')) {
                const index = ++posts;
                bodies.push(JSON.parse(String(init?.body)));
                if (order === 'accepted-first' ? index === 1 : index === 2) {
                    accepted++;
                    contenderAccepted.resolve();
                    throw new TypeError('accepted but response lost');
                }
                if (order === 'refusing-creator') await contenderAccepted.promise;
                return Response.json({ error: { code: 'authorization-revoked', retryable: false, requestId: 'request', submission: 'not-submitted' } }, { status: 409 });
            }
            return original.fetcher(url, init);
        };
        const receipt = makeReceipt(source === 'personal' ? 'personal-grant' : 'platform-grant');
        const transports = stores.map(storage => source === 'node'
            ? createNodePlatformTransport({ appId: 'advisor', serverUrl: 'https://paws.test', receipt, storage, fetch: fetcher })
            : source === 'personal'
                ? createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: 'https://app.test', storage, fetch: fetcher })
                : createBrowserPlatformTransport({ appId: 'advisor', baseUrl: '/api/ai', origin: 'https://app.test', storage, fetch: fetcher }));
        try {
            await Promise.all(transports.map(t => t.authorize(source === 'personal' ? { receipt } : {})));
            const input = { binding, requestId: 'request', messages: [{ role: 'user' as const, text: 'hello' }] };
            const results = await Promise.allSettled(transports.map(t => t.start(input)));
            expect(posts).toBe(2); expect(accepted).toBe(1);
            expect(results.map(result => result.status === 'rejected' ? result.reason.submission : 'unexpected success')).toEqual(['uncertain', 'uncertain']);
            expect(bodies[0]).toEqual(bodies[1]);
            expect(bodies[0].requestId).toBe('request');
            if (source !== 'platform') expect(typeof bodies[0].ciphertext).toBe('string');
            const outboxKey = `${source === 'platform' ? 'bridge-outbox' : 'outbox'}:binding:request`;
            expect(await base.get(outboxKey + ':admission-outcome-v1')).toEqual({ state: 'uncertain' });
            expect(await base.get(outboxKey)).not.toBeNull();
        } finally { transports.forEach(t => t.dispose()); }
    });
}
it('legacy outbox provenance can never acquire fresh refusal certainty', async () => {
    const storage = createMemoryServiceStorage();
    const attempt = await beginSubmission(storage, 'legacy', {}, 'new-attempt', 'request');
    expect((await attempt.failure(new AIServiceClientError('model-unavailable', false, 'request', 'not-submitted'))).submission).toBe('uncertain');
});
it('cannot expose a proven refusal when the outcome cannot be persisted', async () => {
    const base = createMemoryServiceStorage();
    const storage = { ...base, async putIfAbsent<T>(): Promise<T> { throw new AIServiceClientError('storage-unavailable'); } };
    const attempt = await beginSubmission(storage, 'outbox', { admissionOwner: 'first' }, 'first', 'request');
    await expect(attempt.failure(new AIServiceClientError('model-unavailable', false, 'request', 'not-submitted'))).rejects.toMatchObject({ code: 'storage-unavailable', submission: 'uncertain' });
});
