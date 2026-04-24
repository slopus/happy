import * as React from 'react';
import { Platform, ScrollView, ScrollViewProps } from 'react-native';

// Touchpad horizontal swipe (deltaX) scrolls the block. Vertical wheel (deltaY)
// only scrolls the block when Shift is held — otherwise let the page scroll.
// We drive scrollLeft ourselves instead of relying on native div overflow because
// react-native-web's ScrollView can intercept wheel events.
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

            // Any horizontal intent (touchpad) — consume the whole event so the
            // page doesn't scroll vertically at the same time.
            if (e.deltaX !== 0) {
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += e.deltaX;
                return;
            }

            // Shift + wheel: convert vertical wheel to horizontal scroll.
            if (e.shiftKey && e.deltaY !== 0) {
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += e.deltaY;
                return;
            }

            // Plain vertical wheel without Shift — let the page scroll.
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
    });
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
