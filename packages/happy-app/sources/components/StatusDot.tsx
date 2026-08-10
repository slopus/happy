import * as React from 'react';
import { ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
    /** Outline instead of fill — same glyph, for sessions that are no longer running. */
    hollow?: boolean;
}

export const StatusDot = React.memo(({ color, isPulsing, size = 6, style, hollow }: StatusDotProps) => {
    const opacity = useSharedValue(1);

    React.useEffect(() => {
        if (isPulsing) {
            opacity.value = withRepeat(
                withTiming(0.3, { duration: 1000 }),
                -1, // infinite
                true // reverse
            );
        } else {
            opacity.value = withTiming(1, { duration: 200 });
        }
    }, [isPulsing]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: opacity.value,
        };
    });

    const baseStyle: ViewStyle = hollow
        ? {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1,
            borderColor: color,
            backgroundColor: 'transparent',
        }
        : {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
        };

    return (
        <Animated.View
            style={[
                baseStyle,
                animatedStyle,
                style
            ]}
        />
    );
});