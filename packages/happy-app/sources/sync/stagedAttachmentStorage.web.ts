import { v4 as uuid } from 'uuid';
import type { AttachmentPreview } from './attachmentTypes';
import type { StagingSnapshot } from './messageStagingQueue';

const DATABASE = 'paws-staged-attachments-v1';
const STORE = 'attachments';
const keyFor = (namespace: string, key: string) => [namespace, key];

async function withAttachments<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const request = action(tx.objectStore(STORE));
            // A successful put request is not yet a committed transaction.
            tx.oncomplete = () => resolve(request.result);
            tx.onabort = () => reject(tx.error ?? new Error('Attachment storage transaction aborted'));
            tx.onerror = () => reject(tx.error ?? request.error);
        });
    } finally { db.close(); }
}

/** Accept a queued message only after the actual bytes survive a reload.
 * Each submission owns fresh keys, including when a message is taken back and
 * queued again, so delayed cleanup cannot delete a newer submission's copy.
 */
export async function persistStagedAttachments(namespace: string, attachments: AttachmentPreview[]): Promise<AttachmentPreview[]> {
    const saved: AttachmentPreview[] = [];
    try {
        for (const attachment of attachments) {
            const response = await fetch(attachment.uri);
            if (!response.ok) throw new Error('Attachment is unavailable');
            const blob = await response.blob();
            const copy = { ...attachment, stagingKey: uuid() };
            await withAttachments('readwrite', store => store.put(blob, keyFor(namespace, copy.stagingKey)));
            saved.push(copy);
            // Some Web pickers return data URLs. Keep large base64 strings out
            // of the small synchronous queue store as well.
            if (!copy.uri.startsWith('blob:')) copy.uri = URL.createObjectURL(blob);
        }
        return saved;
    } catch (error) {
        await deleteStagedAttachments(namespace, saved).catch(() => {});
        throw error;
    }
}

/** Only these newly created URLs are safe to replay. Never trust a stored
 * blob URL, a file name, or the presence of a key as evidence of available bytes.
 */
export async function restoreStagedAttachments(namespace: string, snapshot: StagingSnapshot) {
    const availableBlobUris = new Set<string>();
    const messages = [];
    for (const message of snapshot.messages) {
        const attachments = [];
        for (const attachment of message.attachments ?? []) {
            let restored = attachment;
            if (attachment.stagingKey) {
                try {
                    const blob = await withAttachments<Blob | undefined>('readonly', store => store.get(keyFor(namespace, attachment.stagingKey!)));
                    if (blob instanceof Blob) {
                        const uri = URL.createObjectURL(blob);
                        availableBlobUris.add(uri);
                        restored = { ...attachment, uri };
                    }
                } catch { /* Retain the message and report unavailable files. */ }
            }
            attachments.push(restored);
        }
        messages.push({ ...message, ...(message.attachments ? { attachments } : {}) });
    }
    return { snapshot: { ...snapshot, messages }, availableBlobUris };
}

export async function deleteStagedAttachments(namespace: string, attachments: AttachmentPreview[]): Promise<void> {
    for (const attachment of attachments) {
        if (attachment.stagingKey) {
            await withAttachments('readwrite', store => store.delete(keyFor(namespace, attachment.stagingKey!)));
        }
    }
}

export async function clearStagedAttachments(namespaces: string[]): Promise<void> {
    for (const namespace of namespaces) {
        await withAttachments('readwrite', store => store.delete(IDBKeyRange.bound([namespace], [namespace, []])));
    }
}
