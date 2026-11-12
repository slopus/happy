import { useEffect } from 'react';
import { Platform } from 'react-native';

/** Project dialogs own Escape before the application's route-back shortcut. */
export function useProjectModalEscape(onClose: () => void, busy = false) {
    useEffect(() => {
        if (Platform.OS !== 'web') return;
        const close = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (!busy) onClose();
        };
        window.addEventListener('keydown', close, true);
        return () => window.removeEventListener('keydown', close, true);
    }, [onClose, busy]);
}
