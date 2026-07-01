import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Svg, { Circle } from 'react-native-svg';
import {
    clampContextSize,
    getContextUsageLevel,
    getContextUsagePercentage,
    SESSION_STATUS_CONTEXT_MAX,
} from '@/utils/sessionStatusBar';

type StatusIconName = React.ComponentProps<typeof Ionicons>['name'];

type SessionStatusBarProps = {
    modelLabel: string | null;
    effortLabel: string | null;
    contextSize: number | null | undefined;
    contextWindow?: number | null | undefined;
};

export function SessionStatusBar(props: SessionStatusBarProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const contextMaxValue = typeof props.contextWindow === 'number' && Number.isFinite(props.contextWindow) && props.contextWindow > 0
        ? Math.trunc(props.contextWindow)
        : SESSION_STATUS_CONTEXT_MAX;
    const contextValue = clampContextSize(props.contextSize, contextMaxValue);
    const contextPercentage = getContextUsagePercentage(props.contextSize, contextMaxValue);
    const contextLevel = getContextUsageLevel(props.contextSize, contextMaxValue);
    const contextColor = contextLevel === 'critical'
        ? theme.colors.warningCritical
        : contextLevel === 'warning'
            ? theme.colors.warning
            : theme.colors.status.connecting;

    return (
        <View style={styles.container}>
            {props.modelLabel ? (
                <StatusChip icon="hardware-chip-outline" text={props.modelLabel} />
            ) : null}
            {props.effortLabel ? (
                <StatusChip icon="flash-outline" text={props.effortLabel} />
            ) : null}
            <ContextUsageCircle
                value={contextValue}
                maxValue={contextMaxValue}
                percentage={contextPercentage}
                color={contextColor}
            />
        </View>
    );
}

export function SessionBranchBar(props: { gitBranch: string | null | undefined }) {
    if (!props.gitBranch) {
        return null;
    }

    return (
        <View style={stylesheet.branchContainer}>
            <StatusChip icon="git-branch-outline" text={props.gitBranch} wide />
        </View>
    );
}

function ContextUsageCircle(props: {
    value: number;
    maxValue: number;
    percentage: number;
    color: string;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const size = 30;
    const strokeWidth = 3;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = props.maxValue > 0 ? Math.min(100, Math.max(0, props.percentage)) : 0;
    const dashOffset = circumference * (1 - progress / 100);
    const label = `${Math.round(progress)}%`;
    const accessibilityLabel = `Context ${props.value.toLocaleString()} of ${props.maxValue.toLocaleString()} tokens, ${label}`;

    return (
        <View style={styles.contextCircle} accessibilityLabel={accessibilityLabel}>
            <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={theme.colors.divider}
                    strokeWidth={strokeWidth}
                    fill="none"
                />
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={props.color}
                    strokeWidth={strokeWidth}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${circumference} ${circumference}`}
                    strokeDashoffset={dashOffset}
                    rotation="-90"
                    originX={size / 2}
                    originY={size / 2}
                />
            </Svg>
            <Text style={styles.contextCircleText} numberOfLines={1} adjustsFontSizeToFit>
                {label}
            </Text>
        </View>
    );
}

function StatusChip(props: {
    icon: StatusIconName;
    text: string;
    onPress?: () => void;
    wide?: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const content = (
        <>
            <Ionicons name={props.icon} size={13} color={theme.colors.textSecondary} />
            <Text style={[styles.chipText, props.wide && styles.chipTextWide]} numberOfLines={1} ellipsizeMode="middle">
                {props.text}
            </Text>
        </>
    );

    if (props.onPress) {
        return (
            <Pressable
                style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                onPress={props.onPress}
                hitSlop={4}
            >
                {content}
            </Pressable>
        );
    }

    return (
        <View style={styles.chip}>
            {content}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 6,
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 2,
        flexWrap: 'nowrap',
    },
    branchContainer: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingHorizontal: 8,
        paddingTop: 0,
        paddingBottom: 4,
    },
    chip: {
        minHeight: 24,
        maxWidth: '100%',
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    chipPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    chipText: {
        minWidth: 0,
        maxWidth: 168,
        flexShrink: 1,
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '500',
    },
    chipTextWide: {
        maxWidth: 360,
    },
    contextCircle: {
        width: 30,
        height: 30,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 15,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    contextCircleText: {
        position: 'absolute',
        maxWidth: 24,
        color: theme.colors.textSecondary,
        fontSize: 9,
        fontWeight: '700',
        textAlign: 'center',
    },
}));
