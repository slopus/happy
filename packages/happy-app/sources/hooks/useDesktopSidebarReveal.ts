import * as React from 'react';

/** Transient desktop reveal; pointer travel never writes to persisted settings. */
export function useDesktopSidebarReveal(enabled: boolean, resizing: boolean) {
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
        if (hovered || focused || resizing) {
            wasEngaged.current = true;
            setVisible(true);
            return;
        }
        if (wasEngaged.current) {
            wasEngaged.current = false;
            closeTimer.current = setTimeout(() => setVisible(false), 220);
        }
        return cancelClose;
    }, [enabled, hovered, focused, resizing, cancelClose]);

    React.useEffect(() => cancelClose, [cancelClose]);
    const toggle = React.useCallback(() => {
        cancelClose();
        setVisible(value => !value);
    }, [cancelClose]);
    return { visible: enabled && visible, setHovered, setFocused, toggle };
}
