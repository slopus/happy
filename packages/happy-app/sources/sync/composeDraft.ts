import { create } from 'zustand';
import type { AttachmentPreview } from './attachmentTypes';
import { MMKV } from '@/persistence/deviceStorage';
import { accountStorageId } from '@/auth/accountRuntime';

const draftStorage = new MMKV({ id: accountStorageId('compose-draft') });

let attachmentDraftEpoch = 0;

export const composeDraftAttachmentSelectionGeneration = {
    currentDraftEpoch: () => attachmentDraftEpoch,
    invalidate: () => {
        attachmentDraftEpoch++;
    },
};

// Text survives account reloads. File/blob references remain memory-only;
// account switching explicitly warns before discarding attachments.
export const useComposeDraft = create<{
    text: string;
    revision: number;
    discussing: boolean;
    setDiscussing: (value: boolean) => void;
    images: AttachmentPreview[];
    setText: (text: string) => void;
    setImages: (update: AttachmentPreview[] | ((current: AttachmentPreview[]) => AttachmentPreview[])) => void;
}>((set) => ({
    text: draftStorage.getString('text') || '', revision: 0, images: [],
    discussing: draftStorage.getBoolean('discussing') ?? false,
    setDiscussing: (discussing) => { draftStorage.set('discussing', discussing); set({ discussing }); },
    setText: (text) => {
        draftStorage.set('text', text);
        set(state => text === state.text ? state : { text, revision: state.revision + 1 });
    },
    setImages: (update) => set(state => ({ images: typeof update === 'function' ? update(state.images) : update })),
}));

export function clearComposeDraft() {
    // Logout owns the whole account-scoped compose namespace. A per-key CAS
    // delete would reject a draft written by another tab after hydration.
    draftStorage.clearAll();
    composeDraftAttachmentSelectionGeneration.invalidate();
    useComposeDraft.setState(state => ({ text: '', images: [], discussing: false, revision: state.revision + 1 }));
}
