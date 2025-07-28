import * as React from 'react';
import { Text, View, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getToolViewComponent } from './tools/_all';
import { Message, ToolCall } from '@/sync/typesMessage';
import { CodeView } from './CodeView';
import { ToolSectionView } from './ToolSectionView';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { ToolError } from './ToolError';
import { knownTools } from '@/components/blocks/knownTools';
import { Metadata } from '@/sync/storageTypes';

interface ToolViewProps {
    metadata: Metadata | null;
    tool: ToolCall;
    messages?: Message[];
    onPress?: () => void;
}

export const ToolView = React.memo<ToolViewProps>((props) => {
    const { tool, onPress } = props;
    const Container = onPress ? TouchableOpacity : View;
    const containerProps = onPress ? { onPress, activeOpacity: 0.8 } : {};
    const toolTitle = tool.name in knownTools ? knownTools[tool.name as keyof typeof knownTools].title : tool.name;
    let description = tool.description;
    let status: string | null = null;
    let minimal = false;
    let icon = 'construct';
    let noStatus = false;

    let knownTool = knownTools[tool.name as keyof typeof knownTools] as any;
    if (knownTool && typeof knownTool.extractSubtitle === 'function') {
        const subtitle = knownTool.extractSubtitle({ tool, metadata: props.metadata });
        if (typeof subtitle === 'string' && subtitle) {
            description = subtitle;
        }
    }
    if (knownTool && typeof knownTool.extractStatus === 'function') {
        const state = knownTool.extractStatus({ tool, metadata: props.metadata });
        if (typeof state === 'string' && state) {
            status = state;
        }
    }
    if (knownTool && typeof knownTool.minimal === 'boolean') {
        minimal = knownTool.minimal;
    }
    if (knownTool && typeof knownTool.icon === 'string') {
        icon = knownTool.icon;
    }
    if (knownTool && typeof knownTool.noStatus === 'boolean') {
        noStatus = knownTool.noStatus;
    }

    let statusIcon = null;
    switch (tool.state) {
        case 'running':
            if (!noStatus) {
                statusIcon = <ActivityIndicator size="small" color="black" style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }} />;
            }
            break;
        case 'completed':
            if (!noStatus) {
                statusIcon = <Ionicons name="checkmark-circle" size={20} color="#34C759" />;
            }
            break;
        case 'error':
            statusIcon = <Ionicons name="close-circle" size={20} color="#FF3B30" />;
            break;
    }

    return (
        <Container style={styles.container} {...containerProps}>
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <Ionicons name={icon as any} size={20} color="#5856D6" />
                    <View style={styles.titleContainer}>
                        <Text style={styles.toolName} numberOfLines={1}>{toolTitle}{status ? <Text style={styles.status}>{` ${status}`}</Text> : null}</Text>
                        {description && (
                            <Text style={styles.toolDescription} numberOfLines={1}>
                                {description}
                            </Text>
                        )}
                    </View>
                    {tool.state === 'running' && (
                        <View style={styles.elapsedContainer}>
                            <ElapsedView from={tool.createdAt} />
                        </View>
                    )}
                    {statusIcon}
                </View>
            </View>

            {/* Content area - either custom children or tool-specific view */}
            {(() => {

                // Try to use a specific tool view component first
                const SpecificToolView = getToolViewComponent(tool.name);
                if (SpecificToolView) {
                    return (
                        <View style={styles.content}>
                            <SpecificToolView tool={tool} metadata={props.metadata} messages={props.messages ?? []} />
                            {tool.state === 'error' && tool.result && (
                                <ToolError message={String(tool.result)} />
                            )}
                        </View>
                    );
                }

                // Show error state if present
                if (tool.state === 'error' && tool.result) {
                    return (
                        <View style={styles.content}>
                            <ToolError message={String(tool.result)} />
                        </View>
                    );
                }

                if (minimal) {
                    return null;
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

function ElapsedView(props: { from: number }) {
    const { from } = props;
    const elapsed = useElapsedTime(from);
    return <Text style={styles.elapsedText}>{elapsed.toFixed(1)}s</Text>;
}

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
    elapsedContainer: {
        marginLeft: 8,
    },
    elapsedText: {
        fontSize: 13,
        color: '#666',
        fontFamily: 'monospace',
    },
    toolName: {
        fontSize: 15,
        fontWeight: '600',
        color: '#000',
    },
    status: {
        fontWeight: '400',
        opacity: 0.3,
        fontSize: 15,
    },
    toolDescription: {
        fontSize: 13,
        color: '#666',
        marginTop: 2,
    },
    content: {
        paddingHorizontal: 12,
        paddingTop: 8,
    },
});