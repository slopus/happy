import * as React from 'react';
import { View, Platform } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    runOnJS,
    useAnimatedScrollHandler,
    clamp,
    useDerivedValue,
    SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

interface FastScrollbarProps {
    /** Animated scroll offset shared value */
    scrollY: SharedValue<number>;
    /** Total content height */
    contentHeight: number;
    /** Visible container height */
    containerHeight: number;
    /** Callback when user drags the scrollbar */
    onScrollTo: (offset: number) => void;
    /** Whether the list is inverted (for chat-style lists) */
    inverted?: boolean;
}

/**
 * A draggable scrollbar component that allows fast scrolling.
 * Appears on the right side of the screen and can be dragged up/down.
 * Uses Reanimated shared values to avoid JS re-renders.
 */
export const FastScrollbar = React.memo((props: FastScrollbarProps) => {
    const { scrollY, contentHeight, containerHeight, onScrollTo, inverted = false } = props;
    const { theme } = useUnistyles();

    // Animation values
    const thumbOpacity = useSharedValue(0.4);
    const isDragging = useSharedValue(false);
    const startScrollOffset = useSharedValue(0);

    // Calculate scrollbar dimensions
    const scrollableHeight = Math.max(0, contentHeight - containerHeight);
    const scrollbarTrackHeight = Math.max(0, containerHeight - 32);
    const scrollbarThumbHeight = Math.max(
        50, // Minimum thumb height for easy grabbing
        Math.min(scrollbarTrackHeight * 0.8, (containerHeight / Math.max(1, contentHeight)) * scrollbarTrackHeight)
    );
    const maxThumbOffset = Math.max(0, scrollbarTrackHeight - scrollbarThumbHeight);

    // Show scrollbar when content is scrollable
    const isScrollable = contentHeight > containerHeight && containerHeight > 0;

    // Derive thumb position from scroll offset (runs on UI thread)
    const thumbTranslateY = useDerivedValue(() => {
        if (scrollableHeight <= 0 || maxThumbOffset <= 0) return 0;

        const normalizedPosition = clamp(scrollY.value / scrollableHeight, 0, 1);
        return inverted
            ? maxThumbOffset - (normalizedPosition * maxThumbOffset)
            : normalizedPosition * maxThumbOffset;
    }, [scrollableHeight, maxThumbOffset, inverted]);

    // Pan gesture for dragging - with larger activation area
    const panGesture = Gesture.Pan()
        .activateAfterLongPress(0)
        .minDistance(0)
        .onBegin(() => {
            'worklet';
            isDragging.value = true;
            startScrollOffset.value = scrollY.value;
            thumbOpacity.value = withTiming(1, { duration: 100 });
        })
        .onUpdate((e) => {
            'worklet';
            if (scrollableHeight <= 0 || maxThumbOffset <= 0) return;

            const deltaY = e.translationY;
            // Convert thumb movement to scroll offset
            // For inverted lists, dragging down should decrease scroll offset
            const scrollDelta = inverted
                ? -(deltaY / maxThumbOffset) * scrollableHeight
                : (deltaY / maxThumbOffset) * scrollableHeight;
            const newOffset = clamp(startScrollOffset.value + scrollDelta, 0, scrollableHeight);
            runOnJS(onScrollTo)(newOffset);
        })
        .onEnd(() => {
            'worklet';
            isDragging.value = false;
            thumbOpacity.value = withTiming(0.4, { duration: 300 });
        })
        .onFinalize(() => {
            'worklet';
            isDragging.value = false;
            thumbOpacity.value = withTiming(0.4, { duration: 300 });
        });

    const thumbStyle = useAnimatedStyle(() => ({
        opacity: thumbOpacity.value,
        transform: [{ translateY: thumbTranslateY.value }],
    }));

    // Don't render on web - browsers have native scrollbars
    if (Platform.OS === 'web' || !isScrollable) {
        return null;
    }

    return (
        <View style={styles.container}>
            <View style={[styles.track, { height: scrollbarTrackHeight }]}>
                <GestureDetector gesture={panGesture}>
                    <Animated.View
                        style={[
                            styles.thumb,
                            { height: scrollbarThumbHeight, backgroundColor: theme.colors.textSecondary },
                            thumbStyle
                        ]}
                    />
                </GestureDetector>
            </View>
        </View>
    );
});

/**
 * Custom hook to create scroll handler and shared value for FastScrollbar.
 * Returns the scroll handler to attach to FlatList/ScrollView and the shared value.
 * @param onScrollOffsetChange Optional callback to receive scroll offset updates on JS thread
 */
export function useFastScrollbar(onScrollOffsetChange?: (offset: number) => void) {
    const scrollY = useSharedValue(0);

    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollY.value = event.contentOffset.y;
            if (onScrollOffsetChange) {
                runOnJS(onScrollOffsetChange)(event.contentOffset.y);
            }
        },
    });

    return { scrollY, scrollHandler };
}

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'absolute',
        right: 0,
        top: 16,
        bottom: 16,
        width: 28,
        alignItems: 'center',
        justifyContent: 'flex-start',
        zIndex: 1000,
    },
    track: {
        width: 28,
        alignItems: 'center',
        justifyContent: 'flex-start',
    },
    thumb: {
        width: 6,
        borderRadius: 3,
    },
}));
