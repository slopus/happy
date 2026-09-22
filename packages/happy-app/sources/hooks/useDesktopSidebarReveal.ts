import * as React from 'react';

/** Transient desktop reveal; pointer travel never writes to persisted settings. */
export function useDesktopSidebarReveal(enabled: boolean, resizing: boolean, pinned = false) {
    const [visible, setVisible] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);

    const wasEngaged = React.useRef(false);
    const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelClose = React.useCallback(() => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current);
        closeTimer.current = null;
    }, []);

    React.useEffect(() => {
        cancelClose();
        if (!enabled) {
            wasEngaged.current = false;
            setVisible(false);
            return;
        }
        if (pinned || hovered || focused || resizing) {
            wasEngaged.current = true;
            setVisible(true);
            return;
        }
        if (wasEngaged.current) {
            wasEngaged.current = false;
            closeTimer.current = setTimeout(() => setVisible(false), 220);
        }
        return cancelClose;
    }, [enabled, pinned, hovered, focused, resizing, cancelClose]);

    React.useEffect(() => cancelClose, [cancelClose]);
    // Explicit collapse takes priority over existing pointer/focus engagement.
    // A new enter/focus event can reveal again after the user returns.
    const dismiss = React.useCallback(() => {
        cancelClose();
        wasEngaged.current = false;
        setVisible(false);
        setHovered(false);
        setFocused(false);
    }, [cancelClose]);
    return { visible: enabled && (pinned || visible), setHovered, setFocused, dismiss };
}
