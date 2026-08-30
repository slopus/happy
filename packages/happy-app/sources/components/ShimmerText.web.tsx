import React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { Text } from '@/components/StyledText';

export interface ShimmerTextProps {
    text: string;
    style?: StyleProp<TextStyle>;
    baseColor: string;
    highlightColor: string;
}

/** CSS gradient text keeps the shimmer crisp in Expo web, where masking is a no-op. */
export const ShimmerText = React.memo(({
    text,
    style,
    baseColor,
    highlightColor,
}: ShimmerTextProps) => {
    const reduceMotion = useReducedMotion();

    return (
        <View
            style={styles.container}
            {...(!reduceMotion ? ({ dataSet: { happySessionTitleShimmer: true } } as any) : {})}
        >
            <Text
                style={[
                    style,
                    reduceMotion
                        ? { color: baseColor }
                        : styles.shimmer,
                    !reduceMotion && ({
                        backgroundImage: `linear-gradient(110deg, ${baseColor} 35%, ${highlightColor} 50%, ${baseColor} 65%)`,
                        backgroundSize: '300% 100%',
                        backgroundRepeat: 'no-repeat',
                        backgroundClip: 'text',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                    } as any),
                ]}
                numberOfLines={1}
            >
                {text}
            </Text>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
    },
    shimmer: {
        color: 'transparent',
    },
});