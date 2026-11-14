import { isAnnotation } from '@/components/annotations/annotationDraft';
import { MMKV } from 'react-native-mmkv';
import { v4 as uuid } from 'uuid';
import { accountStorageId } from '@/auth/accountRuntime';
import type { StagingSnapshot } from './messageStagingQueue';
import { clearStagedAttachments, deleteStagedAttachments } from './stagedAttachmentStorage';

let mmkv: MMKV | undefined;
let initialization: Promise<void> | undefined;
let namespace: string | undefined;
const index = new MMKV({ id: accountStorageId('message-staging-index')! });
function namespaces(): string[] {
    try {
        const value = JSON.parse(index.getString('namespaces') ?? '[]');
        return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.startsWith('message-staging-')) : [];
    } catch { return []; }
}

export async function clearMessageStagingStorage() {
    const names = namespaces().map(name => accountStorageId(name)!);
    // Keep the namespace index until byte cleanup succeeds, so a failed logout
    // can retry rather than leaving inaccessible local originals behind.
    await clearStagedAttachments(names);
    for (const name of names) new MMKV({ id: name }).clearAll();
    index.clearAll();
}

export function getMessageStagingNamespace(): string {
    if (!namespace) throw new Error('Queue storage not ready');
    return namespace;
}

// Duplicate tabs inherit sessionStorage, but cannot inherit ownership of the
// original document's queue. Hold the Web Lock until the document is destroyed.
export function initializeMessageStagingPersistence(): Promise<void> {
    initialization ??= (async () => {
        let suffix = 'native';
        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
            const key = 'paws-staging-tab';
            suffix = window.sessionStorage.getItem(key) || uuid();
            const claim = (id: string) => new Promise<boolean>((resolve, reject) => {
                void navigator.locks.request(accountStorageId(`message-staging-${id}`)!, { ifAvailable: true }, async lock => {
                    resolve(!!lock);
                    if (lock) await new Promise<void>(() => { /* document lifetime */ });
                }).catch(reject);
            });
            if (navigator.locks) {
                if (!await claim(suffix)) {
                    suffix = uuid();
                    if (!await claim(suffix)) throw new Error('Queue ownership unavailable');
                }
            } else {
                // Without Web Locks, never automatically replay a copied queue.
                suffix = uuid();
            }
            window.sessionStorage.setItem(key, suffix);
        }
        const name = `message-staging-${suffix}`;
        index.set('namespaces', JSON.stringify([...new Set([...namespaces(), name])]));
        namespace = accountStorageId(name)!;
        mmkv = new MMKV({ id: namespace });
    })();
    return initialization;
}
export const messageStagingPersistence = {
    load(): StagingSnapshot {
        try {
            const value = JSON.parse(mmkv?.getString('queue-v1') ?? 'null');
            if (value && Array.isArray(value.messages) && value.barriers && typeof value.barriers === 'object'
                && !Array.isArray(value.barriers)
                && Object.values(value.barriers).every((b: any) => b && typeof b.sawRunning === 'boolean' && (b.turnId === undefined || typeof b.turnId === 'string'))
                && value.messages.every((m: any) => m && typeof m.id === 'string' && typeof m.sessionId === 'string'
                    && (m.preparedText === undefined || typeof m.preparedText === 'string') && typeof m.text === 'string' && (m.draftText === undefined || typeof m.draftText === 'string')
                    && (m.displayText === undefined || typeof m.displayText === 'string')
                    && (m.expiredAttachmentIds === undefined || (Array.isArray(m.expiredAttachmentIds) && m.expiredAttachmentIds.every((id: unknown) => typeof id === 'string')))
                    && (m.annotations === undefined || (Array.isArray(m.annotations) && m.annotations.every(isAnnotation)))
                    && (m.fileReference === undefined || (m.fileReference && typeof m.fileReference.path === 'string' && typeof m.fileReference.hash === 'string' && (m.fileReference.quote === undefined || typeof m.fileReference.quote === 'string')))
                    && m.modeMeta && typeof m.modeMeta === 'object'
                    && ['queued', 'sending', 'failed'].includes(m.status)
                    && (m.attachments === undefined || (Array.isArray(m.attachments) && m.attachments.every((a: any) => a && typeof a.uri === 'string' && typeof a.id === 'string' && (a.stagingKey === undefined || typeof a.stagingKey === 'string')))))) return value;
        } catch { /* Start empty if the local cache is invalid. */ }
        return { messages: [], barriers: {} };
    },
    save(snapshot: StagingSnapshot) {
        if (!mmkv) throw new Error('Queue storage not ready');
        const previous = messageStagingPersistence.load();
        mmkv.set('queue-v1', JSON.stringify(snapshot));
        const retained = new Set(snapshot.messages.flatMap(message => message.attachments?.map(attachment => attachment.stagingKey) ?? []));
        const removed = previous.messages.flatMap(message => message.attachments?.filter(attachment => attachment.stagingKey && !retained.has(attachment.stagingKey)) ?? []);
        // The queue is committed before releasing its copies. A taken-back
        // message keeps its live URL for editing and gets fresh keys if requeued.
        if (removed.length) void deleteStagedAttachments(getMessageStagingNamespace(), removed).catch(() => {});
    },
};
