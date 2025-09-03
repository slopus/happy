import * as React from 'react';
import { ToolViewProps } from './_all';
import { Text, View, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { knownTools } from '../../tools/knownTools';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface FilteredTool {
    tool: ToolCall;
    title: string;
    state: 'running' | 'completed' | 'error';
}

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata, messages }) => {
    const { theme } = useUnistyles();
    const filtered: FilteredTool[] = [];

    for (let m of messages) {
        if (m.kind === 'tool-call') {
            const knownTool = knownTools[m.tool.name as keyof typeof knownTools] as any;
            
            // Extract title using extractDescription if available, otherwise use title
            let title = m.tool.name;
            if (knownTool) {
                if ('extractDescription' in knownTool && typeof knownTool.extractDescription === 'function') {
                    title = knownTool.extractDescription({ tool: m.tool, metadata });
                } else if (knownTool.title) {
                    // Handle optional title and function type
                    if (typeof knownTool.title === 'function') {
                        title = knownTool.title({ tool: m.tool, metadata });
                    } else {
                        title = knownTool.title;
                    }
                }
            }

            if (m.tool.state === 'running' || m.tool.state === 'completed' || m.tool.state === 'error') {
                filtered.push({
                    tool: m.tool,
                    title,
                    state: m.tool.state
                });
            }
        }
    }

    const styles = StyleSheet.create({
        container: {
            paddingVertical: 4,
            paddingBottom: 12
        },
        toolItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 4,
            paddingLeft: 4,
            paddingRight: 2
        },
        toolTitle: {
            fontSize: 14,
            fontWeight: '500',
            color: theme.colors.textSecondary,
            fontFamily: 'monospace',
            flex: 1,
        },
        statusContainer: {
            marginLeft: 'auto',
            paddingLeft: 8,
        },
        loadingItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 8,
            paddingHorizontal: 4,
        },
        loadingText: {
            marginLeft: 8,
            fontSize: 14,
            color: theme.colors.textSecondary,
        },
        moreToolsItem: {
            paddingVertical: 4,
            paddingHorizontal: 4,
        },
        moreToolsText: {
            fontSize: 14,
            color: theme.colors.textSecondary,
            fontStyle: 'italic',
            opacity: 0.7,
        },
    });

    if (filtered.length === 0) {
        if (tool.state === 'error') {
            return null;
        }
        return (
            <View style={styles.container}>
                <View style={styles.loadingItem}>
                    <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={theme.colors.textSecondary} />
                    <Text style={styles.loadingText}>{t('tools.taskView.initializing')}</Text>
                </View>
            </View>
        );
    }

    const visibleTools = filtered.slice(filtered.length - 3);
    const remainingCount = filtered.length - 3;

    return (
        <View style={styles.container}>
            {visibleTools.map((item, index) => (
                <View key={`${item.tool.name}-${index}`} style={styles.toolItem}>
                    <Text style={styles.toolTitle}>{item.title}</Text>
                    <View style={styles.statusContainer}>
                        {item.state === 'running' && (
                            <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={theme.colors.warning} />
                        )}
                        {item.state === 'completed' && (
                            <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
                        )}
                        {item.state === 'error' && (
                            <Ionicons name="close-circle" size={16} color={theme.colors.textDestructive} />
                        )}
                    </View>
                </View>
            ))}
            {remainingCount > 0 && (
                <View style={styles.moreToolsItem}>
                    <Text style={styles.moreToolsText}>
                        {t('tools.taskView.moreTools', { count: remainingCount })}
                    </Text>
                </View>
            )}
        </View>
    );
});
