import * as React from 'react';
import { Text, View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getToolViewComponent } from './tools/_all';
import { ToolCall } from '@/sync/typesMessage';
import { CodeView } from './CodeView';
import { ToolSectionView } from './ToolSectionView';
import { ShimmerView } from '../ShimmerView';

interface ToolViewProps {
    tool: ToolCall;
    children?: React.ReactNode;
    onPress?: () => void;
}

export const ToolView = React.memo<ToolViewProps>((props) => {
    const { tool, children, onPress } = props;

    const getStatusIcon = () => {
        switch (tool.state) {
            case 'running':
                // return <ActivityIndicator size="small" color="#007AFF" />;
                return null;
            case 'completed':
                return <Ionicons name="checkmark-circle" size={20} color="#34C759" />;
            case 'error':
                return <Ionicons name="close-circle" size={20} color="#FF3B30" />;
        }
    };

    const getToolIcon = () => {
        // Map tool names to appropriate icons
        const iconMap: Record<string, string> = {
            'Read': 'document-text',
            'Write': 'create',
            'Edit': 'pencil',
            'Search': 'search',
            'Bash': 'terminal',
            'MultiEdit': 'duplicate',
            'Grep': 'filter',
            'Glob': 'folder-open',
            'LS': 'list',
            'Task': 'rocket',
        };

        const iconName = iconMap[tool.name] || 'construct';
        return <Ionicons name={iconName as any} size={20} color="#5856D6" />;
    };

    const Container = onPress ? TouchableOpacity : View;
    const containerProps = onPress ? { onPress, activeOpacity: 0.8 } : {};
    console.log('tool', tool.input);

    return (
        <Container style={styles.container} {...containerProps}>
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    {getToolIcon()}
                    <View style={styles.titleContainer}>
                        {tool.state === 'running'
                            ? <ShimmerView><Text style={styles.toolName}>{tool.name}</Text></ShimmerView>
                            : <Text style={styles.toolName}>{tool.name}</Text>
                        }
                        {tool.input?.description && (
                            <Text style={styles.toolDescription} numberOfLines={1}>
                                {tool.input.description}
                            </Text>
                        )}
                    </View>
                    {getStatusIcon()}
                </View>
            </View>

            {/* Content area - either custom children or tool-specific view */}
            {(() => {
                // Show error state if present
                if (tool.state === 'error' && tool.result) {
                    return (
                        <View style={styles.content}>
                            <View style={styles.errorContainer}>
                                <Text style={styles.errorText}>{String(tool.result)}</Text>
                            </View>
                        </View>
                    );
                }

                // Try to use a specific tool view component first
                const SpecificToolView = getToolViewComponent(tool.name);
                if (SpecificToolView && !children) {
                    return (
                        <View style={styles.content}>
                            <SpecificToolView tool={tool} />
                        </View>
                    );
                }

                // Use provided children if available
                if (children) {
                    return <View style={styles.content}>{children}</View>;
                }

                // Fall back to default view
                return (
                    <View style={styles.content}>
                        {/* Default content when no custom view available */}
                        {tool.input && (
                            <ToolSectionView title="Input">
                                <CodeView code={JSON.stringify(tool.input, null, 2)} />
                            </ToolSectionView>
                        )}

                        {tool.state === 'completed' && tool.result && (
                            <ToolSectionView title="Output">
                                <CodeView
                                    code={typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}
                                />
                            </ToolSectionView>
                        )}
                    </View>
                );
            })()}
        </Container>
    );
});

const styles = StyleSheet.create({
    container: {
        backgroundColor: '#F8F8F8',
        borderRadius: 8,
        marginVertical: 4,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
        backgroundColor: '#f0f0f0',
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    titleContainer: {
        flex: 1,
    },
    toolName: {
        fontSize: 15,
        fontWeight: '600',
        color: '#000',
    },
    toolDescription: {
        fontSize: 13,
        color: '#666',
        marginTop: 2,
    },
    content: {
        padding: 12,
        paddingTop: 8,
    },
    errorContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: '#FFF0F0',
        borderRadius: 6,
        padding: 12,
        borderWidth: 1,
        borderColor: '#FF3B30',
    },
    errorText: {
        fontSize: 13,
        color: '#FF3B30',
        flex: 1,
    },
});