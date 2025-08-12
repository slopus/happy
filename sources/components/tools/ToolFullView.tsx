import * as React from 'react';
import { Text, View, StyleSheet, ScrollView, ActivityIndicator, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall, Message } from '@/sync/typesMessage';
import { CodeView } from '../CodeView';
import { Metadata } from '@/sync/storageTypes';
import { getToolFullViewComponent } from './views/_all';
import { layout } from '../layout';
import { useLocalSetting } from '@/sync/storage';

interface ToolFullViewProps {
    tool: ToolCall;
    metadata?: Metadata | null;
    messages?: Message[];
}

export function ToolFullView({ tool, metadata, messages = [] }: ToolFullViewProps) {
    // Check if there's a specialized content view for this tool
    const SpecializedFullView = getToolFullViewComponent(tool.name);
    const screenWidth = useWindowDimensions().width;
    const devModeEnabled = useLocalSetting('devModeEnabled');

    return (
        <ScrollView style={[styles.container, { paddingHorizontal: screenWidth > 700 ? 16 : 0 }]}>
            <View style={styles.contentWrapper}>
                {/* Tool-specific content or generic fallback */}
                {SpecializedFullView ? (
                    <SpecializedFullView tool={tool} metadata={metadata || null} messages={messages} />
                ) : (
                    <>
                    {/* Generic fallback for tools without specialized views */}
                    {/* Tool Description */}
                    {tool.description && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="information-circle" size={20} color="#5856D6" />
                                <Text style={styles.sectionTitle}>Description</Text>
                            </View>
                            <Text style={styles.description}>{tool.description}</Text>
                        </View>
                    )}
                    {/* Input Parameters */}
                    {tool.input && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-in" size={20} color="#5856D6" />
                                <Text style={styles.sectionTitle}>Input Parameters</Text>
                            </View>
                            <CodeView code={JSON.stringify(tool.input, null, 2)} />
                        </View>
                    )}

                    {/* Result/Output */}
                    {tool.state === 'completed' && tool.result && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-out" size={20} color="#34C759" />
                                <Text style={styles.sectionTitle}>Output</Text>
                            </View>
                            <CodeView
                                code={typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}
                            />
                        </View>
                    )}

                    {/* Error Details */}
                    {tool.state === 'error' && tool.result && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="close-circle" size={20} color="#FF3B30" />
                                <Text style={styles.sectionTitle}>Error</Text>
                            </View>
                            <View style={styles.errorContainer}>
                                <Text style={styles.errorText}>{String(tool.result)}</Text>
                            </View>
                        </View>
                    )}

                    {/* No Output Message */}
                    {tool.state === 'completed' && !tool.result && (
                        <View style={styles.section}>
                            <View style={styles.emptyOutputContainer}>
                                <Ionicons name="checkmark-circle-outline" size={48} color="#34C759" />
                                <Text style={styles.emptyOutputText}>Tool completed successfully</Text>
                                <Text style={styles.emptyOutputSubtext}>No output was produced</Text>
                            </View>
                        </View>
                    )}

                    {/* Running State */}
                    {tool.state === 'running' && (
                        <View style={styles.section}>
                            <View style={styles.runningContainer}>
                                <ActivityIndicator size="large" color="#007AFF" />
                                <Text style={styles.runningText}>Tool is running...</Text>
                            </View>
                        </View>
                    )}
                </>
                )}
                
                {/* Raw JSON View (Dev Mode Only) */}
                {devModeEnabled && (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Ionicons name="code-slash" size={20} color="#FF9500" />
                            <Text style={styles.sectionTitle}>Raw JSON (Dev Mode)</Text>
                        </View>
                        <CodeView 
                            code={JSON.stringify({
                                name: tool.name,
                                state: tool.state,
                                description: tool.description,
                                input: tool.input,
                                result: tool.result,
                                createdAt: tool.createdAt,
                                startedAt: tool.startedAt,
                                completedAt: tool.completedAt,
                                permission: tool.permission
                            }, null, 2)} 
                        />
                    </View>
                )}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
        paddingTop: 12,
    },
    contentWrapper: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    section: {
        marginBottom: 28,
        paddingHorizontal: 4,
    },
    sectionFullWidth: {
        marginBottom: 28,
        paddingHorizontal: 0,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
        gap: 8,
    },
    sectionTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: '#000',
    },
    description: {
        fontSize: 14,
        lineHeight: 20,
        color: '#333',
    },
    toolId: {
        fontSize: 12,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        color: '#666',
    },
    errorContainer: {
        backgroundColor: '#FFE5E5',
        borderRadius: 8,
        padding: 16,
        borderWidth: 1,
        borderColor: '#FFD0D0',
    },
    errorText: {
        fontSize: 14,
        color: '#FF3B30',
        lineHeight: 20,
    },
    emptyOutputContainer: {
        alignItems: 'center',
        paddingVertical: 48,
        gap: 12,
    },
    emptyOutputText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#34C759',
    },
    emptyOutputSubtext: {
        fontSize: 14,
        color: '#666',
    },
    runningContainer: {
        alignItems: 'center',
        paddingVertical: 48,
        gap: 16,
    },
    runningText: {
        fontSize: 16,
        color: '#007AFF',
    },
});

// Export styles for use in specialized views
export const toolFullViewStyles = styles;