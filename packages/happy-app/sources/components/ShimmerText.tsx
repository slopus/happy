import React from 'react';
import type { LayoutChangeEvent, StyleProp, TextStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
    cancelAnimation,
    Easing,
    Extrapolation,
    interpolate,
    ReduceMotion,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/StyledText';

const SWEEP_DURATION = 1700;
const SWEEP_PAUSE = 650;
const SWEEP_FRACTION = SWEEP_DURATION / (SWEEP_DURATION + SWEEP_PAUSE);
const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

export interface ShimmerTextProps {
    text: string;
    style?: StyleProp<TextStyle>;
    baseColor: string;
    highlightColor: string;
}

/** A quiet, text-clipped progress sweep for native Expo surfaces. */
export const ShimmerText = React.memo(({
    text,
    style,
    baseColor,
    highlightColor,
}: ShimmerTextProps) => {
    const progress = useSharedValue(0);
    const reduceMotion = useReducedMotion();
    const [width, setWidth] = React.useState(0);

    React.useEffect(() => {
        cancelAnimation(progress);
        progress.value = 0;

        if (reduceMotion) return;

        progress.value = withRepeat(
            withTiming(1, {
                duration: SWEEP_DURATION + SWEEP_PAUSE,
                easing: Easing.linear,
                reduceMotion: ReduceMotion.System,
            }),
            -1,
            false,
            undefined,
            ReduceMotion.System,
        );

        return () => cancelAnimation(progress);
    }, [progress, reduceMotion]);

    const bandWidth = Math.max(44, width * 0.4);
    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{
            translateX: interpolate(
                progress.value,
                [0, SWEEP_FRACTION, 1],
                [-bandWidth, width, width],
                Extrapolation.CLAMP,
            ),
        }],
    }), [bandWidth, width]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        setWidth(event.nativeEvent.layout.width);
    }, []);

    if (reduceMotion) {
        return (
            <Text style={[style, { color: baseColor }]} numberOfLines={1}>
                {text}
            </Text>
        );
    }

    return (
        <View
            style={styles.container}
            onLayout={handleLayout}
            accessible
            accessibilityRole="text"
            accessibilityLabel={text}
        >
            <Text
                style={[style, { color: baseColor }]}
                numberOfLines={1}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                {text}
            </Text>
            {width > 0 && (
                <MaskedView
                    style={StyleSheet.absoluteFillObject}
                    pointerEvents="none"
                    maskElement={(
                        <View style={StyleSheet.absoluteFillObject}>
                            <Text style={style} numberOfLines={1}>
                                {text}
                            </Text>
                        </View>
                    )}
                >
                    <View style={[StyleSheet.absoluteFillObject, { backgroundColor: baseColor }]} />
                    <AnimatedLinearGradient
                        colors={[baseColor, highlightColor, baseColor]}
                        locations={[0, 0.5, 1]}
                        start={{ x: 0, y: 1 }}
                        end={{ x: 1, y: 0 }}
                        style={[
                            styles.band,
                            { width: bandWidth },
                            animatedStyle,
                        ]}
                    />
                </MaskedView>
            )}
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
        overflow: 'hidden',
    },
    band: {
        position: 'absolute',
        top: 0,
        bottom: 0,
    },
});