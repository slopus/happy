import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { OrchestratorExecutionStatus, OrchestratorRunStatus, OrchestratorTaskStatus } from '@/sync/apiOrchestrator';
import { getStatusColor, getStatusLabel } from './status';

type AnyStatus = OrchestratorRunStatus | OrchestratorTaskStatus | OrchestratorExecutionStatus;

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    text: {
        fontSize: 12,
        fontWeight: '600',
    },
}));

export function OrchestratorStatusBadge({ status }: { status: AnyStatus }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const color = getStatusColor(theme, status);

    return (
        <View style={[styles.badge, { borderColor: color }]}>
            <Text style={[styles.text, { color }]}>{getStatusLabel(status)}</Text>
        </View>
    );
}
