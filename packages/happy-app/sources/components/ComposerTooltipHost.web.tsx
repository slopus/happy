import * as React from 'react';
import { createPortal } from 'react-dom';
import { View } from 'react-native';
import { composerTooltipPosition } from '@/utils/composerTooltipPosition';

/** Keep the hint anchored to its control while escaping clipped composer/panel ancestors. */
export function ComposerTooltipHost({ children, visible }: { children: React.ReactNode; visible: boolean }) {
    const anchorRef = React.useRef<View>(null);
    const overlayRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null);

    React.useLayoutEffect(() => {
        if (!visible) {
            setPosition(null);
            return;
        }
        const anchor = anchorRef.current as unknown as HTMLElement | null;
        const overlay = overlayRef.current;
        if (!anchor || !overlay) return;
        const update = () => {
            const bounds = anchor.getBoundingClientRect();
            const hint = overlay.firstElementChild?.getBoundingClientRect();
            const next = composerTooltipPosition(bounds, { width: hint?.width ?? 0, height: hint?.height ?? 0 }, { width: window.innerWidth, height: window.innerHeight });
            setPosition(previous => previous && Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(anchor);
        if (overlay.firstElementChild) observer.observe(overlay.firstElementChild);
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [visible, children]);

    if (!visible || typeof document === 'undefined') return null;
    return <>
        <View ref={anchorRef} pointerEvents="none" style={{ position: 'absolute', inset: 0 }} />
        {createPortal(<div ref={overlayRef} style={{
            position: 'fixed', zIndex: 100000, pointerEvents: 'none',
            visibility: position ? 'visible' : 'hidden',
            ...position,
        }}>{children}</div>, document.body)}
    </>;
}
