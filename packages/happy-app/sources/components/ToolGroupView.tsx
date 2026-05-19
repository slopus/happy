import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import {
    AgentWorkGroupItem,
    ToolGroupItem,
    ToolDisplayItem,
    formatWorkDuration,
    generateGroupSummary,
    groupToolCallsForDisplay,
} from '@/hooks/useGroupedMessages';
import { MessageView } from './MessageView';
import { Metadata } from '@/sync/storageTypes';
import { layout } from './layout';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { t } from '@/text';

interface ToolGroupViewProps {
    group: ToolGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    onToggle: () => void;
}

export const ToolGroupView = React.memo<ToolGroupViewProps>((props) => {
    const { group, metadata, sessionId, expanded, onToggle } = props;
    const summary = React.useMemo(() => generateGroupSummary(group.messages), [group.messages]);

    return (
        <View style={styles.outerContainer}>
            <View style={styles.innerContainer}>
                <CollapseHeader
                    expanded={expanded}
                    hasRunning={group.hasRunning}
                    label={summary}
                    onPress={onToggle}
                />
                {expanded && (
                    <View style={styles.content}>
                        {group.messages.map((msg) => (
                            <MessageView
                                key={msg.id}
                                message={msg}
                                metadata={metadata}
                                sessionId={sessionId}
                            />
                        ))}
                    </View>
                )}
            </View>
        </View>
    );
});

interface AgentWorkGroupViewProps {
    group: AgentWorkGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    onToggle: () => void;
}

export const AgentWorkGroupView = React.memo<AgentWorkGroupViewProps>((props) => {
    const { group, metadata, sessionId, expanded, onToggle } = props;
    const runningElapsedSeconds = useElapsedTime(group.completedAt === null ? group.startedAt : null);
    const durationMs = group.completedAt === null
        ? runningElapsedSeconds * 1000
        : group.completedAt - group.startedAt;
    const label = t('toolGroup.workedFor', { duration: formatWorkDuration(durationMs) });
    const nestedItemsNewestFirst = React.useMemo(
        () => groupToolCallsForDisplay(group.messages, true),
        [group.messages],
    );
    const nestedItems = React.useMemo(
        () => [...nestedItemsNewestFirst].reverse(),
        [nestedItemsNewestFirst],
    );

    const [collapsedToolGroups, setCollapsedToolGroups] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        for (const item of nestedItemsNewestFirst) {
            if (item.type === 'tool-group' && !item.hasPendingPermission) {
                initial.add(item.id);
            }
        }
        return initial;
    });
    const manuallyCollapsedToolGroupsRef = React.useRef<Set<string>>(new Set());

    React.useEffect(() => {
        setCollapsedToolGroups((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const item of nestedItemsNewestFirst) {
                if (item.type !== 'tool-group') {
                    continue;
                }
                if (item.hasPendingPermission && next.has(item.id) && !manuallyCollapsedToolGroupsRef.current.has(item.id)) {
                    next.delete(item.id);
                    changed = true;
                    continue;
                }
                if (!item.hasPendingPermission && !next.has(item.id)) {
                    next.add(item.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [nestedItemsNewestFirst]);

    const handleToggleNestedGroup = React.useCallback((groupId: string) => {
        setCollapsedToolGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
                manuallyCollapsedToolGroupsRef.current.delete(groupId);
            } else {
                next.add(groupId);
                manuallyCollapsedToolGroupsRef.current.add(groupId);
            }
            return next;
        });
    }, []);

    const renderNestedItem = React.useCallback((item: ToolDisplayItem) => {
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    key={item.id}
                    group={item}
                    metadata={metadata}
                    sessionId={sessionId}
                    expanded={!collapsedToolGroups.has(item.id)}
                    onToggle={() => handleToggleNestedGroup(item.id)}
                />
            );
        }
        return (
            <MessageView
                key={item.id}
                message={item.message}
                metadata={metadata}
                sessionId={sessionId}
            />
        );
    }, [collapsedToolGroups, handleToggleNestedGroup, metadata, sessionId]);

    return (
        <View style={styles.outerContainer}>
            <View style={styles.innerContainer}>
                <CollapseHeader
                    expanded={expanded}
                    hasRunning={group.hasRunning}
                    label={label}
                    onPress={onToggle}
                />
                {expanded && (
                    <View style={styles.content}>
                        {nestedItems.map(renderNestedItem)}
                    </View>
                )}
            </View>
        </View>
    );
});

function CollapseHeader(props: {
    expanded: boolean;
    hasRunning: boolean;
    label: string;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.header,
                pressed && styles.headerPressed,
            ]}
        >
            <Text style={styles.summaryText} numberOfLines={1}>
                {props.label}
            </Text>
            {props.hasRunning && (
                <ActivityIndicator
                    size="small"
                    color={theme.colors.textSecondary}
                    style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
                />
            )}
            <Ionicons
                name={props.expanded ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color={theme.colors.textSecondary}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    innerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        maxWidth: layout.maxWidth,
        marginVertical: 6,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'stretch',
        marginHorizontal: 16,
        paddingVertical: 4,
        borderRadius: 4,
    },
    headerPressed: {
        opacity: 0.6,
    },
    summaryText: {
        flexShrink: 1,
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    content: {
        marginTop: 4,
    },
}));
