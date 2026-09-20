import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/storage';
import { isRigMetadataV1 } from '@/sync/rig';
import { rigComposerClear, rigComposerSetText } from '@/sync/rigComposer';
import { useIsFocused } from '@react-navigation/native';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
}

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000 } = options;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingDraft = useRef<string | null>(null);
    // Seed with the initial value so a pre-hydrated draft (e.g. ChatComposer
    // reads storage synchronously on mount) doesn't trip the autosave into
    // re-writing what we just loaded.
    const lastSavedValue = useRef<string>(value);
    const isFocused = useIsFocused();
    // Happy Agent sessions sync the draft through metadata: every edit goes to
    // the mirror at once (the writer debounces the network), and remote edits
    // come back through the store.
    const isSynced = !!sessionId && isRigMetadataV1(storage.getState().sessions[sessionId]?.metadata);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!sessionId) return;

        // Record first: the store notifies its subscribers synchronously.
        lastSavedValue.current = draft;
        pendingDraft.current = null;
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        // Read the session at call time so a composer that mounted before metadata
        // arrived does not write an unstamped local-only draft.
        if (isRigMetadataV1(storage.getState().sessions[sessionId]?.metadata)) {
            rigComposerSetText(sessionId, draft);
        } else {
            storage.getState().updateSessionDraft(sessionId, draft);
        }
    }, [sessionId]);

    // Load draft on mount and when focused
    useEffect(() => {
        if (!sessionId || !isFocused) return;

        const session = storage.getState().sessions[sessionId];
        if (session?.draft && !value) {
            onChange(session.draft);
            lastSavedValue.current = session.draft;
        } else if (!session?.draft) {
            // Ensure lastSavedValue is empty if there's no draft
            lastSavedValue.current = '';
        }
    }, [sessionId, isFocused, onChange]);

    // The store reconciles remote writes. Applying one is not a local edit.
    useEffect(() => {
        if (!sessionId || !isSynced) return;
        return storage.subscribe((state, previous) => {
            const draft = state.sessions[sessionId]?.draft ?? '';
            if (draft === (previous.sessions[sessionId]?.draft ?? '') || draft === lastSavedValue.current) return;
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
            pendingDraft.current = null;
            lastSavedValue.current = draft;
            onChange(draft);
        });
    }, [sessionId, isSynced, onChange]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!sessionId) return;

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }
        pendingDraft.current = null;

        // Only save if value has changed
        if (value !== lastSavedValue.current) {
            const wasEmpty = !lastSavedValue.current.trim();
            const isEmpty = !value.trim();

            if (isSynced || wasEmpty !== isEmpty) {
                // State transition: empty <-> non-empty
                // Save immediately for instant feedback
                saveDraft(value);
            } else if (!isEmpty) {
                // Text is being modified (non-empty to non-empty)
                // Debounce to avoid excessive saves
                pendingDraft.current = value;
                saveTimeoutRef.current = setTimeout(() => {
                    saveDraft(value);
                }, autoSaveInterval);
            }
            // If both are empty, no need to save
        }

        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [value, sessionId, autoSaveInterval, saveDraft, isSynced]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!sessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                if (pendingDraft.current !== null) {
                    saveDraft(pendingDraft.current);
                }
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [sessionId, saveDraft]);

    // Flush only an actual pending edit, never the value from an older render.
    useEffect(() => {
        return () => {
            if (sessionId && pendingDraft.current !== null) {
                saveDraft(pendingDraft.current);
            }
        };
    }, [sessionId, saveDraft]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!sessionId) return;

        lastSavedValue.current = '';
        pendingDraft.current = null;
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        if (isRigMetadataV1(storage.getState().sessions[sessionId]?.metadata)) {
            rigComposerClear(sessionId);
        } else {
            storage.getState().updateSessionDraft(sessionId, null);
        }
    }, [sessionId]);

    return {
        clearDraft
    };
}
