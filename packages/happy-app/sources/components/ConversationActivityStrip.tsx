import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Message } from '@/sync/typesMessage';
import { t } from '@/text';
import {
    collectConversationActivities,
    ConversationActivityStatus,
    SkillConversationActivity,
} from '@/utils/conversationActivity';
import { useSubagentInspector } from './subagent/SubagentInspectorContext';

export const ConversationActivitySuppressedContext = React.createContext(false);

export const ConversationActivityStrip = React.memo(function ConversationActivityStrip(props: {
    messages: Message[];
    nested?: boolean;
    rootSubagentId?: string;
}) {
    const { theme } = useUnistyles();
    const suppressed = React.useContext(ConversationActivitySuppressedContext);
    const inspector = useSubagentInspector();
    const activities = React.useMemo(
        () => collectConversationActivities(props.messages, { rootSubagentId: props.rootSubagentId }),
        [props.messages, props.rootSubagentId],
    );
    const orderedActivities = React.useMemo(
        () => [...activities.skills, ...activities.subagents].sort((a, b) => a.order - b.order),
        [activities.skills, activities.subagents],
    );

    if (suppressed || (activities.skills.length === 0 && activities.subagents.length === 0)) {
        return null;
    }

    return (
        <View style={[styles.container, props.nested && styles.nestedContainer]}>
            {orderedActivities.map((activity) => activity.kind === 'skill' ? (
                    <SkillActivityRow
                        key={`skill-${activity.order}-${activity.name}`}
                        activity={activity}
                    />
                ) : inspector ? (
                    <Pressable
                        accessibilityLabel={t('toolGroup.openSubagentDetails', {
                            title: activity.title ?? activity.id,
                        })}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: inspector.selection?.id === activity.id }}
                        aria-expanded={inspector.selection?.id === activity.id}
                        key={`subagent-${activity.id}`}
                        onPress={() => inspector.open({
                            id: activity.id,
                            title: activity.title,
                            status: activity.status,
                        })}
                        style={({ pressed }) => [
                            styles.subagentRow,
                            { paddingLeft: 8 + activity.depth * 16 },
                            pressed && styles.rowPressed,
                        ]}
                        testID={`activity-subagent-${activity.id}`}
                    >
                        <Ionicons name="git-branch-outline" size={14} color={theme.colors.textSecondary} />
                        <Text style={styles.kind}>{t('toolGroup.subagentLabel')}</Text>
                        <Text style={styles.title} numberOfLines={1}>{activity.title ?? activity.id}</Text>
                        <View style={styles.statusPill}>
                            <ActivityStatusIcon status={activity.status} />
                            <Text style={styles.statusText}>{getStatusLabel(activity.status)}</Text>
                        </View>
                    </Pressable>
                ) : (
                    <View
                        key={`subagent-${activity.id}`}
                        style={[styles.subagentRow, { paddingLeft: 8 + activity.depth * 16 }]}
                        testID={`activity-subagent-${activity.id}`}
                    >
                        <Ionicons name="git-branch-outline" size={14} color={theme.colors.textSecondary} />
                        <Text style={styles.kind}>{t('toolGroup.subagentLabel')}</Text>
                        <Text style={styles.title} numberOfLines={1}>{activity.title ?? activity.id}</Text>
                        <View style={styles.statusPill}>
                            <ActivityStatusIcon status={activity.status} />
                            <Text style={styles.statusText}>{getStatusLabel(activity.status)}</Text>
                        </View>
                    </View>
                ))}
        </View>
    );
});

