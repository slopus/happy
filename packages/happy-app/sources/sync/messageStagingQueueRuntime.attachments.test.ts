import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const mocks = vi.hoisted(() => ({
    stores: new Map<string, Map<string, string>>(), held: new Set<string>(),
    active: true, failQueueSave: false, send: vi.fn(async (..._args: any[]) => {}),
    state: {} as any,
}));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    data: Map<string, string>;
    constructor({ id }: { id: string }) {
        if (!mocks.stores.has(id)) mocks.stores.set(id, new Map());
        this.data = mocks.stores.get(id)!;
    }
    getString(key: string) { return this.data.get(key); }
    set(key: string, value: string) {
        if (key === 'queue-v1' && mocks.failQueueSave) throw new Error('Quota exceeded');
        this.data.set(key, value);
    }
    clearAll() { this.data.clear(); }
} }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => mocks.active, accountStorageId: (id: string) => `account-a-${id}` }));
vi.mock('@/utils/sessionUtils', () => ({ resolveSessionState: (session: any) => ({ state: session.state, isConnected: true }) }));
vi.mock('./storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('./sync', () => ({ sync: { getCredentials: () => 'credentials', sendMessage: (...args: any[]) => mocks.send(...args) } }));
vi.mock('./ops', () => ({ sessionSteer: vi.fn() }));
vi.mock('./messageMeta', () => ({ resolveMessageModeMeta: () => ({ model: 'selected' }) }));
vi.mock('./stagedAttachmentStorage', async () => import('./stagedAttachmentStorage.web'));

const attachment = () => ({ id: 'image', uri: URL.createObjectURL(new Blob(['original image bytes'], { type: 'image/png' })),
    width: 1, height: 1, size: 20, mimeType: 'image/png', name: 'image.png' });

beforeEach(() => {
    vi.resetModules();
    mocks.stores.clear(); mocks.held.clear(); mocks.send.mockReset();
    mocks.active = true; mocks.failQueueSave = false;
    mocks.state = { sessions: { s: { state: 'running', metadata: {}, agentState: { turnStatus: { turnId: 'old' } } } },
        settings: {}, socketStatus: 'connected', applyPendingMessageSessions: () => {} };
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    let tab = 'original';
    vi.stubGlobal('document', {});
    vi.stubGlobal('window', { sessionStorage: { getItem: () => tab, setItem: (_key: string, value: string) => { tab = value; } } });
    vi.stubGlobal('navigator', { locks: { request: (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
        if (mocks.held.has(name)) return callback(null);
        mocks.held.add(name); return callback({ name });
    } } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function storedFileCount() {
    return new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('paws-staged-attachments-v1', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('attachments');
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('attachments', 'readonly');
            const count = tx.objectStore('attachments').count();
            tx.oncomplete = () => { db.close(); resolve(count.result); };
            tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
    });
}

describe('real Web queue attachment persistence wiring', () => {
    it('reloads the actual persisted queue before dispatch and releases bytes after acceptance', async () => {
        const first = await import('./messageStagingQueueRuntime');
        const image = attachment();
        await first.stageSessionMessage('s', 'My original text', [image]);
        expect(first.messageStagingQueue.getSnapshot().messages[0].attachments![0].stagingKey).toEqual(expect.any(String));
        expect(await storedFileCount()).toBe(1);
        URL.revokeObjectURL(image.uri);
        mocks.held.clear(); vi.resetModules();
        const reloaded = await import('./messageStagingQueueRuntime');
        await reloaded.initializeMessageStagingQueue();
        const message = reloaded.messageStagingQueue.getSnapshot().messages[0];
        expect(message.attachmentsExpired).toBeUndefined();
        expect(message.text).toBe('My original text');
        expect(await (await fetch(message.attachments![0].uri)).text()).toBe('original image bytes');
        mocks.send.mockImplementationOnce(async (_id, text, options) => {
            expect(text).toBe('My original text');
            expect(await (await fetch(options.attachments[0].uri)).text()).toBe('original image bytes');
        });
        mocks.state.sessions.s.state = 'completed';
        reloaded.messageStagingQueue.refresh();
        await vi.waitFor(() => expect(reloaded.messageStagingQueue.getSnapshot().messages).toHaveLength(0));
        expect(mocks.send).toHaveBeenCalledOnce();
        expect(await storedFileCount()).toBe(0);
    });

    it('preserves the original selection when attachment storage fails before queue acceptance', async () => {
        const runtime = await import('./messageStagingQueueRuntime');
        await runtime.initializeMessageStagingQueue();
        const image = attachment();
        vi.stubGlobal('indexedDB', undefined);
        await expect(runtime.stageSessionMessage('s', 'keep this draft', [image])).rejects.toThrow();
        expect(runtime.messageStagingQueue.getSnapshot().messages).toEqual([]);
        expect(mocks.send).not.toHaveBeenCalled();
        expect(await (await fetch(image.uri)).text()).toBe('original image bytes');
        expect(image).not.toHaveProperty('stagingKey');
    });

    it('cleans the new copy if the synchronous queue save fails', async () => {
        const runtime = await import('./messageStagingQueueRuntime');
        mocks.failQueueSave = true;
        await expect(runtime.stageSessionMessage('s', 'keep draft', [attachment()])).rejects.toThrow('Quota exceeded');
        expect(await storedFileCount()).toBe(0);
        expect(runtime.messageStagingQueue.getSnapshot().messages).toEqual([]);
    });

    it('keeps same-session submissions in order while the first attachment is still being saved', async () => {
        const runtime = await import('./messageStagingQueueRuntime');
        await runtime.initializeMessageStagingQueue();
        const image = attachment();
        const response = await fetch(image.uri);
        let release!: (response: Response) => void;
        let started!: () => void;
        const arrived = new Promise<void>(resolve => { started = resolve; });
        vi.stubGlobal('fetch', () => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
        const first = runtime.stageSessionMessage('s', 'first with image', [image]);
        await arrived;
        const second = runtime.stageSessionMessage('s', 'second text');
        await Promise.resolve();
        expect(runtime.messageStagingQueue.getSnapshot().messages).toHaveLength(0);
        release(response);
        await Promise.all([first, second]);
        expect(runtime.messageStagingQueue.getSnapshot().messages.map(message => message.text)).toEqual(['first with image', 'second text']);
    });

    it('keeps originals on a failed upload and removes the saved bytes only when the message is deleted', async () => {
        const runtime = await import('./messageStagingQueueRuntime');
        mocks.state.sessions.s.state = 'completed';
        mocks.send.mockRejectedValueOnce(new Error('Upload unavailable'));
        await runtime.stageSessionMessage('s', 'keep attachment for retry', [attachment()]);
        await vi.waitFor(() => expect(runtime.messageStagingQueue.getSnapshot().messages[0]?.status).toBe('failed'));
        expect(await storedFileCount()).toBe(1);
        runtime.messageStagingQueue.remove(runtime.messageStagingQueue.getSnapshot().messages[0].id);
        expect(await storedFileCount()).toBe(0);
    });

    it.each(['clear', 'account-change'])('rejects a late attachment save after %s', async action => {
        const runtime = await import('./messageStagingQueueRuntime');
        await runtime.initializeMessageStagingQueue();
        const image = attachment();
        const response = await fetch(image.uri);
        let release!: (response: Response) => void;
        let started!: () => void;
        const arrived = new Promise<void>(resolve => { started = resolve; });
        vi.stubGlobal('fetch', () => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
        const submission = runtime.stageSessionMessage('s', 'do not send after clear', [image]);
        await arrived;
        if (action === 'clear') await runtime.clearMessageStagingQueue();
        else mocks.active = false;
        release(response);
        await expect(submission).rejects.toThrow('Session unavailable');
        expect(runtime.messageStagingQueue.getSnapshot().messages).toEqual([]);
        expect(mocks.send).not.toHaveBeenCalled();
        expect(await storedFileCount()).toBe(0);
    });
});
