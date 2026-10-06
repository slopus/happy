import { it, expect, vi } from 'vitest';
import { createServiceController } from './controller';
import { createAIServiceClient } from './client';
import { createNodePlatformTransport } from './nodePlatformTransport';
import { createBrowserPersonalTransport } from './personalTransport';
import { createMemoryServiceStorage, createBrowserServiceStorage } from './storage';
import { fixture, makeReceipt } from './testFixtures';
import { createBrowserPlatformTransport } from './platformTransport';
import { IDBFactory } from 'fake-indexeddb';

function sessionStorage(): Storage {
    const values = new Map<string, string>();
    return { get length() { return values.size; }, clear: () => values.clear(), key: i => [...values.keys()][i] ?? null,
        getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

it.each([false, true])('restores a personal connection after lock only when remembered (%s)', async remember => {
    const indexedDB = new IDBFactory(), session = sessionStorage();
    const options = { appId: 'advisor', origin: 'https://app.test', subject: 'user', connectionId: 'personal', sessionStorage: session, indexedDB, broadcastChannel: null };
    const storage = createBrowserServiceStorage(options), f = fixture();
    const makeClient = (saved: typeof storage) => createAIServiceClient({ appId: 'advisor', transport: createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: 'https://app.test', storage: saved, fetch: f.fetcher }) });
    const client = makeClient(storage), controller = createServiceController(client, storage);
    let restored: ReturnType<typeof createServiceController> | undefined;
    try {
        await controller.connect({ receipt: makeReceipt('personal-grant'), remember });
        controller.setOverrides({ modelId: 'private-preference' });
        await controller.lock();
        expect(controller.getState()).toMatchObject({ status: 'disconnected', connection: null, catalog: null, overrides: {} });
        await expect(controller.restore()).rejects.toMatchObject({ code: 'disposed' });
        await expect(client.connections.authorize()).rejects.toMatchObject({ code: 'disposed' });
        const saved = createBrowserServiceStorage(options);
        restored = createServiceController(makeClient(saved), saved);
        // The host must verify /api/me before constructing this new instance.
        if (remember) {
            await restored.restore();
            expect(restored.getState()).toMatchObject({ status: 'ready', connection: { id: 'grant' } });
            await restored.disconnect('forget');
        }
        expect(await saved.get('connection')).toBeNull();
    } finally { controller.dispose(); restored?.dispose(); }
});

it('locks connected controllers in other tabs and aborts their active observations', async () => {
    const options = { appId: 'advisor', origin: 'https://app.test', subject: 'lock-test', connectionId: 'platform', indexedDB: null };
    let readSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (url, init) => {
        if (String(url).endsWith('/connection')) return Response.json({ id: 'platform', appId: 'advisor', source: 'platform', serviceId: 'default', expiresAt: null });
        readSignal = init!.signal!;
        return new Promise((_, reject) => readSignal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    };
    const a = createBrowserServiceStorage({ ...options, sessionStorage: sessionStorage() });
    const b = createBrowserServiceStorage({ ...options, sessionStorage: sessionStorage() });
    const makeClient = (storage: typeof a) => createAIServiceClient({ appId: 'advisor', transport: createBrowserPlatformTransport({ appId: 'advisor', baseUrl: '/api/ai', origin: options.origin, storage, fetch: fetcher }) });
    const first = createServiceController(makeClient(a), a), secondClient = makeClient(b), second = createServiceController(secondClient, b);
    const events: unknown[] = [];
    try {
        await first.connect(); await second.connect();
        const observation = secondClient.turns.observe({ bindingId: 'binding', turnId: 'turn' }, event => events.push(event));
        await vi.waitFor(() => expect(readSignal).toBeDefined());
        await first.lock();
        await vi.waitFor(() => expect(second.getState().status).toBe('disconnected'));
        await observation.done;
        expect(readSignal!.aborted).toBe(true);
        expect(events).toEqual([]);
        await expect(second.restore()).rejects.toMatchObject({ code: 'disposed' });
    } finally { first.dispose(); second.dispose(); }
});

it.each([false, true])('locks a pending remembered pairing without retaining its temporary secret (host disposes=%s)', async disposeOnLock => {
    const indexedDB = new IDBFactory(), options = { appId: 'advisor', origin: 'https://app.test', subject: 'user', connectionId: 'pending', indexedDB, broadcastChannel: null };
    const storage = createBrowserServiceStorage({ ...options, sessionStorage: sessionStorage() });
    let pairingSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (url, init) => {
        if (String(url).endsWith('/pairings')) return Response.json({ id: 'pending', expiresAt: Date.now() + 60000, protocol: 'ai-services/1' });
        pairingSignal = init!.signal!;
        return new Promise((_, reject) => pairingSignal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    };
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: options.origin, storage, fetch: fetcher }) });
    const controller = createServiceController(client, storage);
    let fresh: ReturnType<typeof createBrowserServiceStorage> | undefined;
    try {
        const pending = controller.connect({ remember: true });
        await vi.waitFor(() => expect(pairingSignal).toBeDefined());
        if (disposeOnLock) controller.subscribe(event => { if (event.type === 'invalidated' && event.reason === 'lock') controller.dispose(); });
        await controller.lock();
        await pending;
        expect(pairingSignal!.aborted).toBe(true);
        expect(controller.getState()).toMatchObject({ status: 'disconnected', connection: null, pending: null });
        fresh = createBrowserServiceStorage({ ...options, sessionStorage: sessionStorage() });
        expect(await fresh.get('pending-authorization')).toBeNull();
        expect(await fresh.get('connection')).toBeNull();
    } finally { controller.dispose(); fresh?.dispose(); }
});

