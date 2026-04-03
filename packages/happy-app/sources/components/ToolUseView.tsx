import { CodeView } from '@/components/CodeView';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ToolError } from '@/components/tools/ToolError';
import { ToolSectionView } from '@/components/tools/ToolSectionView';
import { PermissionFooter } from '@/components/tools/PermissionFooter';
import { useSyncSessionState } from '@/sync/storage';
import type { Metadata } from '@/sync/storageTypes';
import type { PermissionRequest, QuestionRequest, SessionToolResult, SessionToolUse } from '@slopus/happy-sync';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { findPermissionForTool, findQuestionForTool, formatToolValue, getToolResultText, getToolUseState } from './transcriptUtils';
import { ToolUseQuestionView } from './ToolUseQuestionView';

export interface ToolUseViewProps {
    toolUse: SessionToolUse;
    toolResult?: SessionToolResult;
    sessionId?: string;
    messageId?: string;
    metadata?: Metadata | null;
    expanded?: boolean;
}

function getPermissionStatus(permission: PermissionRequest): {
    id: string;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
} {
    if (!permission.resolved) {
        return { id: permission.permissionId, status: 'pending' };
    }

    if (permission.decision === 'reject') {
        return {
            id: permission.permissionId,
            status: 'denied',
            decision: 'denied',
            reason: permission.reason,
        };
    }

    return {
        id: permission.permissionId,
        status: 'approved',
        decision: permission.decision === 'always' ? 'approved_for_session' : 'approved',
        allowedTools: permission.allowTools,
    };
}

function getStatusLabel(
    state: string,
    permission?: PermissionRequest,
    question?: QuestionRequest,
): string {
    if (permission && !permission.resolved) {
        return 'Awaiting approval';
    }
    if (question && !question.resolved) {
        return 'Awaiting answer';
    }
    if (permission?.resolved) {
        return permission.decision === 'reject' ? 'Denied' : 'Approved';
    }
    switch (state) {
        case 'running':
            return 'Running';
        case 'error':
            return 'Failed';
        case 'completed':
            return 'Completed';
        default:
            return 'Pending';
    }
}

function getStatusIcon(state: string, permission?: PermissionRequest, question?: QuestionRequest): string {
    if ((permission && !permission.resolved) || (question && !question.resolved)) {
        return 'shield-outline';
    }
    if (state === 'error' || permission?.decision === 'reject') {
        return 'alert-circle-outline';
    }
    return 'construct-outline';
}

export const ToolUseView = React.memo<ToolUseViewProps>(({
    toolUse,
    toolResult,
    sessionId,
    messageId,
    metadata: _metadata,
    expanded = false,
}) => {
    const router = useRouter();

    const syncSession = sessionId ? useSyncSessionState(sessionId) : null;
    const permission = syncSession ? findPermissionForTool(toolUse.id, syncSession.permissions) : undefined;
    const question = syncSession ? findQuestionForTool(toolUse.id, syncSession.questions) : undefined;

    const state = getToolUseState(toolUse, toolResult, permission, question);
    const input = toolUse.is_input_complete ? formatToolValue(toolUse.input, toolUse.raw_input) : null;
    const output = formatToolValue(toolResult?.output);
    const outputText = getToolResultText(toolResult);
    const imageResult = toolResult && 'Image' in toolResult.content ? toolResult.content.Image : null;

    const statusLabel = getStatusLabel(state, permission, question);
    const iconName = getStatusIcon(state, permission, question);

    const handlePress = React.useCallback(() => {
        if (!sessionId || !messageId || expanded) {
            return;
        }

        router.push({
            pathname: '/session/[id]/message/[messageId]',
            params: { id: sessionId, messageId, ...(toolUse.id ? { partId: toolUse.id } : {}) },
        });
    }, [expanded, messageId, router, sessionId, toolUse.id]);

    const isPressable = Boolean(sessionId && messageId && !expanded);
    const Container = isPressable ? Pressable : View;

    return (
        <View style={styles.outer}>
            <Container onPress={isPressable ? handlePress : undefined} style={styles.container}>
                <View style={styles.header}>
                    <View style={styles.headerLeft}>
                        <Ionicons
                            name={iconName as any}
                            size={18}
                            style={styles.icon}
                        />
                        <View style={styles.headerText}>
                            <Text style={styles.title}>{toolUse.name}</Text>
                            <Text style={styles.subtitle}>{statusLabel}</Text>
                        </View>
                    </View>
                    {isPressable ? (
                        <Ionicons name="chevron-forward" size={16} style={styles.chevron} />
                    ) : null}
                </View>

                {input ? (
                    <ToolSectionView title="Input">
                        <CodeView code={input} />
                    </ToolSectionView>
                ) : null}

                {state === 'error' && outputText ? (
                    <ToolError message={outputText} />
                ) : null}

                {output && (!outputText || output !== outputText) ? (
                    <ToolSectionView title="Output">
                        <CodeView code={output} />
                    </ToolSectionView>
                ) : null}

                {state !== 'error' && outputText ? (
                    <ToolSectionView title="Output">
                        <MarkdownView markdown={outputText} sessionId={sessionId} />
                    </ToolSectionView>
                ) : null}

                {imageResult ? (
                    <ToolSectionView title="Output">
                        <Image
                            source={{ uri: imageResult.source }}
                            style={[
                                styles.image,
                                imageResult.size?.width && imageResult.size?.height
                                    ? { aspectRatio: imageResult.size.width / imageResult.size.height }
                                    : null,
                            ]}
                        />
                    </ToolSectionView>
                ) : null}

                {question && sessionId && toolUse.name === 'AskUserQuestion' ? (
                    <ToolUseQuestionView question={question} sessionId={sessionId} toolInput={toolUse.input} />
                ) : null}

                {permission && sessionId && toolUse.name !== 'AskUserQuestion' ? (
                    <PermissionFooter
                        permission={getPermissionStatus(permission)}
                        sessionId={sessionId}
                        toolName={toolUse.name}
                        toolInput={toolUse.input}
                    />
                ) : null}
            </Container>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    outer: {
        paddingHorizontal: 16,
    },
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.modal.border,
        padding: 12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        gap: 10,
    },
    headerText: {
        flex: 1,
    },
    icon: {
        color: theme.colors.textSecondary,
    },
    title: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '600',
    },
    subtitle: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        marginTop: 2,
    },
    chevron: {
        color: theme.colors.textSecondary,
    },
    image: {
        width: '100%',
        height: 220,
        borderRadius: 8,
    },
}));
