import * as React from 'react';
import { ToolViewProps } from './_all';
import { Text, View, StyleSheet, ActivityIndicator } from 'react-native';
import { knownTools } from '../../tools/knownTools';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';

interface FilteredTool {
    tool: ToolCall;
    title: string;
    state: 'running' | 'completed' | 'error';
}

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata, messages }) => {
    const filtered: FilteredTool[] = [];

    for (let m of messages) {
        if (m.kind === 'tool-call') {
            const knownTool = knownTools[m.tool.name as keyof typeof knownTools];
            
            // Extract title using extractDescription if available, otherwise use title
            let title = m.tool.name;
            if (knownTool) {
                if ('extractDescription' in knownTool && typeof knownTool.extractDescription === 'function') {
                    title = knownTool.extractDescription({ tool: m.tool, metadata });
                } else {
                    title = knownTool.title;
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

    if (filtered.length === 0) {
        if (tool.state === 'error') {
            return null;
        }
        return (
            <View style={styles.container}>
                <View style={styles.loadingItem}>
                    <ActivityIndicator size="small" color="#666" />
                    <Text style={styles.loadingText}>Initializing agent...</Text>
                </View>
            </View>
        );
    }

    const visibleTools = filtered.slice(0, 3);
    const remainingCount = filtered.length - 3;

    return (
        <View style={styles.container}>
            {visibleTools.map((item, index) => (
                <View key={`${item.tool.name}-${index}`} style={styles.toolItem}>
                    <Text style={styles.toolTitle}>{item.title}</Text>
                    <View style={styles.statusContainer}>
                        {item.state === 'running' && (
                            <ActivityIndicator size="small" color="#5856D6" />
                        )}
                        {item.state === 'completed' && (
                            <Ionicons name="checkmark-circle" size={16} color="#34C759" />
                        )}
                        {item.state === 'error' && (
                            <Ionicons name="close-circle" size={16} color="#FF3B30" />
                        )}
                    </View>
                </View>
            ))}
            {remainingCount > 0 && (
                <View style={styles.moreToolsItem}>
                    <Text style={styles.moreToolsText}>
                        +{remainingCount} more tool{remainingCount > 1 ? 's' : ''}
                    </Text>
                </View>
            )}
        </View>
    );
});

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
        color: '#666',
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
        color: '#666',
    },
    moreToolsItem: {
        paddingVertical: 4,
        paddingHorizontal: 4,
    },
    moreToolsText: {
        fontSize: 14,
        color: '#999',
        fontStyle: 'italic',
    },
});