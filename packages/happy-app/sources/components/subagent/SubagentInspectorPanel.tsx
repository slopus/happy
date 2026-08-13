import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AttachmentGalleryView } from '@/components/AttachmentGalleryView';
import { MessageView } from '@/components/MessageView';
import { useRightSwipePanel } from '@/components/RightSwipePanelHost';
import { AgentWorkGroupView, ToolGroupView } from '@/components/ToolGroupView';
import { layout } from '@/components/layout';
import { groupMessagesForDisplay } from '@/hooks/useGroupedMessages';
import { useSession, useSessionMessages, useSetting } from '@/sync/storage';
import { t } from '@/text';
import {
    collectConversationActivities,
    ConversationActivityStatus,
    findSubagentTranscript,
} from '@/utils/conversationActivity';
import type { SubagentInspectorSelection } from './SubagentInspectorContext';

export const SubagentInspectorPanel = React.memo(function SubagentInspectorPanel({
    onBack,
    selection,
    sessionId,
}: {
    onBack: () => void;
    selection: SubagentInspectorSelection;
    sessionId: string;
}) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const { messages } = useSessionMessages(sessionId);
    const groupToolCalls = useSetting('groupToolCalls');
    const rightSwipePanel = useRightSwipePanel();
    React.useEffect(() => rightSwipePanel?.registerBackHandler(() => {
        onBack();
        return true;
    }), [onBack, rightSwipePanel]);
    const transcript = React.useMemo(
        () => findSubagentTranscript(messages, selection.id),
        [messages, selection.id],
    );
    const liveActivity = React.useMemo(
        () => collectConversationActivities(messages).subagents.find((activity) => activity.id === selection.id),
        [messages, selection.id],
    );
    const title = liveActivity?.title ?? selection.title ?? selection.id;
    const status = liveActivity?.status ?? selection.status;
    const transcriptMessages = transcript?.messages ?? [];
    const displayItems = React.useMemo(
        () => [...groupMessagesForDisplay(
            [...transcriptMessages].reverse(),
            groupToolCalls,
            { currentTurnActive: session?.active === true && status === 'running', groupStandaloneSkills: true },
        )].reverse(),
        [groupToolCalls, session?.active, status, transcriptMessages],
    );
    const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(() => new Set());
    React.useEffect(() => setExpandedGroups(new Set()), [selection.id]);
    const toggleGroup = React.useCallback((groupId: string) => {
        setExpandedGroups((current) => {
            const next = new Set(current);
            if (next.has(groupId)) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    }, []);
    const taskPrompt = typeof transcript?.agent.tool.input?.prompt === 'string'
        ? transcript.agent.tool.input.prompt.trim()
        : '';
    const hasTranscriptContent = taskPrompt.length > 0 || transcriptMessages.length > 0;

    return (
        <View style={styles.container} testID="subagent-inspector-panel">
            <View style={styles.header}>
                <Pressable
                    accessibilityLabel={t('common.back')}
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={onBack}
                    style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
                    testID="subagent-inspector-back"
                >
                    <Ionicons name="arrow-back" size={20} color={theme.colors.text} />
                </Pressable>
                <View style={styles.heading}>
                    <Text style={styles.eyebrow}>{t('toolGroup.subagentLabel')}</Text>
                    <Text numberOfLines={2} style={styles.title} testID="subagent-inspector-title">
                        {title}
                    </Text>
                </View>
                <View style={styles.statusPill}>
                    <SubagentStatusIcon status={status} />
                    <Text style={styles.statusText} testID="subagent-inspector-status">
                        {getStatusLabel(status)}
                    </Text>
                </View>
            </View>

            {hasTranscriptContent ? (
                <ScrollView
                    contentContainerStyle={styles.transcript}
                    showsVerticalScrollIndicator={false}
                    testID="subagent-inspector-transcript"
                >
                    {taskPrompt.length > 0 && (
                        <View style={styles.taskBlock} testID="subagent-inspector-task-block">
                            <Text style={styles.taskLabel}>{t('tools.names.task')}</Text>
                            <Text selectable style={styles.taskText} testID="subagent-inspector-task">
                                {taskPrompt}
                            </Text>
                        </View>
                    )}
                    {displayItems.map((item) => {
                        if (item.type === 'tool-group') {
                            return (
                                <ToolGroupView
                                    expanded={expandedGroups.has(item.id)}
                                    group={item}
                                    key={item.id}
                                    metadata={session?.metadata ?? null}
                                    onToggle={() => toggleGroup(item.id)}
                                    sessionId={sessionId}
                                />
                            );
                        }
                        if (item.type === 'agent-work-group') {
                            return (
                                <AgentWorkGroupView
                                    expanded={expandedGroups.has(item.id)}
                                    group={item}
                                    key={item.id}
                                    metadata={session?.metadata ?? null}
                                    onToggle={() => toggleGroup(item.id)}
                                    sessionId={sessionId}
                                />
                            );
                        }
                        if (item.type === 'image-group') {
                            return (
                                <AttachmentGalleryView
                                    key={item.id}
                                    messages={item.messages}
                                    pendingCount={item.pendingCount}
                                    pendingStartedAt={item.pendingStartedAt}
                                    presentation={item.presentation}
                                    sessionId={sessionId}
                                />
                            );
                        }
                        return (
                            <MessageView
                                key={item.id}
                                message={item.message}
                                metadata={session?.metadata ?? null}
                                sessionId={sessionId}
                            />
                        );
                    })}
                </ScrollView>
            ) : (
                <View style={styles.empty}>
                    <Ionicons name="document-text-outline" size={24} color={theme.colors.textSecondary} />
                    <Text style={styles.emptyText} testID="subagent-inspector-empty">
                        {t('toolGroup.subagentNoDetails')}
                    </Text>
                </View>
            )}
        </View>
    );
});

function SubagentStatusIcon({ status }: { status: ConversationActivityStatus }) {
    const { theme } = useUnistyles();
    if (status === 'running') {
        return <ActivityIndicator size="small" color={theme.colors.warning} style={styles.spinner} />;
    }
    if (status === 'failed') {
        return <Ionicons name="close-circle" size={14} color={theme.colors.textDestructive} />;
    }
    if (status === 'cancelled') {
        return <Ionicons name="remove-circle-outline" size={14} color={theme.colors.textSecondary} />;
    }
    return <Ionicons name="checkmark-circle" size={14} color={theme.colors.success} />;
}

function getStatusLabel(status: ConversationActivityStatus): string {
    return t(`toolGroup.subagentStatus.${status}`);
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface,
    },
    header: {
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    backButton: {
        width: 40,
        height: 40,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
    pressed: {
        opacity: 0.62,
    },
    heading: {
        flex: 1,
        minWidth: 0,
    },
    eyebrow: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
    },
    title: {
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 20,
        fontFamily: 'monospace',
        fontWeight: '600',
    },
    statusPill: {
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    statusText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    spinner: {
        transform: [{ scaleX: 0.65 }, { scaleY: 0.65 }],
    },
    transcript: {
        paddingTop: 12,
        paddingBottom: 24,
    },
    taskBlock: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: layout.maxWidth,
        gap: 5,
        marginBottom: 12,
        paddingHorizontal: 16,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    taskLabel: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
    },
    taskText: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },
    empty: {
        flex: 1,
        minHeight: 160,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 20,
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        textAlign: 'center',
    },
}));
