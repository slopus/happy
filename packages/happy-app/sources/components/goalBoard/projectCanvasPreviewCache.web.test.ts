import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProjectCanvasPreviewCache, readProjectCanvasPreviewCache, writeProjectCanvasPreviewCache } from './projectCanvasPreviewCache.web';

const bytes = new Uint8Array(64 * 1024).fill(7);
const previewVersionId = createHash('sha256').update(bytes).digest('hex');
const identity = (index: number) => ({ accountKey: 'account', machineId: 'machine', canvasId: 'canvas',
    assetId: `asset-${index}`, versionId: 'source', previewVersionId });
const signal = () => new AbortController().signal;

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bounded canvas preview storage', () => {
    it('checks account ownership after a delayed database open before committing bytes', async () => {
        let current = true;
        const writing = writeProjectCanvasPreviewCache(identity(9), bytes, signal(), () => {
            if (!current) throw new Error('Account changed');
        });
        current = false;
        await writing;
        expect(await readProjectCanvasPreviewCache(identity(9), bytes.length, signal())).toBeUndefined();
    });
    it('purges only the signed-out account and fences late writes', async () => {
        const retired = { ...identity(0), accountKey: 'retired-account' };
        const other = { ...identity(0), accountKey: 'other-account' };
        await writeProjectCanvasPreviewCache(retired, bytes, signal());
        await writeProjectCanvasPreviewCache(other, bytes, signal());
        const delayedWrite = writeProjectCanvasPreviewCache(retired, bytes, signal());
        await clearProjectCanvasPreviewCache(retired.accountKey);
        await delayedWrite;
        await writeProjectCanvasPreviewCache(retired, bytes, signal());
        expect(await readProjectCanvasPreviewCache(retired, bytes.length, signal())).toBeUndefined();
        expect(await readProjectCanvasPreviewCache(other, bytes.length, signal())).toEqual(bytes);
        const db = await new Promise<IDBDatabase>(resolve => {
            const opening = indexedDB.open('paws-project-canvas-previews-v1', 1);
            opening.onsuccess = () => resolve(opening.result);
        });
        try {
            const keys = await new Promise<IDBValidKey[]>(resolve => {
                const request = db.transaction('previews').objectStore('previews').getAllKeys();
                request.onsuccess = () => resolve(request.result);
            });
            expect(keys).toHaveLength(1);
            expect(JSON.parse(String(keys[0]))[0]).toBe('other-account');
        } finally { db.close(); }
    });
    it('evicts the least recently used binary preview before exceeding 32 MiB', async () => {
        let now = 100;
        vi.spyOn(Date, 'now').mockImplementation(() => now++);
        for (let index = 0; index < 512; index++) await writeProjectCanvasPreviewCache(identity(index), bytes, signal());
        expect(await readProjectCanvasPreviewCache(identity(0), bytes.length, signal())).toEqual(bytes);
        await writeProjectCanvasPreviewCache(identity(512), bytes, signal());
        expect(await readProjectCanvasPreviewCache(identity(1), bytes.length, signal())).toBeUndefined();
        expect(await readProjectCanvasPreviewCache(identity(0), bytes.length, signal())).toEqual(bytes);
        expect(await readProjectCanvasPreviewCache(identity(512), bytes.length, signal())).toEqual(bytes);
    });

    it('returns promptly from a blocked database so the caller can use RPC', async () => {
        vi.useFakeTimers();
        const opening = {} as IDBOpenDBRequest;
        vi.spyOn(indexedDB, 'open').mockReturnValue(opening);
        try {
            const reading = readProjectCanvasPreviewCache(identity(0), bytes.length, signal());
            await vi.advanceTimersByTimeAsync(1500);
            expect(await reading).toBeUndefined();
        } finally { vi.useRealTimers(); }
    });
});
