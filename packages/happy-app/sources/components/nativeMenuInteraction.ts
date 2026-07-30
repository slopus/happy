import * as React from 'react';

export const NATIVE_MENU_DISMISS_DELAY_MS = 220;

type DeferredAction = () => void;

/**
 * SwiftUI dismisses a Menu after invoking its action. Deferring the callback
 * lets that dismissal finish before React presents another surface or updates
 * the trigger, while replacing a pending action prevents stale selections.
 */
export function useDeferredNativeMenuAction() {
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (timeoutRef.current !== null) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, []);

    return React.useCallback((action: DeferredAction) => {
        if (timeoutRef.current !== null) {
            clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            if (mountedRef.current) {
                action();
            }
        }, NATIVE_MENU_DISMISS_DELAY_MS);
    }, []);
}