it.each(['state', 'invalidated'])('finishes transient cleanup when the host disposes the controller on the %s event', async eventType => {
    const session = sessionStorage(), options = { appId: 'advisor', origin: 'https://app.test', subject: 'user', connectionId: 'personal', sessionStorage: session, indexedDB: null };
    const storage = createBrowserServiceStorage(options), f = fixture();
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: options.origin, storage, fetch: f.fetcher }) });
    const controller = createServiceController(client, storage);
    try {
        await controller.connect({ receipt: makeReceipt('personal-grant') });
        controller.subscribe(event => { if (event.type === eventType && (event.type === 'invalidated' ? event.reason === 'lock' : event.state.status === 'disconnected')) controller.dispose(); });
        await expect(controller.lock()).resolves.toBeUndefined();
        expect(session.length).toBe(0);
    } finally { controller.dispose(); }
});

it('keeps the panel connected when a platform chat restores its client directly', async () => {
    const storage = createMemoryServiceStorage();
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPlatformTransport({
        appId: 'advisor', baseUrl: '/api/ai', origin: 'https://app.test', storage,
        fetch: async () => Response.json({ id: 'platform', appId: 'advisor', source: 'platform', serviceId: 'default', expiresAt: null }),
    }) });
    const controller = createServiceController(client, storage);
    await controller.connect();
    await controller.disconnect();
    expect(controller.getState().status).toBe('disconnected');
    await client.connections.authorize();
    expect(controller.getState()).toMatchObject({ status: 'ready', connection: { id: 'platform' } });
    client.connections.disconnect();
    expect(controller.getState()).toMatchObject({ status: 'disconnected', connection: null });
    controller.dispose();
});

it('shows a failed platform chat authorization in the same controller state', async () => {
    const storage = createMemoryServiceStorage();
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPlatformTransport({
        appId: 'advisor', baseUrl: '/api/ai', origin: 'https://app.test', storage,
        fetch: async () => { throw new TypeError('offline'); },
    }) });
    const controller = createServiceController(client, storage);
    await expect(client.connections.authorize()).rejects.toMatchObject({ code: 'transport-error' });
    expect(controller.getState()).toMatchObject({ status: 'error', connection: null, error: { code: 'transport-error' } });
    controller.dispose();
});

it('does not reconnect the panel when an authorization finishes after disconnect', async () => {
    let release!: (value: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    const storage = createMemoryServiceStorage();
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPlatformTransport({
        appId: 'advisor', baseUrl: '/api/ai', origin: 'https://app.test', storage, fetch: () => response,
    }) });
    const controller = createServiceController({ platform: client, personal: undefined }, storage);
    const pending = client.connections.authorize();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await controller.disconnect();
    release(Response.json({ id: 'late', appId: 'advisor', source: 'platform', serviceId: 'default', expiresAt: null }));
    await rejected;
    expect(controller.getState()).toMatchObject({ status: 'disconnected', connection: null });
    controller.dispose();
});

it('keeps the latest platform authorization usable when an older restore is aborted', async () => {
    const waiting: ((value: Response) => void)[] = [];
    const storage = createMemoryServiceStorage();
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPlatformTransport({
        appId: 'advisor', baseUrl: '/api/ai', origin: 'https://app.test', storage,
        fetch: async (url, options) => {
            if (String(url).endsWith('/capabilities')) return Response.json({ catalog: null });
            return new Promise<Response>((resolve, reject) => {
                waiting.push(resolve);
                options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
            });
        },
    }) });
    const controller = createServiceController(client, storage);
    const first = controller.restore();
    await vi.waitFor(() => expect(waiting.length).toBe(1));
    const second = controller.restore();
    await vi.waitFor(() => expect(waiting.length).toBe(2));
    await first;
    waiting[1](Response.json({ id: 'latest', appId: 'advisor', source: 'platform', serviceId: 'default', expiresAt: null }));
    await second;
    await expect(controller.refresh()).resolves.toBeNull();
    expect(controller.getState()).toMatchObject({ status: 'ready', connection: { id: 'latest' } });
    controller.dispose();
});

