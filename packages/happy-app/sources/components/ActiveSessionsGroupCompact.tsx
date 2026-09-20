import React from 'react';
import { View, Pressable, Platform, useWindowDimensions } from 'react-native';
import { Text } from '@/components/StyledText';
import { Feather } from '@expo/vector-icons';
import { type SessionState, getSessionStateLabel } from '@/utils/sessionUtils';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { storage, type SessionRowData, useAllMachines, useLocalSettingMutable, useLocalSettingUpdater, useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor } from './SessionActionsPopover';
import {
    SessionRowActions,
    SessionRowDetails,
    useSessionRowDisclosure,
    useSessionRowPresentation,
} from './SessionRowChrome';
import { hapticsLight } from './haptics';
import { useRouter } from 'expo-router';
import { useSessionManagementPreferences } from '@/hooks/useSessionManagementPreferences';
import { useLocalDayRollover } from '@/hooks/useLocalDayRollover';
import { buildSessionNavigationGroups, buildSessionNavigationTimeGroups } from '@/utils/sessionNavigationGroups';
import { sync } from '@/sync/sync';
import { loadPendingPermissionMessageId } from '@/utils/pendingPermission';
import { ProjectSectionHeader } from './ProjectSectionHeader';
import { partitionSessionsByPinnedOrder } from '@/utils/sessionPinning';
import { isSidebarGroupExpanded, setSidebarGroupExpanded } from '@/utils/sidebarGroupExpansion';

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean }> = {
    idle: { color: '#6B7280', dotColor: '#9CA3AF', isPulsing: false },
    running: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true },
    failed: { color: '#FF3B30', dotColor: '#FF3B30', isPulsing: false },
    completed: { color: '#34C759', dotColor: '#34C759', isPulsing: false },
};

interface ActiveSessionsGroupProps {
    layoutMode?: 'projects' | 'time';
    sessions: SessionRowData[];
    selectedSessionId?: string;
    selectionMode?: boolean;
    selectedIds?: Set<string>;
    onStartSelection?: (sessionId: string) => void;
    onToggleSelection?: (sessionId: string) => void;
}

// Full-width separator between machine groups: ——— 🖥 name ———
const MachineSeparator = React.memo(({ machineName, machineId }: { machineName: string; machineId: string }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();

    const handlePress = React.useCallback(() => {
        router.navigate(`/machine/${machineId}` as any);
    }, [router, machineId]);

    return (
        <Pressable onPress={handlePress} style={styles.machineSeparator} hitSlop={{ top: 8, bottom: 8 }}>
            <View style={styles.machineSeparatorLine} />
            <Feather name="monitor" size={12} color={theme.colors.textSecondary} style={{ marginHorizontal: 6 }} />
            <Text style={styles.machineSeparatorText} numberOfLines={1}>
                {machineName}
            </Text>
            <View style={styles.machineSeparatorLine} />
        </Pressable>
    );
});

