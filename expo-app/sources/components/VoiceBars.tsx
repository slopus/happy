import React from 'react';
import { View } from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withRepeat,
    withSequence,
    withTiming,
    withDelay,
    cancelAnimation,
    Easing,
} from 'react-native-reanimated';

interface VoiceBarsProps {
    isActive: boolean;
    mode?: 'listening' | 'speaking';
    color?: string;
    size?: 'small' | 'medium' | 'large';
}

const SIZE_CONFIG = {
    small: { barWidth: 2, barHeight: 12, gap: 1.5, barCount: 3 },
    medium: { barWidth: 3, barHeight: 16, gap: 2, barCount: 3 },
    large: { barWidth: 3, barHeight: 20, gap: 2.5, barCount: 5 },
} as const;

// Different animation profiles for listening vs speaking
const MODE_CONFIG = {
    listening: { baseDuration: 400, durationVariance: 80, minScale: 0.25, maxScale: 0.85 },
    speaking: { baseDuration: 280, durationVariance: 60, minScale: 0.2, maxScale: 1.0 },
} as const;

function useBarAnimation(isActive: boolean, mode: 'listening' | 'speaking', index: number) {
    const scale = useSharedValue(0.3);

    React.useEffect(() => {
        if (isActive) {
            const config = MODE_CONFIG[mode];
            // Each bar gets slightly different timing for organic feel
            const duration = config.baseDuration + index * config.durationVariance;
            const delay = index * 60;

            scale.value = withDelay(
                delay,
                withRepeat(
                    withSequence(
                        withTiming(config.maxScale, {
                            duration,
                            easing: Easing.inOut(Easing.ease),
                        }),
                        withTiming(config.minScale, {
                            duration,
                            easing: Easing.inOut(Easing.ease),
                        }),
                    ),
                    -1, // infinite
                ),
            );
        } else {
            cancelAnimation(scale);
            scale.value = withTiming(0.3, { duration: 200 });
        }
    }, [isActive, mode, index]);

    return useAnimatedStyle(() => ({
        transform: [{ scaleY: scale.value }],
    }));
}

export const VoiceBars: React.FC<VoiceBarsProps> = ({
    isActive,
    mode = 'speaking',
    color = '#fff',
    size = 'small',
}) => {
    const { barWidth, barHeight, gap, barCount } = SIZE_CONFIG[size];

    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap,
            height: barHeight,
        }}>
            {Array.from({ length: barCount }, (_, i) => (
                <Bar
                    key={i}
                    index={i}
                    isActive={isActive}
                    mode={mode}
                    width={barWidth}
                    height={barHeight}
                    color={color}
                />
            ))}
        </View>
    );
};

const Bar = React.memo(({ index, isActive, mode, width, height, color }: {
    index: number;
    isActive: boolean;
    mode: 'listening' | 'speaking';
    width: number;
    height: number;
    color: string;
}) => {
    const animatedStyle = useBarAnimation(isActive, mode, index);

    return (
        <Animated.View style={[
            {
                width,
                height,
                backgroundColor: color,
                borderRadius: width,
                overflow: 'hidden',
            },
            animatedStyle,
        ]} />
    );
});
