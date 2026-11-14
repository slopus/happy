import * as React from 'react';
import { createPortal } from 'react-dom';
import type { View } from 'react-native';

/** Follow the actual input panel, including attachment growth, before paint. */
export function ComposerContextHost({ children, anchorRef }: { children: React.ReactNode; anchorRef: React.RefObject<View | null> }) {
    const overlayRef = React.useRef<HTMLDivElement>(null);
    const updateRef = React.useRef<() => void>(() => {});
    React.useLayoutEffect(() => {
        const anchor = anchorRef.current as unknown as HTMLElement | null;
        const overlay = overlayRef.current;
        if (!anchor || !overlay) return;
        const update = () => {
            const rect = anchor.getBoundingClientRect();
            const viewport = window.visualViewport;
            const top = viewport?.offsetTop ?? 0;
            const left = viewport?.offsetLeft ?? 0;
            const width = viewport?.width ?? window.innerWidth;
            Object.assign(overlay.style, {
                visibility: 'visible',
                left: `${Math.max(left, Math.min(rect.left, left + width - Math.min(rect.width, width)))}px`,
                bottom: `${window.innerHeight - rect.top}px`,
                width: `${Math.min(rect.width, width)}px`,
                maxHeight: `${Math.max(80, Math.min(400, rect.top - top))}px`,
            });
        };
        updateRef.current = update;
        // Size changes cover textarea wrapping and attachment thumbnails. Style
        // mutations on ancestors cover layout transitions that only move it.
        const resize = new ResizeObserver(update);
        const mutation = new MutationObserver(update);
        let node: HTMLElement | null = anchor;
        for (let depth = 0; node && node !== document.body && depth < 6; depth++, node = node.parentElement) {
            resize.observe(node);
            mutation.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
        }
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        window.visualViewport?.addEventListener('resize', update);
        window.visualViewport?.addEventListener('scroll', update);
        update();
        return () => {
            updateRef.current = () => {};
            resize.disconnect(); mutation.disconnect();
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
            window.visualViewport?.removeEventListener('resize', update);
            window.visualViewport?.removeEventListener('scroll', update);
        };
    }, [anchorRef]);
    React.useLayoutEffect(() => updateRef.current());
    return typeof document === 'undefined' ? null : createPortal(
        <div ref={overlayRef} style={{ position: 'fixed', zIndex: 100000, display: 'flex', flexDirection: 'column', visibility: 'hidden' }}>{children}</div>, document.body,
    );
}
