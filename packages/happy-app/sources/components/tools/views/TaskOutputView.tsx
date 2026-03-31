import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { CodeView } from '../../CodeView';
import { t } from '@/text';

export const TaskOutputView = React.memo<ToolViewProps>(({ tool }) => {
    const input = tool.input as { description?: string; task_id?: string; block?: boolean } | undefined;
    const description = input?.description;
    const taskId = input?.task_id;
    const isBlocking = input?.block === true;

    const output = tool.state === 'completed' && typeof tool.result === 'string' ? tool.result : null;
    const label = description || taskId || null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {label ? (
                    <Text style={styles.label} numberOfLines={2}>{label}</Text>
                ) : null}
                {isBlocking && tool.state === 'running' ? (
                    <View style={styles.blockingBadge}>
                        <Text style={styles.blockingText}>{t('tools.taskOutput.waiting')}</Text>
                    </View>
                ) : null}
                {output ? (
                    <CodeView code={output} />
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 8,
    },
    label: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    blockingBadge: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    blockingText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
}));
