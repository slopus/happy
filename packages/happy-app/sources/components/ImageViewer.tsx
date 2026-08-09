/**
 * Fullscreen, swipeable, pinch-to-zoom image viewer.
 *
 * Presented globally via the `imageViewer` store (see sync/imageViewer.ts) and
 * mounted once through `ImageViewerHost`. The viewer is a horizontal pager:
 * each page is one image with its own zoom/pan state, and a paging ScrollView
 * lets the user swipe left/right between every image in the run (Kimi-style).
 *
 * Per image:
 *   - pinch to zoom (clamped 1x–4x)
 *   - pan when zoomed in (bounded to image edges)
 *   - double-tap to toggle zoom
 *   - swipe-down (while at 1x) to dismiss, with backdrop fade
 *   - single tap / close button to dismiss
 *
 * Gesture vs. paging: while an image is at 1x, horizontal swipes belong to the
 * pager (the dismiss pan only claims vertical movement); once zoomed in, paging
 * is disabled so the pan can move the image freely. A counter ("2 / 5") shows
 * the position whenever there is more than one image.
 *
 * expo-image is used directly (no Unistyles) per the repo styling convention.
 */
import * as React from 'react';
import { View, Text, Pressable, useWindowDimensions, StyleSheet, Platform, ScrollView, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    runOnJS,
    interpolate,
    Extrapolation,
    SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ImageViewerSource } from '@/sync/imageViewer';
import { downloadImage } from '@/utils/imageDownload';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const CLOSE_TRANSLATE_Y = 120; // swipe-down distance that dismisses
const PAGE_OVERSCAN = 1;

interface ImageViewerProps {
    sources: ImageViewerSource[];
    initialIndex: number;
    onClose: () => void;
}

