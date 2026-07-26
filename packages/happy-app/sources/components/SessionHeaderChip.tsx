import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';

/**
 * Header chip for an open session — mirrors the home screen's machine/agent
 * "modelChip" but reflects the *current* session instead of the new-session
 * draft. It's read-only metadata (an already-running session can't change its
 * machine/agent), so tapping it drops down a session-info panel rather than a
 * picker. Lives in the chat header where the breadcrumb title used to be.
 */
interface SessionHeaderChipProps {
    agentLabel: string;
    machineName: string | null;
    online: boolean;
    /** Whether the info dropdown is currently open (controls the chevron direction). */
    open: boolean;
    onPress: () => void;
}

export const SessionHeaderChip = React.memo(({ agentLabel, machineName, online, open, onPress }: SessionHeaderChipProps) => {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={onPress}
            hitSlop={8}
            style={styles.chip}
            testID="session-header-chip"
        >
            <Text style={styles.agent} numberOfLines={1}>{agentLabel}</Text>
            <View style={[styles.dot, { backgroundColor: online ? theme.colors.status.connected : theme.colors.status.disconnected }]} />
            {machineName ? (
                <Text style={styles.machine} numberOfLines={1}>{machineName}</Text>
            ) : null}
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={theme.colors.textSecondary} />
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        maxWidth: 230,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    agent: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
        flexShrink: 1,
    },
    machine: {
        ...Typography.mono(),
        fontSize: 11,
        color: theme.colors.textSecondary,
        flexShrink: 1,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
}));
