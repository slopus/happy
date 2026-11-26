import * as React from 'react';

export function useActivityDisclosure({ open, defaultOpen = false, onOpenChange }: {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
}) {
    const [localOpen, setLocalOpen] = React.useState(defaultOpen);
    const controlled = open !== undefined;
    const value = open ?? localOpen;
    const current = React.useRef(value);
    current.current = value;
    const setOpen = React.useCallback((next: boolean) => {
        if (next === current.current) return;
        if (!controlled) {
            current.current = next;
            setLocalOpen(next);
        }
        onOpenChange?.(next);
    }, [controlled, onOpenChange]);
    const toggle = React.useCallback(() => setOpen(!current.current), [setOpen]);
    return { open: value, setOpen, toggle };
}
