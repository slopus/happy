import * as React from 'react';
import { Platform, ScrollView, ScrollViewProps } from 'react-native';

// Gesture-locked horizontal wheel scroll.
//
// Trackpad swipes ramp up from 1-2px deltas, so deciding the axis solely on
// the first event of a gesture misclassifies nearly every real horizontal
// swipe as vertical (and momentum-tail events keep re-arming the stale lock).
// Instead the lock is asymmetric: 'h' is sticky until 150ms of idle, while
// 'v' is soft — any clearly horizontal event (|deltaX| > |deltaY|, min 2px)
// upgrades the gesture to 'h' mid-flight. Vertical scrolls with 1px deltaX
// noise stay vertical, and a purely vertical event during an 'h' lock is
// passed back to the outer list so chat scrolling never goes dead.
//
// Events we don't consume bubble up to the inverted chat list, whose
// react-native-web wheel handler swallows them unless a nested horizontal
// scroller can take them natively (see
// patches/fix-rnw-inverted-wheel-horizontal.cjs) — that native path also
// covers sub-2px slow swipes that the lock ignores.
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

            // 'h' is sticky until idle; 'v' is soft and can upgrade mid-gesture.
            const absX = Math.abs(e.deltaX);
            const absY = Math.abs(e.deltaY);
            if (gestureAxis !== 'h') {
                if (absX > absY && absX >= 2) gestureAxis = 'h';
                else if (gestureAxis === null) gestureAxis = 'v';
            }

            if (gestureAxis === 'v') return;

            // 'h'-locked but purely vertical event: give it back to the list.
            if (e.deltaX === 0 && absY > 0) return;

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
