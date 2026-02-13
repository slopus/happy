/**
 * STT Waveform Visualization
 *
 * Audio level visualization component for the STT overlay.
 */

import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    withSpring,
    withTiming,
    interpolate,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

// =============================================================================
// Types
// =============================================================================

export interface STTWaveformProps {
    /** Current audio level (0-1) */
    level: number;
    /** Number of bars to display */
    barCount?: number;
    /** Whether actively recording */
    isRecording?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BAR_COUNT = 5;
const MIN_BAR_HEIGHT = 8;
const MAX_BAR_HEIGHT = 40;
const BAR_WIDTH = 4;
const BAR_GAP = 6;

// =============================================================================
// Styles
// =============================================================================

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        height: MAX_BAR_HEIGHT + 16,
        paddingVertical: 8,
    },
    bar: {
        width: BAR_WIDTH,
        borderRadius: BAR_WIDTH / 2,
        backgroundColor: theme.colors.tint,
        marginHorizontal: BAR_GAP / 2,
    },
    barInactive: {
        backgroundColor: theme.colors.textSecondary,
    },
}));

// =============================================================================
// Bar Component
// =============================================================================

interface WaveformBarProps {
    index: number;
    level: number;
    isRecording: boolean;
    totalBars: number;
}

const WaveformBar = React.memo<WaveformBarProps>(({ index, level, isRecording, totalBars }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    // Calculate bar height based on position and level
    // Center bars are taller, edge bars are shorter
    const centerIndex = (totalBars - 1) / 2;
    const distanceFromCenter = Math.abs(index - centerIndex);
    const positionMultiplier = 1 - (distanceFromCenter / (centerIndex + 1)) * 0.5;

    // Add some randomness based on index for natural feel
    const randomOffset = React.useMemo(() => {
        return (Math.sin(index * 1.5) * 0.3 + 1);
    }, [index]);

    const animatedStyle = useAnimatedStyle(() => {
        const effectiveLevel = isRecording ? level : 0;

        // Calculate height
        const baseHeight = interpolate(
            effectiveLevel,
            [0, 1],
            [MIN_BAR_HEIGHT, MAX_BAR_HEIGHT]
        );

        const height = baseHeight * positionMultiplier * randomOffset;

        return {
            height: withSpring(Math.max(MIN_BAR_HEIGHT, height), {
                damping: 15,
                stiffness: 150,
                mass: 0.5,
            }),
            opacity: withTiming(isRecording ? 1 : 0.4, { duration: 200 }),
        };
    }, [level, isRecording, positionMultiplier, randomOffset]);

    return (
        <Animated.View
            style={[
                styles.bar,
                !isRecording && styles.barInactive,
                animatedStyle,
            ]}
        />
    );
});

WaveformBar.displayName = 'WaveformBar';

// =============================================================================
// Main Component
// =============================================================================

export const STTWaveform = React.memo<STTWaveformProps>(({
    level,
    barCount = DEFAULT_BAR_COUNT,
    isRecording = true,
}) => {
    const styles = stylesheet;

    // Generate bar indices
    const barIndices = React.useMemo(() => {
        return Array.from({ length: barCount }, (_, i) => i);
    }, [barCount]);

    return (
        <View style={styles.container}>
            {barIndices.map((index) => (
                <WaveformBar
                    key={index}
                    index={index}
                    level={level}
                    isRecording={isRecording}
                    totalBars={barCount}
                />
            ))}
        </View>
    );
});

STTWaveform.displayName = 'STTWaveform';
