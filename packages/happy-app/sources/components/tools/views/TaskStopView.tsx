import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { t } from '@/text';

export const TaskStopView = React.memo<ToolViewProps>(({ tool }) => {
    const input = tool.input as { task_id?: string; description?: string } | undefined;
    const taskId = input?.task_id;
    const description = input?.description;
    const label = description || taskId || null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {label ? (
                    <Text style={styles.label} numberOfLines={2}>{label}</Text>
                ) : null}
                {tool.state === 'completed' ? (
                    <Text style={styles.status}>{t('tools.taskStop.stopped')}</Text>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 6,
    },
    label: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    status: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
}));
