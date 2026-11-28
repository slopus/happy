import { createHash } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectGoalRequest } from '@/sync/projectGoals';
import { projectCanvasClient, type ProjectCanvasAsset } from './projectCanvasClient.web';

const account = vi.hoisted(() => ({ key: 'account-a', generation: 'login-a', serverUrl: 'https://relay.example.com' }));
vi.mock('@/auth/accountRuntime', () => ({
    getActiveAccountKey: () => account.key || null,
    getRuntimeAccountSelection: () => account.key ? { ...account } : null,
    assertAccountRuntime: () => {},
}));
vi.mock('@/sync/projectGoals', () => ({ projectGoalRequest: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'f43222a5-0b7d-4da4-8bd5-15d66f810a7f' }));

const request = vi.mocked(projectGoalRequest);
const bytes = new Uint8Array([255, 216, 255, 217]);
const previewVersion = createHash('sha256').update(bytes).digest('hex');
const asset: ProjectCanvasAsset = {
    id: `asset-${'b'.repeat(64)}`, versionId: 'b'.repeat(64), name: 'pose.png',
    mimeType: 'image/png', size: 100, x: 0, y: 0, preview: { size: bytes.length, versionId: previewVersion },
};
const canvasId = `canvas-${'a'.repeat(64)}`;
const signal = () => new AbortController().signal;

async function mountedClient(options: { path?: string; machine?: string; canvas?: string; item?: ProjectCanvasAsset } = {}) {
    const client = projectCanvasClient(options.machine ?? 'machine', options.path ?? '/project');
    request.mockResolvedValueOnce({ success: true, canvas: { id: options.canvas ?? canvasId, revision: 2, assets: [options.item ?? asset] } });
    await client.get();
    return client;
}

function servePreview(content = bytes) {
    request.mockResolvedValueOnce({ success: true, base64: Buffer.from(content).toString('base64'), size: content.length });
}

