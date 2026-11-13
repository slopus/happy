import { useEffect, useMemo, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/storage';
import { useIsFocused } from '@react-navigation/native';

interface UseDraftOptions {
    autoSaveInterval?: number;
}

// Each session owns its pending value and timer. Editing only reschedules the
// timer; leaving the session flushes its latest text, including input captured
// synchronously before a deferred React mirror commits.
export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    { autoSaveInterval = 2000 }: UseDraftOptions = {},
) {
    const isFocused = useIsFocused();
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const draft = useMemo(() => {
        const state = {
            value,
            saved: value,
            usesInputNotifications: false,
            clearedValue: null as string | null,
            focused: isFocused,
            timer: null as ReturnType<typeof setTimeout> | null,
            cancel() {
                if (state.timer !== null) clearTimeout(state.timer);
                state.timer = null;
            },
            flush() {
                state.cancel();
                if (!sessionId || state.value === state.saved) return;
                storage.getState().updateSessionDraft(sessionId, state.value);
                state.saved = state.value;
            },
        };
        return state;
        // Value deliberately seeds only a new session, never an ordinary edit.
    }, [sessionId]);

    useEffect(() => {
        const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
            if (next === 'background' || next === 'inactive') draft.flush();
        });
        return () => {
            subscription.remove();
            draft.flush();
        };
    }, [draft]);

    useEffect(() => {
        if (draft.usesInputNotifications) return;
        if (draft.clearedValue === value) return;
        draft.clearedValue = null;
        draft.value = value;
    }, [draft, value]);

    useEffect(() => {
        const regainedFocus = isFocused && !draft.focused;
        draft.focused = isFocused;
        if (!sessionId || !isFocused || (draft.clearedValue !== null && !regainedFocus)) return;
        const saved = storage.getState().sessions[sessionId]?.draft ?? '';
        if (saved !== draft.value && ((regainedFocus && draft.value === draft.saved) || (!draft.value && !draft.usesInputNotifications && saved))) {
            draft.cancel();
            draft.value = saved;
            draft.saved = saved;
            draft.usesInputNotifications = true;
            draft.clearedValue = null;
            onChangeRef.current(saved);
        }
    }, [draft, sessionId, isFocused]);

    const scheduleSave = useCallback(() => {
        draft.cancel();
        if (draft.value !== draft.saved) {
            if (!isFocused || !draft.value.trim() !== !draft.saved.trim()) {
                draft.flush();
            } else {
                draft.timer = setTimeout(() => draft.flush(), autoSaveInterval);
            }
        }
    }, [draft, isFocused, autoSaveInterval]);

    useEffect(() => {
        // A delayed mirror must neither replace newer input nor restart its
        // debounce deadline. Session cleanup owns cancellation and flushing.
        if (!draft.usesInputNotifications) scheduleSave();
        else if (!isFocused) draft.flush();
    }, [draft, value, isFocused, scheduleSave]);

    const updateDraft = useCallback((text: string) => {
        draft.usesInputNotifications = true;
        draft.clearedValue = null;
        draft.value = text;
        scheduleSave();
    }, [draft, scheduleSave]);

    const clearDraft = useCallback(() => {
        draft.cancel();
        // The composer may unmount before its cleared value renders. Suppress
        // the sent value until the next actual edit instead of resurrecting it.
        draft.clearedValue = draft.value;
        draft.value = '';
        draft.saved = '';
        if (sessionId) storage.getState().updateSessionDraft(sessionId, null);
    }, [draft, sessionId]);

    const flushDraft = useCallback((text?: string) => {
        if (text !== undefined) {
            draft.value = text;
            draft.usesInputNotifications = true;
        }
        draft.flush();
    }, [draft]);

    return { clearDraft, updateDraft, flushDraft };
}
