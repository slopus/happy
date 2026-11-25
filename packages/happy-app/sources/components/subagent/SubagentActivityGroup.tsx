import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { t } from '@/text';
import type { ConversationActivityStatus, SubagentConversationActivity } from '@/utils/conversationActivity';
import { CodingAgentIcon } from '../codingAgents/CodingAgentIcon';
import { SubagentActivityTooltip } from './SubagentActivityTooltip';

export type SubagentActivityGroupProps = {
    activities: SubagentConversationActivity[];
    selectedId?: string | null;
    onOpen?: (activity: SubagentConversationActivity) => void;
    nested?: boolean;
};

function timestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Keep this tiny formatter local instead of importing the tool-group renderer's
// dependency graph. It follows the existing work-duration label convention.
function duration(start: number | null, end: number | null): string | null {
    if (start === null || end === null) return null;
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours ? `${hours}h${minutes}m` : minutes ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

function statusLabel(status: ConversationActivityStatus): string {
    switch (status) {
        case 'running': return t('toolGroup.subagentStatus.running');
        case 'completed': return t('toolGroup.subagentStatus.completed');
        case 'failed': return t('toolGroup.subagentStatus.failed');
        case 'cancelled': return t('toolGroup.subagentStatus.cancelled');
    }
}

function Status({ status, compact = false }: { status: ConversationActivityStatus; compact?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.status}>
            {status === 'running' ? (
                <ActivityIndicator size="small" color={theme.colors.textLink} style={styles.spinner} />
            ) : (
                <Ionicons
                    name={status === 'completed' ? 'checkmark-circle-outline' : status === 'failed' ? 'close-circle-outline' : 'remove-circle-outline'}
                    size={13}
                    color={status === 'completed' ? theme.colors.success : status === 'failed' ? theme.colors.textDestructive : theme.colors.textSecondary}
                />
            )}
            <Text style={[styles.statusText, compact && styles.compactStatusText, status === 'failed' && styles.error]}>{statusLabel(status)}</Text>
        </View>
    );
}

function Avatar({ activity, indicator = false }: { activity: SubagentConversationActivity; indicator?: boolean }) {
    const { theme } = useUnistyles();
    const provider = activity.provider?.trim().toLowerCase();
    const knownProvider = provider && ['codex', 'claude', 'opencode', 'gemini', 'antigravity', 'openclaw'].includes(provider) ? provider : null;
    return (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.avatar}>
            {knownProvider ? <CodingAgentIcon agent={knownProvider} size={18} /> : <Ionicons name="git-branch-outline" size={18} color={theme.colors.text} />}
            {indicator ? <View style={[
                styles.avatarIndicator,
                activity.status === 'completed' && styles.completedIndicator,
                activity.status === 'failed' && styles.failedIndicator,
                activity.status === 'cancelled' && styles.cancelledIndicator,
            ]} /> : null}
        </View>
    );
}