export function useActiveSessionListItems({
    layoutMode = 'projects',
    sessions,
    selectedSessionId,
}: ActiveSessionsGroupProps): CompactSessionListItem[] {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines();
    const sessionIds = React.useMemo(() => sessions.map(session => session.id), [sessions]);
    const sessionManagement = useSessionManagementPreferences(sessionIds, { prune: false });
    const localDayIndex = useLocalDayRollover();
    const partitionedSessions = React.useMemo(() => partitionSessionsByPinnedOrder(
        sessions,
        sessionManagement.preferences.pinnedOrder,
    ), [sessionManagement.preferences.pinnedOrder, sessions]);

    // Machines are an explicit grouping dimension; projects are the compact,
    // collapsible units users scan to find recent sessions.
    const machineGroups = React.useMemo(() => buildSessionNavigationGroups({
        machines,
        pinnedOrder: [],
        sessions: partitionedSessions.regular,
        unknownLabel: t('status.unknown'),
    }), [machines, partitionedSessions.regular]);
    const hasMultipleMachines = machineGroups.length > 1;
    const timeGroups = React.useMemo(
        () => buildSessionNavigationTimeGroups(partitionedSessions.regular),
        [localDayIndex, partitionedSessions.regular],
    );
    const [sidebarGroupExpansion] = useLocalSettingMutable('sidebarGroupExpansion');
    const updateSidebarGroupExpansion = useLocalSettingUpdater('sidebarGroupExpansion');

    const selectedProjectKey = React.useMemo(() => {
        if (!selectedSessionId) return null;
        for (const machineGroup of machineGroups) {
            for (const project of machineGroup.projects) {
                if (project.sessions.some((session) => session.id === selectedSessionId)) {
                    return project.key;
                }
            }
        }
        return null;
    }, [machineGroups, selectedSessionId]);

    // A navigation to another session always reveals its project. Users may
    // still collapse the currently selected project afterwards; the header's
    // accent marker preserves the active context while collapsed.
    React.useEffect(() => {
        if (!selectedProjectKey) return;
        updateSidebarGroupExpansion((current) => setSidebarGroupExpanded(
            current,
            'projects',
            selectedProjectKey,
            true,
            true,
        ));
    }, [selectedProjectKey, updateSidebarGroupExpansion]);

    const toggleProject = React.useCallback((projectKey: string) => {
        updateSidebarGroupExpansion((current) => {
            const expanded = isSidebarGroupExpanded(current, 'projects', projectKey, true);
            return setSidebarGroupExpanded(current, 'projects', projectKey, !expanded, true);
        });
    }, [updateSidebarGroupExpansion]);

    const getTimeGroupLabel = React.useCallback((dayOffset: number) => {
        if (dayOffset === 0) return t('sessionHistory.today');
        if (dayOffset === 1) return t('sessionHistory.yesterday');
        return t('sessionHistory.daysAgo', { count: dayOffset });
    }, []);

    const items: CompactSessionListItem[] = [];
    if (sessions.length === 0) return items;
    items.push({ type: 'compact-header', key: 'active-start', element: <View style={{ height: 12 }} /> });
    const appendSessions = (rows: SessionRowData[], showLocation: boolean, bottom: number) => {
        rows.forEach((session, index) => items.push({
            type: 'compact-session',
            key: `session-${session.id}`,
            session,
            showLocation,
            showBorder: !showLocation && index < rows.length - 1,
            marginBottom: index === rows.length - 1 ? bottom : 0,
        }));
    };
    if (partitionedSessions.pinned.length > 0) {
        items.push({
            type: 'compact-header', key: 'pinned-header',
            element: <Text style={styles.timeGroupLabel} testID="session-pinned-group">{t('sessionSearch.sections.pinned')}</Text>,
        });
        appendSessions(partitionedSessions.pinned, true, 10);
    }
    if (layoutMode === 'projects') {
        machineGroups.forEach((machineGroup) => {
            if (hasMultipleMachines) {
                items.push({
                    type: 'compact-header', key: `machine-${machineGroup.machineId}`,
                    element: <MachineSeparator machineName={machineGroup.machineName} machineId={machineGroup.machineId} />,
                });
            }
            machineGroup.projects.forEach((projectGroup) => {
                const firstSession = projectGroup.sessions[0];
                if (!firstSession) return;
                const expanded = isSidebarGroupExpanded(sidebarGroupExpansion, 'projects', projectGroup.key, true);
                const selectedSession = selectedSessionId
                    ? projectGroup.sessions.find((candidate) => candidate.id === selectedSessionId)
                    : null;
                const activitySession = selectedSession ?? projectGroup.sessions.find((candidate) => (
                    candidate.state === 'permission_required' || candidate.state === 'running' || candidate.hasUnread
                ));
                const activity = activitySession ? {
                    color: activitySession.hasUnread && activitySession.state === 'idle'
                        ? theme.colors.accent : STATUS_CONFIG[activitySession.state].dotColor,
                    isPulsing: STATUS_CONFIG[activitySession.state].isPulsing,
                    label: `${getSessionStateLabel(activitySession.state)}${activitySession.isConnected ? '' : ` · ${t('status.disconnected')}`}`,
                    textColor: STATUS_CONFIG[activitySession.state].color,
                } : null;
                items.push({
                    type: 'compact-header', key: `project-${projectGroup.key}`,
                    element: <ProjectSectionHeader
                        activity={activity}
                        current={projectGroup.key === selectedProjectKey}
                        session={firstSession}
                        displayPath={projectGroup.displayPath}
                        expanded={expanded}
                        machineId={machineGroup.machineId}
                        path={projectGroup.path}
                        onCreateSession={() => router.navigate('/new')}
                        onToggle={() => toggleProject(projectGroup.key)}
                        testID={`sidebar-project-toggle-${projectGroup.key}`}
                    />,
                });
                if (expanded) appendSessions(projectGroup.sessions, false, 4);
            });
        });
    } else {
        timeGroups.forEach((group) => {
            items.push({
                type: 'compact-header', key: `time-${group.key}`,
                element: <Text style={styles.timeGroupLabel} testID={`session-time-group-${group.dayOffset}`}>{getTimeGroupLabel(group.dayOffset)}</Text>,
            });
            appendSessions(group.sessions, true, 10);
        });
    }
    items.push({ type: 'compact-header', key: 'active-end', element: <View style={{ height: 12 }} /> });
    return items;
}

