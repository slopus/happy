import { sync } from '@/sync/sync';
import type { Metadata } from '@/sync/storageTypes';
import type { SessionAgentContent, SessionToolResult } from '@slopus/happy-sync';
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView, type Option } from './markdown/MarkdownView';
import { ToolUseView } from './ToolUseView';

export interface AgentContentViewProps {
    content: SessionAgentContent[];
    toolResults: Record<string, SessionToolResult>;
    sessionId: string;
    messageId: string;
    metadata?: Metadata | null;
    expandedTools?: boolean;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({
    content,
    toolResults,
    sessionId,
    messageId,
    metadata,
    expandedTools = false,
}) => {
    const handleOptionPress = React.useCallback((option: Option) => {
        sync.sendMessage(sessionId, option.title);
    }, [sessionId]);

    return (
        <View style={styles.container}>
            {content.map((item, index) => {
                if ('Text' in item) {
                    return (
                        <View key={`text:${index}`} style={styles.block}>
                            <MarkdownView markdown={item.Text} onOptionPress={handleOptionPress} sessionId={sessionId} />
                        </View>
                    );
                }

                if ('Thinking' in item) {
                    return (
                        <View key={`thinking:${index}`} style={[styles.block, styles.thinkingBlock]}>
                            <Text style={styles.label}>Thinking</Text>
                            <MarkdownView markdown={item.Thinking.text} sessionId={sessionId} />
                        </View>
                    );
                }

                if ('RedactedThinking' in item) {
                    return (
                        <View key={`redacted:${index}`} style={[styles.block, styles.thinkingBlock]}>
                            <Text style={styles.label}>Thinking</Text>
                            <Text style={styles.redactedText}>{item.RedactedThinking || 'Redacted'}</Text>
                        </View>
                    );
                }

                return (
                    <ToolUseView
                        key={`tool:${item.ToolUse.id}`}
                        toolUse={item.ToolUse}
                        toolResult={toolResults[item.ToolUse.id]}
                        sessionId={sessionId}
                        messageId={messageId}
                        metadata={metadata}
                        expanded={expandedTools}
                    />
                );
            })}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 12,
    },
    block: {
        paddingHorizontal: 16,
    },
    thinkingBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        marginHorizontal: 16,
        paddingHorizontal: 14,
        paddingVertical: 12,
    },
    label: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
        marginBottom: 6,
        textTransform: 'uppercase',
    },
    redactedText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
    },
}));