export function ImageViewer({ sources, initialIndex, onClose }: ImageViewerProps) {
    const { width: screenW, height: screenH } = useWindowDimensions();
    const insets = useSafeAreaInsets();

    const scrollRef = React.useRef<ScrollView>(null);
    const [currentIndex, setCurrentIndex] = React.useState(initialIndex);
    // Paging is disabled while the active image is zoomed in, so the pan gesture
    // can move the image instead of the pager swallowing the drag.
    const [pagingEnabled, setPagingEnabled] = React.useState(true);
    // Shared backdrop opacity — the active page's swipe-down drives the fade.
    const backdropOpacity = useSharedValue(1);
    const [downloadBusy, setDownloadBusy] = React.useState(false);

    // Android honors contentOffset unreliably; jump to the tapped image once we
    // know the screen width.
    const onScrollLayout = React.useCallback(() => {
        if (initialIndex > 0) {
            scrollRef.current?.scrollTo({ x: initialIndex * screenW, y: 0, animated: false });
        }
    }, [initialIndex, screenW]);

    const updateCurrentIndex = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const next = Math.max(0, Math.min(
            Math.round(e.nativeEvent.contentOffset.x / screenW),
            sources.length - 1,
        ));
        setCurrentIndex((prev) => (prev === next ? prev : next));
    }, [screenW, sources.length]);

    const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }));

    const single = sources.length === 1;
    const currentSource = sources[currentIndex];
    const windowStart = Math.max(0, currentIndex - PAGE_OVERSCAN);
    const windowEnd = Math.min(sources.length - 1, currentIndex + PAGE_OVERSCAN);
    const visibleSources = sources.slice(windowStart, windowEnd + 1);
    const leadingWidth = windowStart * screenW;
    const trailingWidth = Math.max(0, (sources.length - windowEnd - 1) * screenW);

    const handleZoomChange = React.useCallback((zoomed: boolean) => {
        setPagingEnabled(!zoomed);
    }, []);

    const handleDownload = React.useCallback(() => {
        if (!currentSource || downloadBusy) return;
        setDownloadBusy(true);
        void downloadImage(currentSource, { dialogTitle: t('imageViewer.download') })
            .catch((error) => {
                Modal.alert(
                    t('imageViewer.downloadFailedTitle'),
                    error instanceof Error ? error.message : t('imageViewer.downloadFailedMessage'),
                    [{ text: t('common.ok') }],
                );
            })
            .finally(() => setDownloadBusy(false));
    }, [currentSource, downloadBusy]);

    return (
        <View style={styles.root}>
            <Animated.View style={[styles.backdrop, backdropStyle]} />

            <ScrollView
                ref={scrollRef}
                horizontal
                pagingEnabled
                scrollEnabled={pagingEnabled && !single}
                showsHorizontalScrollIndicator={false}
                contentOffset={{ x: initialIndex * screenW, y: 0 }}
                onLayout={onScrollLayout}
                onScroll={updateCurrentIndex}
                onMomentumScrollEnd={updateCurrentIndex}
                scrollEventThrottle={16}
                decelerationRate="fast"
                style={styles.fill}
            >
                {leadingWidth > 0 && <View style={{ width: leadingWidth, height: screenH }} />}
                {visibleSources.map((source, relativeIndex) => {
                    const index = windowStart + relativeIndex;
                    return (
                        <ZoomablePage
                            key={`${index}-${source.uri}`}
                            source={source}
                            screenW={screenW}
                            screenH={screenH}
                            isActive={index === currentIndex}
                            backdropOpacity={backdropOpacity}
                            onZoomChange={handleZoomChange}
                            onClose={onClose}
                        />
                    );
                })}
                {trailingWidth > 0 && <View style={{ width: trailingWidth, height: screenH }} />}
            </ScrollView>

            {!single && (
                <View style={[styles.counter, { top: insets.top + 14, pointerEvents: 'none' }]}>
                    <Text style={styles.counterText}>{currentIndex + 1} / {sources.length}</Text>
                </View>
            )}

            <View style={[styles.topActions, { top: insets.top + 8 }]}>
                <Pressable
                    onPress={handleDownload}
                    hitSlop={8}
                    disabled={downloadBusy || !currentSource}
                    accessibilityRole="button"
                    accessibilityLabel={t('imageViewer.download')}
                    style={[styles.iconButton, downloadBusy && styles.iconButtonDisabled]}
                >
                    <Ionicons name={downloadBusy ? 'hourglass-outline' : 'download-outline'} size={22} color="#fff" />
                </Pressable>

                <Pressable
                    onPress={onClose}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('imageViewer.close')}
                    style={styles.iconButton}
                >
                    <Ionicons name="close" size={24} color="#fff" />
                </Pressable>
            </View>

            {currentSource?.onAction && currentSource.actionLabel && (
                <Pressable
                    onPress={currentSource.onAction}
                    hitSlop={8}
                    style={[styles.actionButton, { bottom: Math.max(insets.bottom + 22, 34) }]}
                >
                    <Ionicons name="camera-outline" size={18} color="#fff" />
                    <Text style={styles.actionText}>{currentSource.actionLabel}</Text>
                </Pressable>
            )}
        </View>
    );
}

interface ZoomablePageProps {
    source: ImageViewerSource;
    screenW: number;
    screenH: number;
    isActive: boolean;
    backdropOpacity: SharedValue<number>;
    onZoomChange: (zoomed: boolean) => void;
    onClose: () => void;
}