function SkillActivityRow(props: { activity: SkillConversationActivity }) {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const { activity } = props;
    const isFailed = activity.status === 'failed';
    const summary = activity.failure?.summary ?? (isFailed ? t('toolGroup.skillFailureNoDetails') : null);
    const detail = activity.failure?.detail;
    const hasAdditionalDetail = Boolean(detail && detail !== summary);
    const canExpand = isFailed && hasAdditionalDetail;
    const rowStyle = [
        styles.row,
        { paddingLeft: 8 + activity.depth * 16 },
        isFailed && styles.failedRow,
    ];
    const content = (
        <>
            <View style={styles.rowHeader}>
                <Ionicons name="sparkles-outline" size={14} color={theme.colors.textSecondary} />
                <Text style={styles.kind}>{t('toolGroup.skillLabel')}</Text>
                <Text style={styles.title} numberOfLines={1}>{activity.name}</Text>
                <View style={styles.statusPill}>
                    <ActivityStatusIcon status={activity.status} />
                    <Text style={styles.statusText}>{getStatusLabel(activity.status)}</Text>
                </View>
                {canExpand && (
                    <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={theme.colors.textSecondary}
                    />
                )}
            </View>
            {isFailed && summary && (
                <Text style={styles.failureSummary} numberOfLines={expanded ? undefined : 2}>
                    {summary}
                </Text>
            )}
            {expanded && hasAdditionalDetail && (
                <Text style={styles.failureDetail}>{detail}</Text>
            )}
        </>
    );

    if (!canExpand) {
        return (
            <View style={rowStyle} testID={`activity-skill-${activity.name}`}>
                {content}
            </View>
        );
    }

    return (
        <Pressable
            accessibilityLabel={t(
                expanded ? 'toolGroup.closeSkillDetails' : 'toolGroup.openSkillDetails',
                { title: activity.name },
            )}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            aria-expanded={expanded}
            onPress={() => setExpanded((value) => !value)}
            style={({ pressed }) => [rowStyle, pressed && styles.rowPressed]}
            testID={`activity-skill-${activity.name}`}
        >
            {content}
        </Pressable>
    );
}

function ActivityStatusIcon(props: { status: ConversationActivityStatus }) {
    const { theme } = useUnistyles();
    if (props.status === 'running') {
        return <ActivityIndicator size="small" color={theme.colors.warning} style={styles.spinner} />;
    }
    if (props.status === 'failed') {
        return <Ionicons name="close-circle" size={14} color={theme.colors.textDestructive} />;
    }
    if (props.status === 'cancelled') {
        return <Ionicons name="remove-circle-outline" size={14} color={theme.colors.textSecondary} />;
    }
    return <Ionicons name="checkmark-circle" size={14} color={theme.colors.success} />;
}

function getStatusLabel(status: ConversationActivityStatus): string {
    switch (status) {
        case 'running':
            return t('toolGroup.subagentStatus.running');
        case 'completed':
            return t('toolGroup.subagentStatus.completed');
        case 'failed':
            return t('toolGroup.subagentStatus.failed');
        case 'cancelled':
            return t('toolGroup.subagentStatus.cancelled');
    }
}

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        marginTop: 4,
        gap: 4,
    },
    nestedContainer: {
        marginHorizontal: 4,
        marginBottom: 4,
    },
    row: {
        minWidth: 0,
        minHeight: 24,
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 7,
        backgroundColor: theme.colors.surfaceHigh,
    },
    subagentRow: {
        minWidth: 0,
        minHeight: 24,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 7,
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowHeader: {
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    rowPressed: {
        opacity: 0.72,
    },
    failedRow: {
        backgroundColor: theme.colors.box.error.background,
        borderWidth: 1,
        borderColor: theme.colors.box.error.border,
    },
    kind: {
        flexShrink: 0,
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
    },
    title: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 12,
        fontFamily: 'monospace',
    },
    statusPill: {
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 999,
        backgroundColor: theme.colors.surfaceHighest,
    },
    statusText: {
        color: theme.colors.textSecondary,
        fontSize: 11,
    },
    failureSummary: {
        marginLeft: 20,
        marginTop: 3,
        color: theme.colors.box.error.text,
        fontSize: 12,
        lineHeight: 17,
    },
    failureDetail: {
        marginLeft: 20,
        marginTop: 4,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 16,
    },
    spinner: {
        transform: [{ scaleX: 0.65 }, { scaleY: 0.65 }],
    },
}));