// Headers and individual sessions are data items at the outer FlatList level,
// so expanding a large project never mounts its entire session tree at once.
export type CompactSessionListItem =
    | { type: 'compact-header'; key: string; element: React.ReactElement }
    | { type: 'compact-session'; key: string; session: SessionRowData; showLocation: boolean; showBorder: boolean; marginBottom: number };

export function CompactSessionListRow({ item, ...props }: Omit<ActiveSessionsGroupProps, 'sessions' | 'layoutMode'> & { item: CompactSessionListItem }) {
    if (item.type === 'compact-header') return item.element;
    return (
        <View style={{ marginBottom: item.marginBottom }}>
            <CompactSessionRow
                session={item.session}
                selected={props.selectedSessionId === item.session.id}
                bulkSelected={props.selectedIds?.has(item.session.id) ?? false}
                selectionMode={props.selectionMode}
                showLocation={item.showLocation}
                showBorder={item.showBorder}
                onStartSelection={props.onStartSelection}
                onToggleSelection={props.onToggleSelection}
            />
        </View>
    );
}

export function ActiveSessionsGroupCompact(props: ActiveSessionsGroupProps) {
    const items = useActiveSessionListItems(props);
    return <View style={{ backgroundColor: stylesheet.container.backgroundColor }}>
        {items.map(item => <CompactSessionListRow key={item.key} item={item} {...props} />)}
    </View>;
}

