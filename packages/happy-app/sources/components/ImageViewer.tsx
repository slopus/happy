/**
 * Fullscreen, pinch-to-zoom image viewer (native: iOS / Android).
 *
 * Opened via `Modal.show({ component: ImageViewer, props: { uri } })`. Because
 * it is presented inside React Native's `<Modal>` (via BaseModal), gestures
 * only work if the content is wrapped in its OWN `GestureHandlerRootView` — the
 * app-root one does not extend into the modal's separate native hierarchy.
 *
 * Web has a separate implementation in `ImageViewer.web.tsx` (wheel + drag).
 */
import * as React from 'react';
import { StyleSheet, useWindowDimensions, Pressable, Platform } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView, GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;

interface ImageViewerProps {
    uri: string;
    onClose: () => void;
}

export function ImageViewer({ uri, onClose }: ImageViewerProps) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();

    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const tx = useSharedValue(0);
    const ty = useSharedValue(0);
    const savedTx = useSharedValue(0);
    const savedTy = useSharedValue(0);

    // Keep the image from being panned entirely off-screen: at scale S the
    // image overflows the viewport by (S-1) on each axis, so allow half of
    // that overflow as translation in each direction.
    const clamp = (val: number, scaleVal: number, dim: number) => {
        'worklet';
        const max = (dim * (scaleVal - 1)) / 2;
        return Math.min(max, Math.max(-max, val));
    };

    const pinch = Gesture.Pinch()
        .onUpdate((e) => {
            scale.value = Math.min(MAX_SCALE, Math.max(0.8, savedScale.value * e.scale));
        })
        .onEnd(() => {
            if (scale.value <= 1) {
                scale.value = withTiming(1);
                tx.value = withTiming(0);
                ty.value = withTiming(0);
                savedScale.value = 1;
                savedTx.value = 0;
                savedTy.value = 0;
            } else {
                savedScale.value = scale.value;
                tx.value = clamp(tx.value, scale.value, width);
                ty.value = clamp(ty.value, scale.value, height);
                savedTx.value = tx.value;
                savedTy.value = ty.value;
            }
        });

    const pan = Gesture.Pan()
        .onUpdate((e) => {
            if (savedScale.value <= 1) return; // pan only when zoomed in
            tx.value = clamp(savedTx.value + e.translationX, savedScale.value, width);
            ty.value = clamp(savedTy.value + e.translationY, savedScale.value, height);
        })
        .onEnd(() => {
            savedTx.value = tx.value;
            savedTy.value = ty.value;
        });

    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
            if (scale.value > 1) {
                scale.value = withTiming(1);
                tx.value = withTiming(0);
                ty.value = withTiming(0);
                savedScale.value = 1;
                savedTx.value = 0;
                savedTy.value = 0;
            } else {
                scale.value = withTiming(DOUBLE_TAP_SCALE);
                savedScale.value = DOUBLE_TAP_SCALE;
            }
        });

    // Race so pan/pinch activate immediately on movement (no double-tap delay);
    // a real double-tap has no movement so it wins the race instead.
    const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: tx.value },
            { translateY: ty.value },
            { scale: scale.value },
        ],
    }));

    return (
        <GestureHandlerRootView style={[styles.root, { width, height }]}>
            <GestureDetector gesture={gesture}>
                <Animated.View style={[styles.imageWrap, animatedStyle, { width, height }]}>
                    <Image
                        source={{ uri }}
                        style={{ width, height }}
                        contentFit="contain"
                        transition={Platform.OS === 'android' ? 0 : 120}
                    />
                </Animated.View>
            </GestureDetector>
            <Pressable
                onPress={onClose}
                hitSlop={16}
                style={[styles.close, { top: Math.max(insets.top, 12) + 4 }]}
                accessibilityRole="button"
                accessibilityLabel="Close image"
            >
                <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    root: {
        backgroundColor: '#000',
        alignItems: 'center',
        justifyContent: 'center',
    },
    imageWrap: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    close: {
        position: 'absolute',
        right: 12,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
});
