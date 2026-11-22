import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let module: typeof import('./deviceStorage.web');
beforeEach(async () => {
    vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null, removeItem: vi.fn(), setItem: () => { throw new Error('full'); } });
    module = await import('./deviceStorage.web'); await module.initializeWebStorage();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('hydrated browser persistence adapter', () => {
    it('exposes pending completion separately from immediate draft reads and durable writes', async () => {
        const store = new module.MMKV(); store.set('draft', 'hello');
        expect(store.getString('draft')).toBe('hello'); expect(module.getWebStorageStatus().pending).toBe(1);
        await module.flushDeviceStorageWrites(store);
        expect(module.getWebStorageStatus()).toMatchObject({ pending: 0, failed: 0 });
    });
    it('retains unsaved text and rejects durable completion after transaction abort', async () => {
        const original = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
            const request = original.apply(this, args);
            if (this.name === 'records') request.addEventListener('success', () => request.transaction?.abort());
            return request;
        });
        const store = new module.MMKV(); store.set('draft', 'do not lose me');
        await expect(module.flushDeviceStorageWrites(store)).rejects.toBeDefined();
        expect(store.getString('draft')).toBe('do not lose me'); expect(module.getWebStorageStatus().failed).toBe(1);
        vi.restoreAllMocks(); await module.retryWebStorageWrites();
        expect(module.getWebStorageStatus()).toMatchObject({ pending: 0, failed: 0 });
    });
    it('does not let cache failure block a successful critical draft save', async () => {
        const original = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
            const request = original.apply(this, args);
            if (String((args[0] as { key: string }).key).startsWith('session-warm-cache')) request.addEventListener('success', () => request.transaction?.abort());
            return request;
        });
        new module.MMKV({ id: 'session-warm-cache' }).set('cache', 'optional');
        const store = new module.MMKV(); await module.writeDeviceStorage(store, 'draft', 'important');
        expect(store.getString('draft')).toBe('important'); expect(module.getWebStorageStatus().failed).toBe(0);
    });
});

it('flushes a scheduled editor draft before switching accounts and reports it as pending', async () => {
    const store = new module.MMKV(), owner = {};
    module.markDeviceStorageDraftPending(owner, true, () => {
        store.set('draft', 'latest textarea');
        module.markDeviceStorageDraftPending(owner, false);
    });
    expect(module.getWebStorageStatus().pending).toBe(1);
    await module.flushDeviceStorageWrites();
    expect(store.getString('draft')).toBe('latest textarea');
    expect(module.getWebStorageStatus().pending).toBe(0);
});

it('keeps the latest scheduled editor text available when persistence fails', async () => {
    const store = new module.MMKV(), owner = {};
    module.markDeviceStorageDraftPending(owner, true, () => {
        store.set('draft', 'latest unsaved text');
        module.markDeviceStorageDraftPending(owner, false);
    });
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('quota'); });
    await expect(module.flushDeviceStorageWrites()).rejects.toBeDefined();
    expect(store.getString('draft')).toBe('latest unsaved text');
    expect(module.getWebStorageStatus()).toMatchObject({ pending: 0, failed: 1 });
});

it('protects uncommitted editor text on page exit and stops guarding after it is saved', async () => {
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    vi.resetModules();
    const storage = await import('./deviceStorage.web');
    await storage.initializeWebStorage();
    const store = new storage.MMKV(), owner = {};
    storage.markDeviceStorageDraftPending(owner, true, () => {
        store.set('draft', 'keep this text');
        storage.markDeviceStorageDraftPending(owner, false);
    });
    const unsavedExit = new Event('beforeunload', { cancelable: true });
    page.dispatchEvent(unsavedExit);
    expect(unsavedExit.defaultPrevented).toBe(true);
    await storage.flushDeviceStorageWrites();
    const savedExit = new Event('beforeunload', { cancelable: true });
    page.dispatchEvent(savedExit);
    expect(savedExit.defaultPrevented).toBe(false);
    expect(store.getString('draft')).toBe('keep this text');
});
