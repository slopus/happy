import * as React from 'react';
import { Platform, ScrollView, ScrollViewProps } from 'react-native';

// Horizontal wheel scroll for tables/code blocks inside the inverted chat list.
//
// Two things conspire to kill horizontal trackpad swipes here, so this handler
// both claims the event and applies the scroll itself:
//
// 1. The chat is an inverted FlatList, and react-native-web's inverted-wheel
//    patch (react-native-web#995, still unfixed upstream — see #2418) attaches
//    a wheel listener on the list's scroll node that calls preventDefault() on
//    every event while only ever applying deltaY. That listener is on an
//    ancestor in the bubble phase, so stopPropagation() here keeps the event
//    away from it.
// 2. Chromium does not natively scroll a nested horizontal scroller when an
//    ancestor is transformed with scaleY(-1) — which is exactly how the
//    inverted list is built. Verified with a standalone repro: identical
//    markup scrolls natively without the transform and not at all with it,
//    with no JS handlers involved. So stopPropagation() alone is not enough;
//    nothing would move. We apply scrollLeft by hand.
//
// The axis is decided per event rather than locked for the gesture: a lock
// that stays horizontal would swallow the vertical events of a following
// gesture (trackpad momentum carries fractional deltaX noise, so "is deltaX
// exactly 0" is not a safe escape hatch) and leave chat scrolling dead.
// Anything vertical-dominant is left alone and bubbles to the list.
//
// At a horizontal boundary the event also bubbles, so the list's
// preventDefault() suppresses the browser's back/forward swipe gesture.
//
// Shift + wheel converts vertical wheel to horizontal scroll for mouse users.
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

            // Room left to move in the direction the delta points.
            const canScroll = (delta: number) => delta < 0
                ? el.scrollLeft > 0
                : delta > 0 && el.scrollLeft < maxScroll - 1;

            // Shift + wheel: convert vertical wheel to horizontal scroll.
            if (e.shiftKey && e.deltaY !== 0) {
                if (!canScroll(e.deltaY)) return;
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += e.deltaY;
                return;
            }

            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && canScroll(e.deltaX)) {
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += e.deltaX;
            }
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