export const SubagentActivityGroup = React.memo(function SubagentActivityGroup({ activities, selectedId, onOpen, nested }: SubagentActivityGroupProps) {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(true);
    const [compact, setCompact] = React.useState(Platform.OS !== 'web');
    const [hintId, setHintId] = React.useState<string | null>(null);
    const [focusedId, setFocusedId] = React.useState<string | null>(null);
    const [headerHovered, setHeaderHovered] = React.useState(false);
    const [headerFocused, setHeaderFocused] = React.useState(false);
    const groupId = React.useId();
    const dismissHint = React.useCallback(() => setHintId(null), []);
    const running = activities.filter(activity => activity.status === 'running');
    const runningStarts = running.map(activity => timestamp(activity.startedAt)).filter((value): value is number => value !== null);
    const clockStart = runningStarts.length ? Math.min(...runningStarts) : null;
    // This is one local display clock for the group, never a status query. A
    // terminal group passes null and useElapsedTime cleans up its interval.
    const clockDate = React.useMemo(() => clockStart === null ? null : new Date(clockStart), [clockStart]);
    const elapsedSeconds = useElapsedTime(clockDate);
    const now = clockStart === null ? null : clockStart + elapsedSeconds * 1000;
    const starts = activities.map(activity => timestamp(activity.startedAt)).filter((value): value is number => value !== null);
    const ends = activities.map(activity => activity.status === 'running' ? now : timestamp(activity.completedAt));
    const knownEnds = ends.filter((value): value is number => value !== null);
    const totalDuration = starts.length === activities.length && knownEnds.length === activities.length && starts.length > 0
        ? duration(Math.min(...starts), Math.max(...knownEnds))
        : null;
    const failures = activities.filter(activity => activity.status === 'failed').length;
    const summaryParts: string[] = [];
    if (running.length) summaryParts.push(t('toolGroup.subagents.running', { count: running.length }));
    if (failures) summaryParts.push(t('toolGroup.subagents.failed', { count: failures }));
    const summary = summaryParts.length ? summaryParts.join(' · ')
        : activities.every(activity => activity.status === 'completed') ? t('toolGroup.subagents.completed')
            : activities.every(activity => activity.status === 'cancelled') ? t('toolGroup.subagents.cancelled')
                : t('toolGroup.subagents.finished');
    const minimumDepth = activities.length ? Math.min(...activities.map(activity => activity.depth)) : 0;

    React.useEffect(() => {
        if (selectedId || !expanded || !activities.some(activity => activity.id === hintId)) setHintId(null);
    }, [activities, expanded, hintId, selectedId]);

    if (!activities.length) return null;

    return (
        <View
            style={[styles.group, nested && styles.nestedGroup]}
            onLayout={event => setCompact(event.nativeEvent.layout.width < 540)}
            testID="subagent-activity-group"
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t('toolGroup.subagents.count', { count: activities.length })}, ${summary}`}
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
                {...(Platform.OS === 'web' ? { 'aria-controls': `${groupId}-list` } : {})}
                onPress={() => { dismissHint(); setExpanded(value => !value); }}
                onHoverIn={() => setHeaderHovered(true)}
                onHoverOut={() => setHeaderHovered(false)}
                onFocus={() => setHeaderFocused(true)}
                onBlur={() => setHeaderFocused(false)}
                style={({ pressed }) => [styles.header, (pressed || headerHovered) && styles.pressed, headerFocused && styles.focused]}
                testID="subagent-activity-group-toggle"
            >
                <View style={styles.avatarStack}>
                    {activities.slice(0, 3).map((activity, index) => <View key={activity.id} style={index ? styles.stackedAvatar : undefined}><Avatar activity={activity} /></View>)}
                </View>
                <View style={styles.headerCopy}>
                    <Text numberOfLines={1} style={styles.heading}>{t('toolGroup.subagents.count', { count: activities.length })}</Text>
                    <Text numberOfLines={1} style={[styles.summary, !running.length && !failures && styles.secondary, failures > 0 && !running.length && styles.error]}>{summary}</Text>
                </View>
                <View style={styles.headerMeta}>
                    {totalDuration ? <Text style={styles.time} testID="subagent-group-duration">{totalDuration}</Text> : null}
                    <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
                </View>
            </Pressable>
            {expanded ? (
                <View nativeID={`${groupId}-list`} style={styles.list} testID="subagent-activity-list">
                    {activities.map(activity => {
                        const title = activity.title || activity.id;
                        const selected = selectedId === activity.id;
                        const rowDuration = duration(timestamp(activity.startedAt), activity.status === 'running' ? now : timestamp(activity.completedAt));
                        const subtitle = (activity.status === 'failed' && activity.failureSummary) || activity.currentAction || statusLabel(activity.status);
                        const previewVisible = Platform.OS === 'web' && hintId === activity.id && !selected;
                        const tooltipId = `${groupId}-${activity.id}-hint`;
                        const content = <>
                            <Avatar activity={activity} indicator />
                            <View style={styles.copy}>
                                <Text style={[styles.title, compact && styles.compactTitle]} numberOfLines={1}>{title}</Text>
                                <Text style={[styles.action, compact && styles.compactAction, activity.status === 'failed' && activity.failureSummary ? styles.error : undefined]} numberOfLines={1}>{subtitle}</Text>
                            </View>
                            <View style={[styles.rowMeta, compact && styles.compactMeta]}>
                                <Status status={activity.status} compact={compact} />
                                {rowDuration ? <Text style={[styles.time, compact && styles.compactTime]} testID={`activity-subagent-duration-${activity.id}`}>{rowDuration}</Text> : null}
                            </View>
                            {onOpen ? <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} /> : null}
                            {onOpen ? <SubagentActivityTooltip id={tooltipId} visible={previewVisible} onDismiss={dismissHint}>
                                <View style={styles.tooltip}>
                                    <Text style={styles.tooltipTitle} numberOfLines={2}>{title}</Text>
                                    {activity.model || activity.effort ? <Text style={styles.tooltipModel} numberOfLines={2}>{[activity.model, activity.effort].filter(Boolean).join(' · ')}</Text> : null}
                                    <View style={styles.tooltipStatus}><Status status={activity.status} />{rowDuration ? <Text style={styles.time}>{rowDuration}</Text> : null}</View>
                                    {activity.currentAction ? <View style={styles.tooltipAction}><Ionicons name="terminal-outline" size={15} color={theme.colors.textSecondary} /><Text style={styles.tooltipCommand} numberOfLines={6}>{activity.currentAction}</Text></View> : null}
                                    {activity.status === 'failed' && activity.failureSummary ? <Text style={[styles.tooltipFailure, styles.error]} numberOfLines={3}>{activity.failureSummary}</Text> : null}
                                    <Text style={styles.tooltipHint}>{t('toolGroup.subagents.viewDetails')}</Text>
                                </View>
                            </SubagentActivityTooltip> : null}
                        </>;
                        const anchor = Platform.OS === 'web' ? { dataSet: { transcriptActivity: JSON.stringify(['subagent', activity.id]) } } : {};
                        const rowStyle = [styles.row, compact && styles.compactRow, { paddingLeft: 11 + Math.max(0, activity.depth - minimumDepth) * 12 }];
                        return onOpen ? (
                            <Pressable
                                {...anchor}
                                {...(Platform.OS === 'web' ? { 'aria-describedby': previewVisible ? tooltipId : undefined } : {})}
                                key={activity.id}
                                accessibilityRole="button"
                                accessibilityLabel={t('toolGroup.openSubagentDetails', { title })}
                                accessibilityState={{ expanded: selected }}
                                aria-expanded={selected}
                                onPress={() => { dismissHint(); onOpen(activity); }}
                                onHoverIn={() => { if (!selected) setHintId(activity.id); }}
                                onHoverOut={() => setHintId(current => current === activity.id ? null : current)}
                                onFocus={() => { setFocusedId(activity.id); if (!selected) setHintId(activity.id); }}
                                onBlur={() => { setFocusedId(null); setHintId(current => current === activity.id ? null : current); }}
                                style={(state: { pressed: boolean; hovered?: boolean }) => [
                                    ...rowStyle,
                                    (state.pressed || state.hovered || hintId === activity.id) && styles.pressed,
                                    selected && styles.selected,
                                    focusedId === activity.id && styles.focused,
                                ]}
                                testID={`activity-subagent-${activity.id}`}
                            >{content}</Pressable>
                        ) : <View {...anchor} key={activity.id} style={rowStyle} testID={`activity-subagent-${activity.id}`}>{content}</View>;
                    })}
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create(theme => ({
    group: { minWidth: 0, marginTop: 8, marginBottom: 8 },
    nestedGroup: { marginTop: 4, marginBottom: 4 },
    header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 3, paddingVertical: 7, marginBottom: 6, borderWidth: 1, borderColor: 'transparent', borderRadius: 8 },
    avatarStack: { flexDirection: 'row', alignItems: 'center', flexShrink: 0, paddingLeft: 1 },
    stackedAvatar: { marginLeft: -9 },
    avatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfacePressed, borderWidth: 1, borderColor: theme.colors.divider, flexShrink: 0 },
    avatarIndicator: { position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: theme.colors.surface, backgroundColor: theme.colors.textLink },
    completedIndicator: { backgroundColor: theme.colors.success },
    failedIndicator: { backgroundColor: theme.colors.textDestructive },
    cancelledIndicator: { backgroundColor: theme.colors.textSecondary },
    headerCopy: { flex: 1, minWidth: 0, gap: 2 },
    heading: { fontSize: 14, lineHeight: 21, color: theme.colors.text, ...Typography.default('semiBold') },
    summary: { fontSize: 12, lineHeight: 18, color: theme.colors.textLink, ...Typography.default() },
    secondary: { color: theme.colors.textSecondary },
    headerMeta: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 0 },
    list: { padding: 4, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 11, backgroundColor: theme.colors.surface },
    row: { position: 'relative', minWidth: 0, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 11, paddingVertical: 9, borderWidth: 1, borderColor: 'transparent', borderRadius: 7 },
    compactRow: { minHeight: 67, gap: 9, paddingRight: 8, paddingVertical: 10 },
    copy: { flex: 1, minWidth: 0, gap: 4 },
    title: { fontSize: 14, lineHeight: 19, color: theme.colors.text, ...Typography.default('semiBold') },
    compactTitle: { fontSize: 13 },
    action: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.mono() },
    compactAction: { fontSize: 11 },
    rowMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 14, flexShrink: 0 },
    compactMeta: { flexDirection: 'column', alignItems: 'flex-end', gap: 3 },
    time: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, fontVariant: ['tabular-nums'], ...Typography.default() },
    compactTime: { fontSize: 11 },
    status: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
    statusText: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    compactStatusText: { fontSize: 11 },
    spinner: { width: 13, height: 13, transform: [{ scaleX: 0.65 }, { scaleY: 0.65 }] },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    focused: { borderColor: theme.colors.textLink },
    error: { color: theme.colors.textDestructive },
    tooltip: { padding: 16, gap: 10, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, backgroundColor: theme.colors.surface, shadowColor: theme.colors.shadow.color, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 14, shadowOffset: { width: 0, height: 8 } },
    tooltipTitle: { fontSize: 14, lineHeight: 20, color: theme.colors.text, ...Typography.default('semiBold') },
    tooltipModel: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    tooltipStatus: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
    tooltipAction: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    tooltipCommand: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 19, color: theme.colors.textSecondary, ...Typography.mono() },
    tooltipFailure: { paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.divider, fontSize: 12, lineHeight: 19, ...Typography.default() },
    tooltipHint: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 17, ...Typography.default() },
}));
