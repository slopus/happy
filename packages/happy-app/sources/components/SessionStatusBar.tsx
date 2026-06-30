import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UsageBar } from '@/components/usage/UsageBar';
import { t } from '@/text';
import {
    clampContextSize,
    getContextUsageLevel,
    getPathBasename,
    SESSION_STATUS_CONTEXT_MAX,
} from '@/utils/sessionStatusBar';

type StatusIconName = React.ComponentProps<typeof Ionicons>['name'];

type SessionStatusBarProps = {
    modelLabel: string | null;
    path: string | null | undefined;
    gitBranch: string | null | undefined;
    contextSize: number | null | undefined;
    onPathPress?: (path: string) => void;
};

export function SessionStatusBar(props: SessionStatusBarProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const path = props.path;
    const pathBasename = getPathBasename(props.path);
    const contextValue = clampContextSize(props.contextSize);
    const contextLevel = getContextUsageLevel(props.contextSize);
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
            {pathBasename && path ? (
                <StatusChip
                    icon="folder-outline"
                    text={pathBasename}
                    onPress={() => props.onPathPress?.(path)}
                />
            ) : null}
            {props.gitBranch ? (
                <StatusChip icon="git-branch-outline" text={props.gitBranch} />
            ) : null}
            <View style={styles.contextChip}>
                <UsageBar
                    label={t('session.statusBarContext')}
                    value={contextValue}
                    maxValue={SESSION_STATUS_CONTEXT_MAX}
                    color={contextColor}
                    showPercentage
                    height={3}
                    compact
                />
            </View>
        </View>
    );
}

function StatusChip(props: {
    icon: StatusIconName;
    text: string;
    onPress?: () => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const content = (
        <>
            <Ionicons name={props.icon} size={13} color={theme.colors.textSecondary} />
            <Text style={styles.chipText} numberOfLines={1} ellipsizeMode="middle">
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
        gap: 6,
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 2,
        flexWrap: 'wrap',
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
    contextChip: {
        minWidth: 116,
        maxWidth: 176,
        flexGrow: 1,
        flexShrink: 1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
}));
