import * as React from 'react';
import { Platform, ScrollView, ScrollViewProps } from 'react-native';

// Gesture-locked horizontal wheel scroll.
//
// The first wheel event of a trackpad gesture decides the axis: if horizontal
// movement clearly dominates (|deltaX| > |deltaY| * 2, min 3px) we lock to
// horizontal and drive scrollLeft ourselves; otherwise we lock to vertical and
// let every subsequent event pass through to the page. The lock resets after
// 150ms of idle (gesture ended). This avoids the two failure modes of pure
// per-event detection: slow vertical scrolls leaking tiny deltaX that gets
// misclassified, and fast diagonal swipes flickering between axes.
//
// Shift + wheel always converts vertical to horizontal (mouse wheel users).
// At scroll boundaries the event passes through so the page can scroll.
function useHorizontalWheelScroll() {
    const ref = React.useRef<ScrollView>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !ref.current) return;
        const node = (ref.current as any)?.getScrollableNode?.() ?? (ref.current as any);
        if (!node || !node.addEventListener) return;

        let gestureAxis: 'h' | 'v' | null = null;
        let gestureTimer = 0;

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

            // Reset gesture lock after 150ms idle.
            window.clearTimeout(gestureTimer);
            gestureTimer = window.setTimeout(() => { gestureAxis = null; }, 150);

            // Decide axis on the first event of the gesture.
            if (gestureAxis === null) {
                const absX = Math.abs(e.deltaX);
                const absY = Math.abs(e.deltaY);
                gestureAxis = (absX > absY * 2 && absX > 3) ? 'h' : 'v';
            }

            if (gestureAxis === 'v') return;

            // Horizontal-locked: scroll the element, unless at boundary.
            const atStart = el.scrollLeft <= 0 && e.deltaX < 0;
            const atEnd = el.scrollLeft >= maxScroll - 1 && e.deltaX > 0;
            if (atStart || atEnd) return;

            e.preventDefault();
            e.stopPropagation();
            el.scrollLeft += e.deltaX;
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => {
            node.removeEventListener('wheel', handler);
            window.clearTimeout(gestureTimer);
        };
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
