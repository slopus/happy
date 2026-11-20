import * as React from 'react';
import { getActiveAccountKey } from '@/auth/accountRuntime';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import type { SessionAttachmentSelection } from './useSessionAttachmentDraft';
// Keep local blob references for returning to a source session. A document reload
// releases them; no attachment bytes or authentication data are persisted here.
const drafts = new Map<string, AttachmentPreview[]>();
const listeners = new Set<() => void>();
const empty: AttachmentPreview[] = [];
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useSessionAttachmentDraft(sessionId: string): SessionAttachmentSelection {
    const key = JSON.stringify([getActiveAccountKey(), sessionId]);
    const images = React.useSyncExternalStore(subscribe, () => drafts.get(key) ?? empty, () => empty);
    const setImages = React.useCallback<SessionAttachmentSelection['setImages']>(update => {
        const next = typeof update === 'function' ? update(drafts.get(key) ?? empty) : update;
        if (next.length) drafts.set(key, next); else drafts.delete(key);
        listeners.forEach(listener => listener());
    }, [key]);
    return { images, setImages };
}
