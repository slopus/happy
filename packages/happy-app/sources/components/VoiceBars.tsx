import React, { useEffect, useRef } from 'react';
import { View, Animated } from 'react-native';

interface VoiceBarsProps {
    isActive: boolean;
    color?: string;
    size?: 'small' | 'medium';
    mode?: 'speaking' | 'thinking';
}

export const VoiceBars: React.FC<VoiceBarsProps> = ({
    isActive,
    color = '#fff',
    size = 'small',
    mode = 'speaking',
}) => {
    const bar1 = useRef(new Animated.Value(0.3)).current;
    const bar2 = useRef(new Animated.Value(0.3)).current;
    const bar3 = useRef(new Animated.Value(0.3)).current;

    useEffect(() => {
        if (isActive) {
            if (mode === 'thinking') {
                // Slow synchronized pulse for thinking state
                const bars = [bar1, bar2, bar3];
                bars.forEach((bar) => {
                    Animated.loop(
                        Animated.sequence([
                            Animated.timing(bar, {
                                toValue: 0.6,
                                duration: 600,
                                useNativeDriver: true,
                            }),
                            Animated.timing(bar, {
                                toValue: 0.3,
                                duration: 600,
                                useNativeDriver: true,
                            }),
                        ]),
                    ).start();
                });
            } else {
                // Fast staggered animation for speaking state
                const animate = (bar: Animated.Value, duration: number, delay: number = 0) => {
                    Animated.loop(
                        Animated.sequence([
                            Animated.delay(delay),
                            Animated.timing(bar, {
                                toValue: 1,
                                duration: duration,
                                useNativeDriver: true,
                            }),
                            Animated.timing(bar, {
                                toValue: 0.3,
                                duration: duration,
                                useNativeDriver: true,
                            }),
                        ])
                    ).start();
                };

                animate(bar1, 300, 0);
                animate(bar2, 350, 100);
                animate(bar3, 400, 200);
            }
        } else {
            // Stop all animations
            bar1.stopAnimation();
            bar2.stopAnimation();
            bar3.stopAnimation();

            // Reset to static state
            Animated.parallel([
                Animated.timing(bar1, { toValue: 0.3, duration: 200, useNativeDriver: true }),
                Animated.timing(bar2, { toValue: 0.3, duration: 200, useNativeDriver: true }),
                Animated.timing(bar3, { toValue: 0.3, duration: 200, useNativeDriver: true }),
            ]).start();
        }
    }, [isActive, mode, bar1, bar2, bar3]);

    const barWidth = size === 'small' ? 2 : 3;
    const barHeight = size === 'small' ? 12 : 16;
    const gap = size === 'small' ? 1.5 : 2;

    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap,
            height: barHeight
        }}>
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar1 }],
                overflow: 'hidden',
            }} />
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar2 }],
                overflow: 'hidden',
            }} />
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar3 }],
                overflow: 'hidden',
            }} />
        </View>
    );
};
