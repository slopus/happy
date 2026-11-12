import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useModal } from '@/modal';

/** Project dialogs own Escape; a nested confirmation owns the whole key gesture. */
export function useProjectModalEscape(onClose: () => void, busy = false) {
    const { state, dismissTopModal } = useModal();
    const pending = useRef(false);
    useEffect(() => {
        if (Platform.OS !== 'web') return;
        const close = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (event.repeat || pending.current) return;
            pending.current = true;
            if (state.modals.length) dismissTopModal();
            else if (!busy) onClose();
        };
        // RN Web also handles Escape on keyup. Do not let the same gesture
        // reach the newly exposed outer dialog after cancelling its confirm.
        const release = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || !pending.current) return;
            pending.current = false;
            event.preventDefault(); event.stopImmediatePropagation();
        };
        window.addEventListener('keydown', close, true);
        window.addEventListener('keyup', release, true);
        return () => { window.removeEventListener('keydown', close, true); window.removeEventListener('keyup', release, true); };
    }, [onClose, busy, state.modals.length, dismissTopModal]);
}
