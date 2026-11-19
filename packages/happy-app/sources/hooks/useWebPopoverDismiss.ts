import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

interface WebPopoverDismissOptions {
    enabled: boolean;
    isInside: (target: Node) => boolean;
    onDismiss: () => void;
}

/** Capture click-away even when a descendant stops bubbling or an ancestor clips a backdrop. */
export function useWebPopoverDismiss(options: WebPopoverDismissOptions) {
    const current = useRef(options);
    current.current = options;
    useEffect(() => {
        if (Platform.OS !== 'web' || !options.enabled || typeof document === 'undefined') return;
        const dismiss = (event: PointerEvent) => {
            if (event.button !== 0 || !(event.target instanceof Node)) return;
            if (!current.current.isInside(event.target)) current.current.onDismiss();
        };
        document.addEventListener('pointerdown', dismiss, true);
        return () => document.removeEventListener('pointerdown', dismiss, true);
    }, [options.enabled]);
}
