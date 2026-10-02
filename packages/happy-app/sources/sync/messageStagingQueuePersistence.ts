import { MMKV } from 'react-native-mmkv';
import { v4 as uuid } from 'uuid';
import { accountStorageId } from '@/auth/accountRuntime';
import type { StagingSnapshot } from './messageStagingQueue';

let mmkv: MMKV | undefined;
let initialization: Promise<void> | undefined;
const index = new MMKV({ id: accountStorageId('message-staging-index')! });
function namespaces(): string[] {
    try {
        const value = JSON.parse(index.getString('namespaces') ?? '[]');
        return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.startsWith('message-staging-')) : [];
    } catch { return []; }
}

export function clearMessageStagingStorage() {
    for (const name of namespaces()) new MMKV({ id: accountStorageId(name)! }).clearAll();
    index.clearAll();
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
        mmkv = new MMKV({ id: accountStorageId(name)! });
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
                    && typeof m.text === 'string' && m.modeMeta && typeof m.modeMeta === 'object'
                    && ['queued', 'sending', 'failed'].includes(m.status)
                    && (m.attachments === undefined || (Array.isArray(m.attachments) && m.attachments.every((a: any) => a && typeof a.uri === 'string' && typeof a.id === 'string'))))) return value;
        } catch { /* Start empty if the local cache is invalid. */ }
        return { messages: [], barriers: {} };
    },
    save(snapshot: StagingSnapshot) {
        if (!mmkv) throw new Error('Queue storage not ready');
        mmkv.set('queue-v1', JSON.stringify(snapshot));
    },
};
