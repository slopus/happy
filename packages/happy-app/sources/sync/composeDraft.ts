import * as React from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
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
export type ComposeDraftState = {
    text: string;
    revision: number;
    discussing: boolean;
    setDiscussing: (value: boolean) => void;
    images: AttachmentPreview[];
    setText: (text: string) => void;
    setImages: (update: AttachmentPreview[] | ((current: AttachmentPreview[]) => AttachmentPreview[])) => void;
};
export function createComposeDraftStore(initial: { text: string; discussing?: boolean }, save: (draft: { text: string; discussing: boolean }) => void) {
    return create<ComposeDraftState>()((set, get) => ({
    text: initial.text, revision: 0, images: [],
    discussing: initial.discussing ?? false,
    setDiscussing: (discussing) => { save({ text: get().text, discussing }); set({ discussing }); },
    setText: (text) => {
        save({ text, discussing: get().discussing });
        set(state => text === state.text ? state : { text, revision: state.revision + 1 });
    },
    setImages: (update) => set(state => ({ images: typeof update === 'function' ? update(state.images) : update })),
}));
}
export type ComposeDraftStore = UseBoundStore<StoreApi<ComposeDraftState>>;
const defaultDraft = createComposeDraftStore({ text: draftStorage.getString('text') || '', discussing: draftStorage.getBoolean('discussing') ?? false }, value => {
    draftStorage.set('text', value.text); draftStorage.set('discussing', value.discussing);
});
const DraftContext = React.createContext<ComposeDraftStore | null>(null);
export function ComposeDraftProvider({ store, children }: React.PropsWithChildren<{ store: ComposeDraftStore }>) {
    return React.createElement(DraftContext.Provider, { value: store }, children);
}
export function useComposeDraftStore() { return React.useContext(DraftContext) ?? defaultDraft; }
const scopedSelectionGenerations = new WeakMap<ComposeDraftStore, typeof composeDraftAttachmentSelectionGeneration>();
export function useComposeDraftSelectionGeneration() {
    const store = useComposeDraftStore();
    if (store === defaultDraft) return composeDraftAttachmentSelectionGeneration;
    let generation = scopedSelectionGenerations.get(store);
    if (!generation) {
        let epoch = 0;
        generation = { currentDraftEpoch: () => epoch, invalidate: () => { epoch++; } };
        scopedSelectionGenerations.set(store, generation);
    }
    return generation;
}

function useScopedDraft(): ComposeDraftState;
function useScopedDraft<T>(selector: (state: ComposeDraftState) => T): T;
function useScopedDraft<T>(selector?: (state: ComposeDraftState) => T) {
    const store = useComposeDraftStore(); return store(selector ?? (state => state as T));
}
export const useComposeDraft = Object.assign(useScopedDraft, defaultDraft);

// Feature-scoped drafts can outlive their screen just like the ordinary draft.
// Register an inventory once per feature, rather than retaining every store.
const attachmentSources = new Set<() => boolean>();
export function registerComposeDraftAttachmentSource(source: () => boolean) {
    attachmentSources.add(source);
    return () => { attachmentSources.delete(source); };
}
export function hasComposeDraftAttachments() {
    return defaultDraft.getState().images.length > 0 || Array.from(attachmentSources).some(source => source());
}

export function clearComposeDraft() {
    // Logout owns the whole account-scoped compose namespace. A per-key CAS
    // delete would reject a draft written by another tab after hydration.
    draftStorage.clearAll();
    composeDraftAttachmentSelectionGeneration.invalidate();
    useComposeDraft.setState(state => ({ text: '', images: [], discussing: false, revision: state.revision + 1 }));
}
