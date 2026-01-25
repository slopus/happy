import * as React from 'react';
import { Text, View, ScrollView, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall, Message } from '@/sync/typesMessage';
import { CodeView } from '../CodeView';
import { Metadata } from '@/sync/storageTypes';
import { getToolFullViewComponent, getToolViewComponent } from './views/_all';
import { layout } from '../layout';
import { useLocalSetting } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { StructuredResultView } from './views/StructuredResultView';
import { normalizeToolCallForRendering } from './utils/normalizeToolCallForRendering';
import { inferToolNameForRendering } from './utils/toolNameInference';
import { knownTools } from '@/components/tools/knownTools';
import { PermissionFooter } from './PermissionFooter';

const KNOWN_TOOL_KEYS = Object.keys(knownTools);

interface ToolFullViewProps {
    tool: ToolCall;
    sessionId?: string;
    metadata?: Metadata | null;
    messages?: Message[];
}

export function ToolFullView({ tool, sessionId, metadata, messages = [] }: ToolFullViewProps) {
    const toolForRendering = React.useMemo<ToolCall>(() => normalizeToolCallForRendering(tool), [tool]);

    const normalizedToolName = React.useMemo(() => {
        if (toolForRendering.name.startsWith('mcp__')) return toolForRendering.name;
        const inferred = inferToolNameForRendering({
            toolName: toolForRendering.name,
            toolInput: toolForRendering.input,
            toolDescription: toolForRendering.description,
            knownToolKeys: KNOWN_TOOL_KEYS,
        });
        return inferred.normalizedToolName;
    }, [toolForRendering.name, toolForRendering.input, toolForRendering.description]);

    // Check if there's a specialized content view for this tool.
    // Prefer a dedicated full view, but fall back to the regular tool view when available.
    const SpecializedFullView =
        getToolFullViewComponent(normalizedToolName) ??
        getToolViewComponent(normalizedToolName);
    const screenWidth = useWindowDimensions().width;
    const devModeEnabled = (useLocalSetting('devModeEnabled') || __DEV__);
    const isWaitingForPermission =
        toolForRendering.permission?.status === 'pending' && toolForRendering.state !== 'completed';

    return (
        <ScrollView style={[styles.container, { paddingHorizontal: screenWidth > 700 ? 16 : 0 }]}>
            <View style={styles.contentWrapper}>
                {/* Tool-specific content or generic fallback */}
                {SpecializedFullView ? (
                    <SpecializedFullView tool={toolForRendering} metadata={metadata || null} messages={messages} sessionId={sessionId} />
                ) : (
                    <>
                    {/* Generic fallback for tools without specialized views */}
                    {/* Tool Description */}
                    {toolForRendering.description && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="information-circle" size={20} color="#5856D6" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.description')}</Text>
                            </View>
                            <Text style={styles.description}>{toolForRendering.description}</Text>
                        </View>
                    )}
                    {/* Input Parameters */}
                    {toolForRendering.input && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-in" size={20} color="#5856D6" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.inputParams')}</Text>
                            </View>
                            <CodeView code={JSON.stringify(toolForRendering.input, null, 2)} />
                        </View>
                    )}

                    {/* Result/Output */}
                    {toolForRendering.state === 'completed' && toolForRendering.result && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-out" size={20} color="#34C759" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.output')}</Text>
                            </View>
                            <CodeView
                                code={typeof toolForRendering.result === 'string' ? toolForRendering.result : JSON.stringify(toolForRendering.result, null, 2)}
                            />
                        </View>
                    )}

                    {toolForRendering.state === 'running' && toolForRendering.result && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-out" size={20} color="#34C759" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.output')}</Text>
                            </View>
                            <StructuredResultView tool={toolForRendering} metadata={metadata || null} messages={messages} sessionId={sessionId} />
                        </View>
                    )}

                    {/* Error Details */}
                    {toolForRendering.state === 'error' && toolForRendering.result && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="close-circle" size={20} color="#FF3B30" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.error')}</Text>
                            </View>
                            <View style={styles.errorContainer}>
                                <Text style={styles.errorText}>{String(toolForRendering.result)}</Text>
                            </View>
                        </View>
                    )}

                    {/* No Output Message */}
                    {toolForRendering.state === 'completed' && !toolForRendering.result && (
                        <View style={styles.section}>
                            <View style={styles.emptyOutputContainer}>
                                <Ionicons name="checkmark-circle-outline" size={48} color="#34C759" />
                                <Text style={styles.emptyOutputText}>{t('tools.fullView.completed')}</Text>
                                <Text style={styles.emptyOutputSubtext}>{t('tools.fullView.noOutput')}</Text>
                            </View>
                        </View>
                    )}

                </>
                )}

                {/* Permission footer - allow approve/deny from the full view */}
                {isWaitingForPermission && toolForRendering.permission && sessionId && toolForRendering.name !== 'AskUserQuestion' && toolForRendering.name !== 'ExitPlanMode' && toolForRendering.name !== 'exit_plan_mode' && toolForRendering.name !== 'AcpHistoryImport' && (
                    <PermissionFooter
                        permission={toolForRendering.permission}
                        sessionId={sessionId}
                        toolName={normalizedToolName}
                        toolInput={toolForRendering.input}
                        metadata={metadata || null}
                    />
                )}
                
                {/* Raw JSON View (Dev Mode Only) */}
                {devModeEnabled && (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Ionicons name="code-slash" size={20} color="#FF9500" />
                            <Text style={styles.sectionTitle}>{t('tools.fullView.rawJsonDevMode')}</Text>
                        </View>
                        <CodeView 
                            code={JSON.stringify({
                                name: tool.name,
                                state: toolForRendering.state,
                                description: toolForRendering.description,
                                input: toolForRendering.input,
                                result: toolForRendering.result,
                                createdAt: toolForRendering.createdAt,
                                startedAt: toolForRendering.startedAt,
                                completedAt: toolForRendering.completedAt,
                                permission: toolForRendering.permission,
                                messages
                            }, null, 2)} 
                        />
                    </View>
                )}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
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
        color: theme.colors.text,
    },
    description: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    toolId: {
        fontSize: 12,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        color: theme.colors.textSecondary,
    },
    errorContainer: {
        backgroundColor: theme.colors.box.error.background,
        borderRadius: 8,
        padding: 16,
        borderWidth: 1,
        borderColor: theme.colors.box.error.border,
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.box.error.text,
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
        color: theme.colors.text,
    },
    emptyOutputSubtext: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
}));

// Export styles for use in specialized views
export const toolFullViewStyles = styles;
