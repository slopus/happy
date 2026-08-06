import * as React from 'react';

export const COMPOSER_ABORT_CONFIRMATION_TIMEOUT_MS = 2_000;

/**
 * Keeps the PC composer abort shortcut recoverable: the first Escape arms a
 * short confirmation window and only the next Escape (or the armed button)
 * invokes the abort callback.
 */
export function useComposerAbortConfirmation({
    enabled,
    onConfirm,
    timeoutMs = COMPOSER_ABORT_CONFIRMATION_TIMEOUT_MS,
}: {
    enabled: boolean;
    onConfirm: () => void;
    timeoutMs?: number;
}) {
    const [isArmed, setIsArmed] = React.useState(false);
    const armedRef = React.useRef(false);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const disarm = React.useCallback(() => {
        armedRef.current = false;
        setIsArmed(false);
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }, []);

    const confirm = React.useCallback(() => {
        if (!enabled || !armedRef.current) {
            return false;
        }

        disarm();
        onConfirm();
        return true;
    }, [disarm, enabled, onConfirm]);

    const handleEscape = React.useCallback(() => {
        if (!enabled) {
            return false;
        }

        if (armedRef.current) {
            return confirm();
        }

        armedRef.current = true;
        setIsArmed(true);
        timeoutRef.current = setTimeout(disarm, timeoutMs);
        return true;
    }, [confirm, disarm, enabled, timeoutMs]);

    React.useEffect(() => {
        if (!enabled) {
            disarm();
        }
    }, [disarm, enabled]);

    React.useEffect(() => () => {
        armedRef.current = false;
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }, []);

    return {
        confirm,
        handleEscape,
        isArmed,
    };
}