it('does not let an old panel restore overwrite a newer chat connection', async () => {
    const waiting: ((value: Response) => void)[] = [];
    const storage = createMemoryServiceStorage();
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPlatformTransport({
        appId: 'advisor', baseUrl: '/api/ai', origin: 'https://app.test', storage,
        fetch: async () => new Promise<Response>(resolve => { waiting.push(resolve); }),
    }) });
    const controller = createServiceController(client, storage);
    const old = controller.restore().catch(error => error.code);
    await vi.waitFor(() => expect(waiting.length).toBe(1));
    const chat = client.connections.authorize();
    await vi.waitFor(() => expect(waiting.length).toBe(2));
    const reply = () => Response.json({ id: 'active', appId: 'advisor', source: 'platform', serviceId: 'default', expiresAt: null });
    waiting[1](reply()); await chat;
    waiting[0](reply()); await old;
    expect(controller.getState()).toMatchObject({ status: 'ready', connection: { id: 'active' }, error: null });
    controller.dispose();
});
it('keeps credentials out of state, changes only new-conversation overrides, and makes no idle polls', async () => {
    vi.useFakeTimers();
    try {
        const f = fixture(), storage = createMemoryServiceStorage(), client = createAIServiceClient({ appId: 'advisor', transport: createNodePlatformTransport({ appId: 'advisor', serverUrl: 'https://paws.test', receipt: makeReceipt('platform-grant'), storage, fetch: f.fetcher }) }), controller = createServiceController(client, storage);
        const events: unknown[] = [];
        const unsubscribe = controller.subscribe(e => events.push(e));
        await controller.connect();
        expect(controller.getState().status).toBe('ready');
        controller.setOverrides({ modelId: null, reasoning: { mode: 'explicit', value: 'native' } });
        expect(JSON.stringify(events)).not.toContain('messageKey');
        expect(JSON.stringify(events)).not.toContain('paws_service');
        const count = f.requests.length;
        await vi.advanceTimersByTimeAsync(60000);
        expect(f.requests.length).toBe(count);
        await controller.disconnect('forget');
        expect(controller.getState().connection).toBeNull();
        unsubscribe();
        controller.dispose();
        expect(vi.getTimerCount()).toBe(0);
    }
    finally {
        vi.useRealTimers();
    }
});
it('cancels a pending personal authorization on disconnect and removes its local secret', async () => {
    const storage = createMemoryServiceStorage();
    let redeemed!: () => void;
    const submitted = new Promise<void>(resolve => redeemed = resolve);
    const fetcher: typeof fetch = async (url, init) => { if (String(url).endsWith('/pairings'))
        return Response.json({ id: 'pending', expiresAt: Date.now() + 60000, protocol: 'ai-services/1' }); redeemed(); await new Promise<void>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abort')), { once: true })); throw new Error('unreachable'); };
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: 'https://app.test', storage, fetch: fetcher }) }), controller = createServiceController(client, storage);
    const attempt = controller.connect();
    await submitted;
    expect(controller.getState().status).toBe('authorizing');
    await controller.disconnect();
    await attempt;
    expect(await storage.get('pending-authorization')).toBeNull();
    expect(controller.getState().status).toBe('disconnected');
    controller.dispose();
});

it('authorizes a saved personal connection with remember disabled after IndexedDB denial', async () => {
    const values = new Map<string,string>();
    const session: Storage = { get length() { return values.size; }, clear: () => values.clear(), key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null, setItem: (key,value) => { values.set(key,value); }, removeItem: key => { values.delete(key); } };
    const denied = { open() { throw new DOMException('denied','SecurityError'); } } as unknown as IDBFactory;
    const storage = createBrowserServiceStorage({ appId:'advisor',origin:'https://app.test',subject:'user',connectionId:'personal',sessionStorage:session,indexedDB:denied,broadcastChannel:null });
    await storage.get('missing');
    await storage.set('connection',makeReceipt('personal-grant'));
    const f=fixture(), client=createAIServiceClient({ appId:'advisor',transport:createBrowserPersonalTransport({ appId:'advisor',serverUrl:'https://paws.test',webUrl:'https://web.test',origin:'https://app.test',storage,fetch:f.fetcher }) });
    const controller=createServiceController(client,storage);
    try {
        expect(await controller.connect({remember:false})).toMatchObject({id:'grant',source:'personal'});
        expect(controller.getState()).toMatchObject({status:'ready',storage:{mode:'session',warning:'remember-unavailable'}});
        expect(await storage.get('connection')).toMatchObject({id:'grant'});
    } finally { controller.dispose(); }
});
