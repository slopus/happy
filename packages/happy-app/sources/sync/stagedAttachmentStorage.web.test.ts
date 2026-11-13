import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import type { AttachmentPreview } from './attachmentTypes';
import { availableStagedAttachments, createMessageStagingQueue, expiredStagedAttachments, type StagedMessage, type StagingSnapshot } from './messageStagingQueue';

const photo = (id = 'photo'): AttachmentPreview => ({
    id, uri: URL.createObjectURL(new Blob([new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255])], { type: 'image/png' })),
    width: 10, height: 20, size: 8, mimeType: 'image/png', name: 'same-name.png',
});
const snapshotOf = (attachments: AttachmentPreview[], status: StagedMessage['status'] = 'queued'): StagingSnapshot => ({
    messages: [{ id: 'm', sessionId: 's', text: 'Keep my images', modeMeta: {}, status, attachments }], barriers: {},
});
const queueFor = () => createMessageStagingQueue({
    load: () => ({ messages: [], barriers: {} }), save: () => {},
    session: () => ({ connected: false, state: 'idle' }), send: async () => {}, steer: async () => {},
});

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('durable staged Web attachment bytes', () => {
    it('rebuilds readable image and document URLs after the old URLs and module state are gone, then sends the originals', async () => {
        const original = photo();
        const document = { ...photo('document'), uri: 'data:text/plain;base64,aGVsbG8=', name: 'note.txt', mimeType: 'text/plain', kind: 'file' as const, size: 5 };
        const { persistStagedAttachments } = await import('./stagedAttachmentStorage.web');
        const saved = await persistStagedAttachments('account-a-tab-1', [original, document]);
        expect(saved[1].uri.startsWith('blob:')).toBe(true);
        const serialized = JSON.stringify(snapshotOf(saved));
        expect(serialized).not.toContain('aGVsbG8=');
        for (const attachment of saved) URL.revokeObjectURL(attachment.uri);
        await expect(fetch(original.uri)).rejects.toThrow();
        vi.resetModules();
        const { restoreStagedAttachments } = await import('./stagedAttachmentStorage.web');
        const restored = await restoreStagedAttachments('account-a-tab-1', JSON.parse(serialized));
        let delivered: AttachmentPreview[] = [];
        const send = vi.fn(async (message: StagedMessage) => {
            delivered = message.attachments!;
            expect(new Uint8Array(await (await fetch(delivered[0].uri)).arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255]));
            expect(await (await fetch(delivered[1].uri)).text()).toBe('hello');
        });
        const queue = createMessageStagingQueue({ load: () => ({ messages: [], barriers: {} }), save: () => {},
            session: () => ({ connected: true, state: 'idle' }), send, steer: async () => {} });
        queue.restore(restored.snapshot, restored.availableBlobUris);
        expect(availableStagedAttachments(queue.getSnapshot().messages[0])).toHaveLength(2);
        expect(queue.getSnapshot().messages[0].attachmentsExpired).toBeUndefined();
        queue.refresh();
        await vi.waitFor(() => expect(queue.getSnapshot().messages).toHaveLength(0));
        expect(send).toHaveBeenCalledOnce();
        expect(delivered.map(a => a.name)).toEqual(['same-name.png', 'note.txt']);
    });

    it('keeps an ambiguous in-flight send blocked after successful byte recovery', async () => {
        const storage = await import('./stagedAttachmentStorage.web');
        const attachments = await storage.persistStagedAttachments('account-a-tab', [photo()]);
        const restored = await storage.restoreStagedAttachments('account-a-tab', snapshotOf(attachments, 'sending'));
        const queue = queueFor();
        queue.restore(restored.snapshot, restored.availableBlobUris);
        expect(queue.getSnapshot().messages[0]).toMatchObject({ status: 'failed', deliveryUncertain: true });
        expect(queue.getSnapshot().messages[0].attachmentsExpired).toBeUndefined();
    });

    it('isolates accounts and tabs even with identical file names and attachment IDs', async () => {
        const storage = await import('./stagedAttachmentStorage.web');
        const a = await storage.persistStagedAttachments('account-a-tab-1', [photo()]);
        const b = await storage.persistStagedAttachments('account-a-tab-2', [photo()]);
        const c = await storage.persistStagedAttachments('account-b-tab-1', [photo()]);
        const wrong = await storage.restoreStagedAttachments('account-b-tab-1', snapshotOf(a));
        expect(wrong.availableBlobUris.size).toBe(0);
        await storage.clearStagedAttachments(['account-a-tab-1', 'account-a-tab-2']);
        expect((await storage.restoreStagedAttachments('account-a-tab-1', snapshotOf(a))).availableBlobUris.size).toBe(0);
        expect((await storage.restoreStagedAttachments('account-a-tab-2', snapshotOf(b))).availableBlobUris.size).toBe(0);
        expect((await storage.restoreStagedAttachments('account-b-tab-1', snapshotOf(c))).availableBlobUris.size).toBe(1);
    });

    it('retains all text, identifies only missing files and preserves healthy attachments when taken back', async () => {
        const storage = await import('./stagedAttachmentStorage.web');
        const saved = await storage.persistStagedAttachments('owner', [photo('one'), photo('two')]);
        await storage.deleteStagedAttachments('owner', [saved[1]]);
        const restored = await storage.restoreStagedAttachments('owner', snapshotOf(saved));
        const queue = queueFor();
        queue.restore(restored.snapshot, restored.availableBlobUris);
        const recovered = queue.take('m')!;
        expect(recovered).toMatchObject({ text: 'Keep my images', status: 'failed', attachmentsExpired: true });
        expect(expiredStagedAttachments(recovered).map(a => a.id)).toEqual(['two']);
        expect(availableStagedAttachments(recovered).map(a => a.id)).toEqual(['one']);
    });

    it('does not trust an unhydrated staging key or legacy blob URL', async () => {
        const storage = await import('./stagedAttachmentStorage.web');
        const saved = await storage.persistStagedAttachments('owner', [photo()]);
        const queue = queueFor();
        queue.restore(snapshotOf(saved));
        expect(queue.getSnapshot().messages[0]).toMatchObject({ attachmentsExpired: true, status: 'failed' });
        const legacy = await storage.restoreStagedAttachments('owner', snapshotOf([photo()]));
        queue.restore(legacy.snapshot, legacy.availableBlobUris);
        expect(queue.getSnapshot().messages[0].attachmentsExpired).toBe(true);
    });

    it('rejects unavailable storage instead of accepting a volatile attachment', async () => {
        const storage = await import('./stagedAttachmentStorage.web');
        vi.stubGlobal('indexedDB', undefined);
        await expect(storage.persistStagedAttachments('owner', [photo()])).rejects.toThrow();
    });

    it('waits for the transaction to commit, and rejects a put that succeeded before its transaction aborted', async () => {
        const storage = await import('./stagedAttachmentStorage.web');
        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
            const request = put.call(this, value, key);
            request.onsuccess = () => this.transaction.abort();
            return request;
        });
        await expect(storage.persistStagedAttachments('owner', [photo()])).rejects.toThrow();
    });

    it('removes already committed copies if a later attachment exceeds storage quota', async () => {
        const storage = await import('./stagedAttachmentStorage.web');
        const put = IDBObjectStore.prototype.put;
        const keys: string[] = [];
        vi.spyOn(IDBObjectStore.prototype, 'put')
            .mockImplementationOnce(function (this: IDBObjectStore, value, key) {
                keys.push((key as string[])[1]);
                return put.call(this, value, key);
            })
            .mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
        const original = photo('one');
        await expect(storage.persistStagedAttachments('owner', [original, photo('two')])).rejects.toThrow('Full');
        const leftovers = await storage.restoreStagedAttachments('owner', snapshotOf([{ ...original, stagingKey: keys[0] }]));
        expect(leftovers.availableBlobUris.size).toBe(0);
    });

    it('uses fresh keys when requeuing, so delayed cleanup leaves the new copy intact', async () => {
        const storage = await import('./stagedAttachmentStorage.web');
        const original = await storage.persistStagedAttachments('owner', [photo()]);
        const requeued = await storage.persistStagedAttachments('owner', original);
        expect(requeued[0].stagingKey).not.toBe(original[0].stagingKey);
        await storage.deleteStagedAttachments('owner', original);
        expect((await storage.restoreStagedAttachments('owner', snapshotOf(requeued))).availableBlobUris.size).toBe(1);
    });
});
