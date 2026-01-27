import * as React from 'react';
import { InteractionManager, Platform } from 'react-native';

export function useNewSessionDraftAutoPersist(params: Readonly<{
    persistDraftNow: () => void;
}>): void {
    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        if (draftSaveTimerRef.current) {
            clearTimeout(draftSaveTimerRef.current);
        }
        const delayMs = Platform.OS === 'web' ? 250 : 900;
        draftSaveTimerRef.current = setTimeout(() => {
            // Persisting uses synchronous storage under the hood (MMKV), which can block the JS thread on iOS.
            // Run after interactions so taps/animations stay responsive.
            if (Platform.OS === 'web') {
                params.persistDraftNow();
            } else {
                InteractionManager.runAfterInteractions(() => {
                    params.persistDraftNow();
                });
            }
        }, delayMs);
        return () => {
            if (draftSaveTimerRef.current) {
                clearTimeout(draftSaveTimerRef.current);
            }
        };
    }, [params.persistDraftNow]);
}

