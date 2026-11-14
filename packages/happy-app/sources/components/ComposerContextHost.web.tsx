import * as React from 'react';
import { createPortal } from 'react-dom';
import { View } from 'react-native';

/** Anchor to the composer while escaping the work area's clipped ancestors. */
export function ComposerContextHost({ children }: { children: React.ReactNode }) {
    const anchorRef = React.useRef<View>(null);
    const overlayRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState<React.CSSProperties>({ visibility: 'hidden' });
    React.useLayoutEffect(() => {
        const anchor = anchorRef.current as unknown as HTMLElement | null;
        const overlay = overlayRef.current;
        if (!anchor || !overlay) return;
        const update = () => {
            const rect = anchor.getBoundingClientRect();
            const viewport = window.visualViewport;
            const leftEdge = viewport?.offsetLeft ?? 0;
            const topEdge = viewport?.offsetTop ?? 0;
            const width = viewport?.width ?? window.innerWidth;
            const height = viewport?.height ?? window.innerHeight;
            const availableAbove = Math.max(80, rect.top - topEdge - 8);
            const maxHeight = Math.min(400, availableAbove, height - 16);
            const overlayHeight = Math.min(overlay.firstElementChild?.getBoundingClientRect().height ?? maxHeight, maxHeight);
            setPosition({ visibility: 'visible', left: Math.max(leftEdge + 8, Math.min(rect.left, leftEdge + width - Math.min(rect.width, 580) - 8)), top: Math.max(topEdge + 8, rect.top - overlayHeight - 8), width: Math.min(rect.width, 580, width - 16), maxHeight });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(anchor);
        if (overlay.firstElementChild) observer.observe(overlay.firstElementChild);
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        window.visualViewport?.addEventListener('resize', update);
        window.visualViewport?.addEventListener('scroll', update);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
            window.visualViewport?.removeEventListener('resize', update);
            window.visualViewport?.removeEventListener('scroll', update);
        };
    }, []);
    return <>
        <View ref={anchorRef} style={{ height: 0, width: '100%' }} />
        {typeof document !== 'undefined' && createPortal(<div ref={overlayRef} style={{ position: 'fixed', zIndex: 100000, display: 'flex', flexDirection: 'column', ...position }}>{children}</div>, document.body)}
    </>;
}
