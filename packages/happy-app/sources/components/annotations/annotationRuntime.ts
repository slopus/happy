import { useSyncExternalStore, useCallback } from 'react';
import { MMKV } from 'react-native-mmkv';
import { v4 as uuid } from 'uuid';
import { accountStorageId, accountRuntimeCurrent } from '@/auth/accountRuntime';
import { createAnnotationDraftStore, EMPTY_ANNOTATIONS } from './annotationDraft';

// Reuse the account's primary persistence namespace: logout clears these drafts
// together with the existing session drafts via clearPersistence().
const storageId = accountStorageId();
const storage = storageId ? new MMKV({ id: storageId }) : new MMKV();
export const annotationDraftStore = createAnnotationDraftStore({
    read: id => storage.getString(`message-annotation-v1:${id}`),
    write: (id, value) => storage.set(`message-annotation-v1:${id}`, value),
    newId: uuid,
    isCurrent: accountRuntimeCurrent,
});
export function useMessageAnnotations(sessionId: string) {
    return useSyncExternalStore(annotationDraftStore.subscribe,
        useCallback(() => annotationDraftStore.getSnapshot(sessionId), [sessionId]), () => EMPTY_ANNOTATIONS);
}
