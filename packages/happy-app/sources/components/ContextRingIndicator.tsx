import React from 'react';
import { View, Text, Platform } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

const SIZE = 24;
const STROKE_WIDTH = 2.5;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ContextRingIndicatorProps {
    /** 0–100 percentage of context already used */
    percentageUsed: number;
}

function getRingColor(percentRemaining: number, theme: { colors: { success: string; warning: string; warningCritical: string } }) {
    if (percentRemaining <= 5) return theme.colors.warningCritical;
    if (percentRemaining <= 15) return theme.colors.warning;
    return theme.colors.success;
}

export const ContextRingIndicator = React.memo(function ContextRingIndicator({ percentageUsed }: ContextRingIndicatorProps) {
    const { theme } = useUnistyles();
    const clamped = Math.max(0, Math.min(100, percentageUsed));
    const percentRemaining = 100 - clamped;
    const strokeDashoffset = CIRCUMFERENCE * (1 - clamped / 100);
    const ringColor = getRingColor(percentRemaining, theme);

    return (
        <View style={{
            width: SIZE,
            height: SIZE,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <Svg width={SIZE} height={SIZE}>
                {/* Background track */}
                <Circle
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={RADIUS}
                    stroke={theme.colors.divider}
                    strokeWidth={STROKE_WIDTH}
                    fill="none"
                />
                {/* Filled arc — starts from 12 o'clock */}
                <Circle
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={RADIUS}
                    stroke={ringColor}
                    strokeWidth={STROKE_WIDTH}
                    fill="none"
                    strokeDasharray={`${CIRCUMFERENCE}`}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    rotation={-90}
                    origin={`${SIZE / 2}, ${SIZE / 2}`}
                />
            </Svg>
            {/* Center percentage text */}
            <Text style={{
                position: 'absolute',
                fontSize: 7,
                color: ringColor,
                ...Typography.default('semiBold'),
                // Vertically center the text; web needs a small nudge
                ...(Platform.OS === 'web' ? { top: 7.5 } : {}),
            }}>
                {Math.round(percentRemaining)}
            </Text>
        </View>
    );
});
