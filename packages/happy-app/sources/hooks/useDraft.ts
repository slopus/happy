import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage, getSession } from '@/sync/storage';
import { useIsFocused } from '@react-navigation/native';
import type { SessionDraft } from '@/sync/storageTypes';
import type { LocalImage } from '@/components/ImagePreview';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
}

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    images: LocalImage[],
    onImagesChange: (images: LocalImage[]) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000 } = options;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedRef = useRef<{ text: string; imageCount: number }>({ text: '', imageCount: 0 });
    const isFocused = useIsFocused();

    // Save draft to storage
    const saveDraft = useCallback((text: string, imgs: LocalImage[]) => {
        if (!sessionId) return;

        const draft: SessionDraft = { text, images: imgs };
        storage.getState().updateSessionDraft(sessionId, draft);
        lastSavedRef.current = { text, imageCount: imgs.length };
    }, [sessionId]);

    // Load draft on mount and when focused
    useEffect(() => {
        if (!sessionId || !isFocused) return;

        const session = getSession(sessionId);
        if (session?.draft) {
            if (!value) {
                onChange(session.draft.text);
            }
            if (session.draft.images.length > 0 && images.length === 0) {
                onImagesChange(session.draft.images);
            }
            lastSavedRef.current = { text: session.draft.text, imageCount: session.draft.images.length };
        } else {
            lastSavedRef.current = { text: '', imageCount: 0 };
        }
    }, [sessionId, isFocused, onChange, onImagesChange]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!sessionId) return;

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        const hasTextChanged = value !== lastSavedRef.current.text;
        const hasImagesChanged = images.length !== lastSavedRef.current.imageCount;

        if (hasTextChanged || hasImagesChanged) {
            const wasEmpty = !lastSavedRef.current.text.trim() && lastSavedRef.current.imageCount === 0;
            const isEmpty = !value.trim() && images.length === 0;

            if (wasEmpty !== isEmpty) {
                // State transition: empty <-> non-empty — save immediately
                saveDraft(value, images);
            } else if (!isEmpty) {
                // Content is being modified — debounce
                saveTimeoutRef.current = setTimeout(() => {
                    saveDraft(value, images);
                }, autoSaveInterval);
            }
        }

        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [value, images, sessionId, autoSaveInterval, saveDraft]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!sessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                const hasTextChanged = value !== lastSavedRef.current.text;
                const hasImagesChanged = images.length !== lastSavedRef.current.imageCount;
                if (hasTextChanged || hasImagesChanged) {
                    saveDraft(value, images);
                }
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);
        return () => { subscription.remove(); };
    }, [sessionId, value, images, saveDraft]);

    // Save on unmount
    useEffect(() => {
        return () => {
            if (sessionId) {
                const hasTextChanged = value !== lastSavedRef.current.text;
                const hasImagesChanged = images.length !== lastSavedRef.current.imageCount;
                if (hasTextChanged || hasImagesChanged) {
                    saveDraft(value, images);
                }
            }
        };
    }, [sessionId, value, images, saveDraft]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!sessionId) return;

        storage.getState().updateSessionDraft(sessionId, null);
        lastSavedRef.current = { text: '', imageCount: 0 };
    }, [sessionId]);

    return { clearDraft };
}