async function corruptStoredPreview() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open('paws-project-canvas-previews-v1', 1);
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('previews', 'readwrite');
            const cursor = tx.objectStore('previews').openCursor();
            cursor.onsuccess = () => cursor.result?.update(new Uint8Array([0, 0, 0, 0]));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally { db.close(); }
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    Object.assign(account, { key: 'account-a', generation: 'login-a', serverUrl: 'https://relay.example.com' });
    request.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('persistent project canvas previews', () => {
    it('reuses verified preview bytes after remount using the canonical canvas identity', async () => {
        const first = await mountedClient();
        servePreview();
        expect(new Uint8Array(await (await first.readPreview(asset, signal())).arrayBuffer())).toEqual(bytes);

        // An alias path resolving to the same server canvas must reuse the bytes.
        const remounted = await mountedClient({ path: '/project-alias' });
        request.mockClear();
        const restored = await remounted.readPreview(asset, signal());
        expect(new Uint8Array(await restored.arrayBuffer())).toEqual(bytes);
        expect(request).not.toHaveBeenCalled();
    });

    it.each(['account', 'machine', 'canvas', 'source-version', 'preview-version'] as const)('does not reuse a preview for a different %s', async boundary => {
        const first = await mountedClient();
        servePreview();
        await first.readPreview(asset, signal());
        if (boundary === 'account') Object.assign(account, { key: 'account-b', generation: 'login-b' });
        const item = boundary === 'source-version' ? { ...asset, versionId: 'c'.repeat(64) }
            : boundary === 'preview-version' ? { ...asset, preview: { ...asset.preview!, versionId: 'd'.repeat(64) } } : asset;
        const next = await mountedClient({ machine: boundary === 'machine' ? 'machine-b' : undefined,
            canvas: boundary === 'canvas' ? `canvas-${'c'.repeat(64)}` : undefined, item });
        request.mockClear();
        request.mockRejectedValueOnce(new Error('remote cache miss'));
        await expect(next.readPreview(item, signal())).rejects.toThrow('remote cache miss');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects an old account client after logout even when its preview is cached', async () => {
        const first = await mountedClient();
        servePreview();
        await first.readPreview(asset, signal());
        account.key = '';
        request.mockClear();
        await expect(first.readPreview(asset, signal())).rejects.toThrow(/account/i);
        expect(request).not.toHaveBeenCalled();
    });

    it('rehashes stored bytes and replaces a corrupted preview using the RPC', async () => {
        const first = await mountedClient();
        servePreview();
        await first.readPreview(asset, signal());
        await corruptStoredPreview();
        const next = await mountedClient();
        request.mockClear();
        servePreview();
        expect(new Uint8Array(await (await next.readPreview(asset, signal())).arrayBuffer())).toEqual(bytes);
        expect(request).toHaveBeenCalledTimes(1);
        const remounted = await mountedClient();
        request.mockClear();
        expect((await remounted.readPreview(asset, signal())).size).toBe(bytes.length);
        expect(request).not.toHaveBeenCalled();
    });

    it('keeps accepted generated previews across remounts', async () => {
        const first = await mountedClient();
        request.mockResolvedValueOnce({ success: true, canvas: { id: canvasId, revision: 3, assets: [asset] } });
        await first.putPreview({ ...asset, preview: undefined }, new Blob([bytes], { type: 'image/jpeg' }), signal());
        const next = await mountedClient();
        request.mockClear();
        expect((await next.readPreview(asset, signal())).size).toBe(bytes.length);
        expect(request).not.toHaveBeenCalled();
    });

    it('uses a compact upload receipt only when the daemon advertises it and persists accepted bytes', async () => {
        const client = projectCanvasClient('machine', '/project', { previewReceipts: true });
        const receipt = { canvasId, baseRevision: 2, revision: 3, asset };
        request.mockResolvedValueOnce({ success: true, ...receipt });
        expect(await client.putPreview(asset, new Blob([bytes]), signal())).toMatchObject(receipt);
        expect(request.mock.calls[0][1]).toBe('goalProjectCanvasPutPreviewReceipt');
        const remounted = await mountedClient();
        request.mockClear();
        expect((await remounted.readPreview(asset, signal())).size).toBe(bytes.length);
        expect(request).not.toHaveBeenCalled();
    });

    it('does not poison the cache when an existing server preview differs from the upload', async () => {
        const first = await mountedClient();
        request.mockResolvedValueOnce({ success: true, canvas: { id: canvasId, revision: 3, assets: [asset] } });
        await first.putPreview({ ...asset, preview: undefined }, new Blob([new Uint8Array([0, 1, 2, 3])]), signal());
        const next = await mountedClient();
        request.mockClear();
        servePreview();
        expect(new Uint8Array(await (await next.readPreview(asset, signal())).arrayBuffer())).toEqual(bytes);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects cached reads cancelled when the pane unmounts', async () => {
        const first = await mountedClient();
        servePreview();
        await first.readPreview(asset, signal());
        const remounted = await mountedClient();
        const controller = new AbortController();
        const reading = remounted.readPreview(asset, controller.signal);
        controller.abort();
        await expect(reading).rejects.toHaveProperty('name', 'AbortError');
    });

    it('falls back to the encrypted RPC when IndexedDB is unavailable or writes hit quota', async () => {
        const first = await mountedClient();
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
        servePreview();
        expect((await first.readPreview(asset, signal())).size).toBe(bytes.length);
        vi.restoreAllMocks();
        vi.stubGlobal('indexedDB', undefined);
        const remounted = await mountedClient();
        request.mockClear();
        servePreview();
        expect((await remounted.readPreview(asset, signal())).size).toBe(bytes.length);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('keeps preview reads usable when updating cached LRU metadata hits quota', async () => {
        let now = 100;
        vi.spyOn(Date, 'now').mockImplementation(() => now++);
        const first = await mountedClient();
        servePreview();
        await first.readPreview(asset, signal());
        const remounted = await mountedClient();
        let fail!: () => void;
        const failed = new Promise<void>(resolve => { fail = resolve; });
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { fail(); throw new DOMException('full', 'QuotaExceededError'); });
        request.mockClear();
        servePreview();
        expect((await remounted.readPreview(asset, signal())).size).toBe(bytes.length);
        await failed;
        expect(request).not.toHaveBeenCalled();
    });
});