// Compact Codex-style session row. Runtime status stays visible while actions
// and richer metadata remain available through hover disclosure.
export const CompactSessionRow = React.memo(({ nested = false, onOrganize, session, selected, bulkSelected, selectionMode, showBorder, showLocation = false, onStartSelection, onToggleSelection, testID }: {
    nested?: boolean;
    onOrganize?: () => void;
    session: SessionRowData;
    selected?: boolean;
    bulkSelected?: boolean;
    selectionMode?: boolean;
    showBorder?: boolean;
    showLocation?: boolean;
    onStartSelection?: (sessionId: string) => void;
    onToggleSelection?: (sessionId: string) => void;
    testID?: string;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const router = useRouter();
    const organization = useSetting('sidebarOrganization');
    const compactTitle = useWindowDimensions().width < 600;
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const disclosure = useSessionRowDisclosure(session.name);
    const presentation = useSessionRowPresentation(session);
    const baseStatus = STATUS_CONFIG[session.state];
    const status = session.hasUnread
        ? { ...baseStatus, dotColor: theme.colors.accent, isPulsing: false }
        : baseStatus;
    const sessionTags = (organization.sessions[session.id]?.tagIds ?? [])
        .map((tagId) => organization.tags.find((tag) => tag.id === tagId))
        .filter((tag) => !!tag);

    const handlePress = React.useCallback(async () => {
        if (selectionMode) {
            onToggleSelection?.(session.id);
            return;
        }
        if (session.state === 'permission_required') {
            const messageId = await loadPendingPermissionMessageId({
                ensureLoaded: () => sync.ensureMessagesLoaded(session.id),
                getMessages: () => storage.getState().sessionMessages[session.id]?.messages ?? [],
            });
            if (messageId) {
                if (router.canDismiss()) {
                    router.dismissTo('/');
                }
                router.navigate(`/session/${encodeURIComponent(session.id)}/message/${encodeURIComponent(messageId)}` as any);
                return;
            }
        }
        navigateToSession(session.id);
    }, [navigateToSession, onToggleSelection, router, selectionMode, session.id, session.state]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    // Native long-press: anchor the context menu at the touch point instead of
    // showing a centered alert. pageX/pageY come from the gesture responder event.
    const handleLongPress = React.useCallback((event: any) => {
        hapticsLight();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : selectionMode ? {} : {
        onLongPress: handleLongPress,
    };

    const renderLeadingIndicator = () => {
        let indicator: React.ReactNode = null;

        if (selectionMode) {
            indicator = (
                <View style={[styles.selectionCheckbox, bulkSelected && styles.selectionCheckboxSelected]}>
                    {bulkSelected ? (
                        <Feather
                            name="check"
                            size={14}
                            color="#FFFFFF"
                        />
                    ) : null}
                </View>
            );
        }

        return (
            <View style={styles.leadingIndicatorSlot}>
                {indicator}
            </View>
        );
    };

    const itemContent = (
        <View
            style={[
                styles.sessionRow,
                nested && styles.sessionRowNested,
                showLocation && styles.sessionRowByTime,
                showBorder && styles.sessionRowWithBorder,
                disclosure.visible && styles.sessionRowHovered,
                (selected || bulkSelected || !!actionsAnchor) && styles.sessionRowSelected
            ]}
        >
            <Pressable
                accessibilityLabel={`${session.name}, ${getSessionStateLabel(session.state)}${session.isConnected ? '' : `, ${t('status.disconnected')}`}`}
                accessibilityRole="button"
                accessibilityState={{ selected: !!selected }}
                aria-current={selected ? 'page' : undefined}
                focusable
                onPress={handlePress}
                style={styles.sessionPressTarget}
                testID={testID ?? `session-row-${session.id}`}
                {...menuProps}
            >
                <View style={[styles.sessionContent, showLocation && styles.sessionContentByTime]}>
                    <View style={styles.sessionTitleRow}>
                        {selectionMode ? renderLeadingIndicator() : null}
                        <View
                            style={styles.sessionTitleViewport}
                            testID="session-row-title"
                            {...(Platform.OS === 'web' ? {
                                dataSet: {
                                    marqueeActive: disclosure.visible && disclosure.titleOverflowing ? 'true' : 'false',
                                },
                            } as any : {})}
                        >
                            <Text
                                style={[
                                    styles.sessionTitle,
                                    session.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                                ]}
                                numberOfLines={compactTitle ? 2 : 1}
                                testID="session-row-title-text"
                            >
                                {session.name}
                            </Text>
                        </View>
                    </View>
                    {showLocation ? (
                        <View
                            accessibilityLabel={`${presentation.project} · ${presentation.machine}`}
                            style={styles.timeLocationRow}
                        >
                            <Feather color={stylesheet.timeLocationText.color} name="folder" size={13} />
                            <Text numberOfLines={1} style={styles.timeLocationText}>
                                {presentation.project} · {presentation.machine}
                            </Text>
                        </View>
                    ) : null}
                    {sessionTags.length > 0 ? (
                        <View style={styles.sessionTags} testID={`session-row-tags-${session.id}`}>
                            {sessionTags.slice(0, 2).map((tag) => (
                                <View key={tag.id} style={styles.sessionTag} testID={`session-row-tag-${tag.id}`}>
                                    <Text numberOfLines={1} style={styles.sessionTagText}>#{tag.name}</Text>
                                </View>
                            ))}
                            {sessionTags.length > 2 ? <Text style={styles.sessionTagMore}>+{sessionTags.length - 2}</Text> : null}
                        </View>
                    ) : null}
                    <View style={styles.statusRow} testID="session-row-status">
                        <View style={styles.statusDotContainer}>
                            <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                        </View>
                        <Text style={[styles.statusText, { color: baseStatus.color }]} numberOfLines={1}>
                            {presentation.status}
                        </Text>
                    </View>
                </View>
            </Pressable>
            {!selectionMode ? (
                <SessionRowActions
                    contextAnchor={actionsAnchor}
                    onContextAnchorChange={setActionsAnchor}
                    onOrganize={onOrganize}
                    onStartSelection={onStartSelection ? () => onStartSelection(session.id) : undefined}
                    sessionId={session.id}
                    statusLabel={presentation.status}
                    visible={disclosure.visible}
                />
            ) : null}
        </View>
    );

    return (
        <View
            ref={disclosure.wrapperRef}
            style={[styles.sessionRowWrapper, (disclosure.visible || !!actionsAnchor) && styles.sessionRowWrapperRaised]}
            {...disclosure.interactionProps as any}
        >
            {itemContent}
            <SessionRowDetails
                anchor={disclosure.detailsAnchor}
                presentation={presentation}
                visible={!selectionMode && disclosure.visible}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.groupped.background,
        paddingBottom: 12,
        paddingTop: 12,
    },
    timeGroup: {
        marginBottom: 10,
        position: 'relative',
    },
    timeGroupLabel: {
        color: theme.colors.groupped.sectionTitle,
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 4,
        paddingHorizontal: 16,
        ...Typography.default('semiBold'),
    },
    // Machine separator styles
    machineSeparator: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 8,
        paddingBottom: 0,
    },
    machineSeparatorLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    machineSeparatorText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        marginRight: 4,
    },
    projectGroupWrapper: {
        position: 'relative',
    },
    projectSessions: {
        marginBottom: 4,
        overflow: 'visible',
    },
    sessionRow: {
        borderRadius: 12,
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 8,
        minHeight: 52,
        paddingLeft: 38,
        paddingRight: 8,
    },
    sessionRowNested: {
        borderLeftColor: theme.colors.divider,
        borderLeftWidth: StyleSheet.hairlineWidth,
        marginLeft: 30,
        paddingLeft: 10,
    },
    sessionRowByTime: {
        minHeight: 68,
        paddingLeft: 10,
    },
    sessionRowWithBorder: {
        borderBottomWidth: 0,
    },
    sessionRowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: Platform.OS === 'web' ? 0.18 : theme.colors.shadow.opacity,
        shadowRadius: 8,
    },
    sessionRowHovered: {
        backgroundColor: theme.colors.surfaceSelected,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: Platform.OS === 'web' ? 0.18 : theme.colors.shadow.opacity,
        shadowRadius: 8,
    },
    sessionContent: {
        flex: 1,
        justifyContent: 'center',
        minWidth: 0,
        paddingVertical: 5,
    },
    sessionContentByTime: {
        paddingVertical: 7,
    },
    timeLocationRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
        minWidth: 0,
    },
    timeLocationText: {
        color: theme.colors.textSecondary,
        flexShrink: 1,
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default('regular'),
    },
    sessionTags: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
        minHeight: 18,
        overflow: 'hidden',
    },
    sessionTag: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        maxWidth: 96,
        paddingHorizontal: 6,
        paddingVertical: 1,
    },
    sessionTagText: { color: theme.colors.textSecondary, fontSize: 10, lineHeight: 14, ...Typography.default('semiBold') },
    sessionTagMore: { color: theme.colors.textSecondary, fontSize: 10, ...Typography.default('semiBold') },
    statusRow: {
        alignItems: 'center',
        flexDirection: 'row',
        minWidth: 0,
    },
    statusDotContainer: {
        alignItems: 'center',
        height: 16,
        justifyContent: 'center',
        marginRight: 4,
    },
    statusText: {
        flexShrink: 1,
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default('semiBold'),
    },
    sessionPressTarget: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        minWidth: 0,
    },
    sessionRowWrapper: {
        position: 'relative',
        zIndex: 0,
    },
    sessionRowWrapperRaised: {
        zIndex: 40,
    },
    sessionTitleRow: {
        minHeight: 20,
        flexDirection: 'row',
        alignItems: 'center',
    },
    sessionTitleViewport: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
    },
    sessionTitle: {
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default('regular'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    leadingIndicatorSlot: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        marginRight: 8,
    },
    selectionCheckbox: {
        width: 20,
        height: 20,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    selectionCheckboxSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
}));
