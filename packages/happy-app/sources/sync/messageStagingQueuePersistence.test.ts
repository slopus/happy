import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ stores: new Map<string, Map<string, string>>(), held: new Set<string>(), nextId: 0 }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    data: Map<string, string>;
    constructor({ id }: { id: string }) {
        if (!state.stores.has(id)) state.stores.set(id, new Map());
        this.data = state.stores.get(id)!;
    }
    getString(key: string) { return this.data.get(key); }
    set(key: string, value: string) { this.data.set(key, value); }
    clearAll() { this.data.clear(); }
} }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: (id: string) => `account-a-${id}` }));
vi.mock('uuid', () => ({ v4: () => `new-${++state.nextId}` }));

afterEach(() => { vi.unstubAllGlobals(); state.stores.clear(); state.held.clear(); });

function browser(tab = 'original') {
    let id = tab;
    vi.stubGlobal('document', {});
    vi.stubGlobal('window', { sessionStorage: { getItem: () => id, setItem: (_key: string, value: string) => { id = value; } } });
    vi.stubGlobal('navigator', { locks: { request: (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
        if (state.held.has(name)) return callback(null);
        state.held.add(name);
        return callback({ name });
    } } });
    return () => id;
}

describe('staged message persistence ownership', () => {
    it('isolates a copied tab and restores the original queue after the owner document exits', async () => {
        const originalId = browser();
        vi.resetModules();
        const original = await import('./messageStagingQueuePersistence');
        await original.initializeMessageStagingPersistence();
        original.messageStagingPersistence.save({ messages: [{ id: 'message', sessionId: 'session', text: 'hello', modeMeta: {}, status: 'queued' }], barriers: {} });
        const copiedId = browser(originalId());
        vi.resetModules();
        const copy = await import('./messageStagingQueuePersistence');
        await copy.initializeMessageStagingPersistence();
        expect(copiedId()).not.toBe('original');
        expect(copy.messageStagingPersistence.load().messages).toEqual([]);
        state.held.delete('account-a-message-staging-original');
        browser('original');
        vi.resetModules();
        const reloaded = await import('./messageStagingQueuePersistence');
        await reloaded.initializeMessageStagingPersistence();
        expect(reloaded.messageStagingPersistence.load().messages[0].text).toBe('hello');
        reloaded.clearMessageStagingStorage();
        expect(original.messageStagingPersistence.load().messages).toEqual([]);
    });

    it('uses native persistence even when React Native defines a window global', async () => {
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', undefined);
        vi.resetModules();
        const persistence = await import('./messageStagingQueuePersistence');
        await persistence.initializeMessageStagingPersistence();
        persistence.messageStagingPersistence.save({ messages: [], barriers: {} });
        expect(state.stores.has('account-a-message-staging-native')).toBe(true);
    });
});
