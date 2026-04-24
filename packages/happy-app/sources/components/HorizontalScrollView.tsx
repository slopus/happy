import * as React from 'react';
import { Platform, ScrollView, ScrollViewProps } from 'react-native';

// Touchpad horizontal swipe (deltaX) scrolls the block. Vertical wheel (deltaY)
// only scrolls the block when Shift is held — otherwise let the page scroll.
// We drive scrollLeft ourselves instead of relying on native div overflow because
// react-native-web's ScrollView can intercept wheel events.
//
// Dominant-axis detection: only consume the event when horizontal movement
// clearly dominates (|deltaX| > |deltaY|) AND exceeds a 1px threshold.
// Trackpad vertical scrolls always leak a small deltaX — without this guard
// the handler would steal every scroll that crosses a code block or table.
// Boundary pass-through: when already scrolled to the edge, let the event
// propagate so the page can scroll normally.
function useHorizontalWheelScroll() {
    const ref = React.useRef<ScrollView>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !ref.current) return;
        const node = (ref.current as any)?.getScrollableNode?.() ?? (ref.current as any);
        if (!node || !node.addEventListener) return;
        const handler = (e: WheelEvent) => {
            const el = node as HTMLElement;
            const maxScroll = el.scrollWidth - el.clientWidth;
            if (maxScroll <= 0) return;

            // Shift + wheel: convert vertical wheel to horizontal scroll.
            if (e.shiftKey && e.deltaY !== 0) {
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += e.deltaY;
                return;
            }

            const absX = Math.abs(e.deltaX);
            const absY = Math.abs(e.deltaY);

            // Only consume horizontal-dominant gestures (trackpad swipe).
            // The threshold filters out tiny deltaX noise from vertical scrolls.
            if (absX > absY && absX > 1) {
                // At scroll boundary — let the page handle it.
                const atStart = el.scrollLeft <= 0 && e.deltaX < 0;
                const atEnd = el.scrollLeft >= maxScroll - 1 && e.deltaX > 0;
                if (atStart || atEnd) return;

                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += e.deltaX;
                return;
            }

            // Vertical-dominant or negligible deltaX — let the page scroll.
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
    }, []);
    return ref;
}

type Props = Omit<ScrollViewProps, 'horizontal'>;

export function HorizontalScrollView(props: Props) {
    const {
        showsHorizontalScrollIndicator = true,
        nestedScrollEnabled = true,
        ...rest
    } = props;
    const ref = useHorizontalWheelScroll();
    return (
        <ScrollView
            ref={ref}
            horizontal
            showsHorizontalScrollIndicator={showsHorizontalScrollIndicator}
            nestedScrollEnabled={nestedScrollEnabled}
            {...rest}
        />
    );
}
