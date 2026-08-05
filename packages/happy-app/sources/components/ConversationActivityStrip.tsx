import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Message } from '@/sync/typesMessage';
import { t } from '@/text';
import {
    collectConversationActivities,
    ConversationActivityStatus,
} from '@/utils/conversationActivity';

export const ConversationActivitySuppressedContext = React.createContext(false);

export const ConversationActivityStrip = React.memo(function ConversationActivityStrip(props: {
    messages: Message[];
    nested?: boolean;
    rootSubagentId?: string;
}) {
    const { theme } = useUnistyles();
    const suppressed = React.useContext(ConversationActivitySuppressedContext);
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
                    <View
                        key={`skill-${activity.order}-${activity.name}`}
                        style={[styles.row, { paddingLeft: 8 + activity.depth * 16 }]}
                        testID={`activity-skill-${activity.name}`}
                    >
                        <Ionicons name="sparkles-outline" size={14} color={theme.colors.textSecondary} />
                        <Text style={styles.kind}>{t('toolGroup.skillLabel')}</Text>
                        <Text style={styles.title} numberOfLines={1}>{activity.name}</Text>
                        <View style={styles.statusPill}>
                            <ActivityStatusIcon status={activity.status} />
                            <Text style={styles.statusText}>{getStatusLabel(activity.status)}</Text>
                        </View>
                    </View>
                ) : (
                    <View
                        key={`subagent-${activity.id}`}
                        style={[styles.row, { paddingLeft: 8 + activity.depth * 16 }]}
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 7,
        backgroundColor: theme.colors.surfaceHigh,
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
    spinner: {
        transform: [{ scaleX: 0.65 }, { scaleY: 0.65 }],
    },
}));