const ZoomablePage = React.memo<ZoomablePageProps>(({
    source,
    screenW,
    screenH,
    isActive,
    backdropOpacity,
    onZoomChange,
    onClose,
}) => {
    const { uri: fullResolutionUri } = useAttachmentImage(
        source.sessionId ?? '',
        source.attachmentRef,
        { lifetime: 'viewer' },
    );
    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const savedTranslateX = useSharedValue(0);
    const savedTranslateY = useSharedValue(0);

    // Drives the pan gesture's enabled-mode (zoomed = free move, else = dismiss).
    const [zoomed, setZoomed] = React.useState(false);

    const reset = React.useCallback((animated: boolean) => {
        const to = (v: number) => (animated ? withTiming(v, { duration: 200 }) : v);
        scale.value = to(1);
        savedScale.value = 1;
        translateX.value = to(0);
        translateY.value = to(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
    }, [scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

    const setZoomedJS = React.useCallback((v: boolean) => {
        setZoomed(v);
        onZoomChange(v);
    }, [onZoomChange]);

    // When this page scrolls out of view, snap it back to a clean 1x state so
    // returning to it later doesn't show a half-zoomed image, and re-enable
    // paging for the next page.
    React.useEffect(() => {
        if (!isActive) {
            reset(false);
            setZoomed(false);
            backdropOpacity.value = 1;
        }
    }, [isActive, reset, backdropOpacity]);

    const pinch = Gesture.Pinch()
        .onUpdate((e) => {
            const next = Math.max(1, Math.min(savedScale.value * e.scale, MAX_SCALE));
            scale.value = next;
        })
        .onEnd(() => {
            savedScale.value = scale.value;
            if (scale.value <= 1) {
                runOnJS(reset)(true);
                runOnJS(setZoomedJS)(false);
            } else {
                runOnJS(setZoomedJS)(true);
            }
        });

    // Move gesture — active only while zoomed in; free pan clamped to bounds.
    const movePan = Gesture.Pan()
        .enabled(zoomed)
        .onUpdate((e) => {
            const maxX = (screenW * (scale.value - 1)) / 2;
            const maxY = (screenH * (scale.value - 1)) / 2;
            translateX.value = Math.max(-maxX, Math.min(savedTranslateX.value + e.translationX, maxX));
            translateY.value = Math.max(-maxY, Math.min(savedTranslateY.value + e.translationY, maxY));
        })
        .onEnd(() => {
            savedTranslateX.value = translateX.value;
            savedTranslateY.value = translateY.value;
        });

    // Dismiss gesture — active only at 1x. Claims vertical drags only so that
    // horizontal swipes fall through to the pager ScrollView.
    const dismissPan = Gesture.Pan()
        .enabled(!zoomed)
        .activeOffsetY([-12, 12])
        .failOffsetX([-20, 20])
        .onUpdate((e) => {
            translateY.value = e.translationY;
            backdropOpacity.value = interpolate(
                Math.abs(e.translationY),
                [0, CLOSE_TRANSLATE_Y * 2],
                [1, 0.3],
                Extrapolation.CLAMP,
            );
        })
        .onEnd((e) => {
            if (Math.abs(e.translationY) > CLOSE_TRANSLATE_Y) {
                runOnJS(onClose)();
            } else {
                translateY.value = withTiming(0, { duration: 200 });
                backdropOpacity.value = withTiming(1, { duration: 200 });
            }
        });

    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
            if (scale.value > 1) {
                runOnJS(reset)(true);
                runOnJS(setZoomedJS)(false);
            } else {
                scale.value = withTiming(DOUBLE_TAP_SCALE, { duration: 200 });
                savedScale.value = DOUBLE_TAP_SCALE;
                runOnJS(setZoomedJS)(true);
            }
        });

    const singleTap = Gesture.Tap()
        .numberOfTaps(1)
        .onEnd(() => {
            runOnJS(onClose)();
        });

    const composed = Gesture.Exclusive(
        Gesture.Simultaneous(pinch, movePan, dismissPan),
        doubleTap,
        singleTap,
    );

    const imageStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
            { scale: scale.value },
        ],
    }));

    return (
        <GestureDetector gesture={composed}>
            <Animated.View style={[styles.page, { width: screenW, height: screenH }]}>
                <Animated.View style={[styles.imageWrap, imageStyle]}>
                    <Image
                        source={{ uri: fullResolutionUri ?? source.uri }}
                        style={{ width: screenW, height: screenH }}
                        contentFit="contain"
                        cachePolicy="none"
                        recyclingKey={source.attachmentRef ?? source.uri}
                        transition={150}
                    />
                </Animated.View>
            </Animated.View>
        </GestureDetector>
    );
});

const styles = StyleSheet.create({
    root: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 1000,
        ...(Platform.OS === 'web' ? { position: 'fixed' as any } : null),
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: '#000',
    },
    fill: {
        flex: 1,
    },
    page: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    imageWrap: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    counter: {
        position: 'absolute',
        alignSelf: 'center',
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: 14,
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    counterText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
    },
    topActions: {
        position: 'absolute',
        right: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    iconButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(0,0,0,0.4)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconButtonDisabled: {
        opacity: 0.55,
    },
    actionButton: {
        position: 'absolute',
        alignSelf: 'center',
        minHeight: 44,
        paddingHorizontal: 18,
        borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.18)',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(255,255,255,0.32)',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    actionText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '600',
    },
});
