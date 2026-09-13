import * as React from 'react';
import { Text, View, ScrollView, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall, Message } from '@/sync/typesMessage';
import { CodeView } from '../CodeView';
import { Metadata } from '@/sync/storageTypes';
import { getToolDisplayTitle, getToolSummaryCategory, isTerminalToolName } from '@/utils/toolDisplay';
import { toolResultText } from '@/utils/toolResult';
import { getToolFullViewComponent } from './views/_all';
import { layout } from '../layout';
import { useLocalSetting } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { ToolError } from './ToolError';
import { ToolSectionView } from './ToolSectionView';

interface ToolFullViewProps {
    tool: ToolCall;
    metadata?: Metadata | null;
    messages?: Message[];
    /** Show only this file, for when the user tapped one diff out of many. */
    focusFile?: string;
}

export function ToolFullView({ tool, metadata, messages = [], focusFile }: ToolFullViewProps) {
    // Check if there's a specialized content view for this tool
    const SpecializedFullView = getToolFullViewComponent(tool.name);
    const screenWidth = useWindowDimensions().width;
    const devModeEnabled = (useLocalSetting('devModeEnabled') || __DEV__);
    const wideContent = getToolSummaryCategory(tool.name) === 'edit';

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
            <View style={[
                styles.contentWrapper,
                wideContent ? { paddingHorizontal: screenWidth > 700 ? 16 : 0 } : styles.readableContent,
            ]}>
                {/* Tool-specific content or generic fallback */}
                {SpecializedFullView ? (
                    <SpecializedFullView tool={tool} metadata={metadata || null} messages={messages} focusFile={focusFile} />
                ) : (
                    <>
                    {/* Generic fallback for tools without specialized views */}
                    {/* Tool Description */}
                    {(tool.description || tool.title) && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="information-circle" size={20} color="#5856D6" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.description')}</Text>
                            </View>
                            <Text style={styles.description}>{tool.description || getToolDisplayTitle(tool)}</Text>
                        </View>
                    )}
                    {/* Input Parameters */}
                    {tool.input && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-in" size={20} color="#5856D6" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.inputParams')}</Text>
                            </View>
                            <CodeView code={JSON.stringify(tool.input, null, 2)} />
                        </View>
                    )}

                    {/* Result/Output */}
                    {tool.state === 'completed' && tool.result && (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-out" size={20} color="#34C759" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.output')}</Text>
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
                                <Text style={styles.sectionTitle}>{t('tools.fullView.error')}</Text>
                            </View>
                            <View style={styles.errorContainer}>
                                <Text style={styles.errorText}>{toolResultText(tool.result)}</Text>
                            </View>
                        </View>
                    )}

                    {/* No Output Message */}
                    {tool.state === 'completed' && !tool.result && (
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

                {/* Specialized non-terminal views show the inputs (diffs, task
                    children), not the execution outcome. Keep that outcome here. */}
                {SpecializedFullView && !isTerminalToolName(tool.name) && (
                    tool.state === 'error' ? (
                        <ToolError message={toolResultText(tool.result) || t('tools.fullView.error')} />
                    ) : tool.state === 'completed' && tool.result != null ? (
                        <ToolSectionView title={t('tools.fullView.output')}>
                            <CodeView code={toolResultText(tool.result) ?? ''} />
                        </ToolSectionView>
                    ) : null
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
                                title: tool.title,
                                state: tool.state,
                                description: tool.description,
                                input: tool.input,
                                result: tool.result,
                                createdAt: tool.createdAt,
                                startedAt: tool.startedAt,
                                completedAt: tool.completedAt,
                                permission: tool.permission,
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
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
    },
    scrollContent: {
        paddingTop: 12,
        paddingBottom: 32,
    },
    contentWrapper: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    readableContent: {
        maxWidth: 800,
        paddingHorizontal: 16,
    },
    section: {
        marginBottom: 28,
        paddingHorizontal: 0,
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
