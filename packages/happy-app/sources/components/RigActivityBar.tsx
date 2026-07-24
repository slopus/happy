import * as React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { Metadata } from '@/sync/storageTypes';
import { getRigActivityIndicators } from '@/sync/rig';

const iconByKey = {
    subagents: 'people-outline',
    workflows: 'git-network-outline',
    processes: 'terminal-outline',
    tasks: 'checkbox-outline',
} as const;

const labelByKey = {
    subagents: 'agents',
    workflows: 'workflows',
    processes: 'processes',
    tasks: 'tasks',
} as const;

export const RigActivityBar = React.memo(function RigActivityBar({ metadata }: { metadata: Metadata | null }) {
    const { theme } = useUnistyles();
    const indicators = getRigActivityIndicators(metadata);
    if (indicators.length === 0) return null;

    return (
        <View style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 5,
            alignItems: 'center',
        }}>
            {indicators.map((indicator) => (
                <View key={indicator.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name={iconByKey[indicator.key]} size={12} color={theme.colors.textSecondary} />
                    <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {indicator.count}{indicator.queued ? ` +${indicator.queued} queued` : ''} {labelByKey[indicator.key]}
                    </Text>
                </View>
            ))}
        </View>
    );
});
