import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { Feather } from '@expo/vector-icons';
import { type SessionState, getSessionStateLabel } from '@/utils/sessionUtils';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { storage, type SessionRowData, useAllMachines, useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
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
import { DesktopShortcutTooltip } from './DesktopShortcutTooltip';
import { ProjectSectionHeader } from './ProjectSectionHeader';

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean }> = {
    idle: { color: '#6B7280', dotColor: '#9CA3AF', isPulsing: false },
    running: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true },
    failed: { color: '#FF3B30', dotColor: '#FF3B30', isPulsing: false },
    completed: { color: '#34C759', dotColor: '#34C759', isPulsing: false },
};

interface ActiveSessionsGroupProps {
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

export function ActiveSessionsGroupCompact({
    sessions,
    selectedSessionId,
    selectionMode = false,
    selectedIds,
    onStartSelection,
    onToggleSelection,
}: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines();
    const sessionIds = React.useMemo(() => sessions.map(session => session.id), [sessions]);
    const sessionManagement = useSessionManagementPreferences(sessionIds, { prune: false });
    const [layoutMode, setLayoutMode] = useLocalSettingMutable('sessionListLayout');
    const [layoutTooltipVisible, setLayoutTooltipVisible] = React.useState(false);
    const localDayIndex = useLocalDayRollover();

    // Machines are an explicit grouping dimension; projects are the compact,
    // collapsible units users scan to find recent sessions.
    const machineGroups = React.useMemo(() => buildSessionNavigationGroups({
        machines,
        pinnedOrder: sessionManagement.preferences.pinnedOrder,
        sessions,
        unknownLabel: t('status.unknown'),
    }), [machines, sessionManagement.preferences.pinnedOrder, sessions]);
    const hasMultipleMachines = machineGroups.length > 1;
    const timeGroups = React.useMemo(
        () => buildSessionNavigationTimeGroups(sessions),
        [localDayIndex, sessions],
    );
    const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(() => new Set());

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
        setCollapsedProjects((current) => {
            if (!current.has(selectedProjectKey)) return current;
            const next = new Set(current);
            next.delete(selectedProjectKey);
            return next;
        });
    }, [selectedProjectKey]);

    const toggleProject = React.useCallback((projectKey: string) => {
        setCollapsedProjects((current) => {
            const next = new Set(current);
            if (next.has(projectKey)) {
                next.delete(projectKey);
            } else {
                next.add(projectKey);
            }
            return next;
        });
    }, []);

    const toggleLayoutMode = React.useCallback(() => {
        setLayoutMode(layoutMode === 'projects' ? 'time' : 'projects');
    }, [layoutMode, setLayoutMode]);

    const layoutActionLabel = layoutMode === 'projects'
        ? t('sidebar.sortSessionsByTime')
        : t('sidebar.groupSessionsByProject');
    const layoutActionIcon = layoutMode === 'projects' ? 'clock' : 'folder';

    const getTimeGroupLabel = React.useCallback((dayOffset: number) => {
        if (dayOffset === 0) return t('sessionHistory.today');
        if (dayOffset === 1) return t('sessionHistory.yesterday');
        return t('sessionHistory.daysAgo', { count: dayOffset });
    }, []);

    return (
        <View style={styles.container}>
            <View style={styles.layoutHeader}>
                <Text style={styles.layoutTitle}>
                    {layoutMode === 'projects' ? t('devTools.projects') : t('sessionSearch.sections.recent')}
                </Text>
                <View style={styles.layoutToggleWrapper}>
                    <Pressable
                        accessibilityLabel={layoutActionLabel}
                        accessibilityRole="button"
                        onBlur={() => setLayoutTooltipVisible(false)}
                        onFocus={() => setLayoutTooltipVisible(true)}
                        onHoverIn={() => setLayoutTooltipVisible(true)}
                        onHoverOut={() => setLayoutTooltipVisible(false)}
                        onPress={toggleLayoutMode}
                        style={({ pressed }) => [
                            styles.layoutToggle,
                            layoutTooltipVisible && styles.layoutToggleHovered,
                            pressed && styles.layoutTogglePressed,
                        ]}
                        testID="session-list-layout-toggle"
                    >
                        <Feather
                            color={theme.colors.textSecondary}
                            dataSet={{ iconName: layoutActionIcon }}
                            name={layoutActionIcon}
                            size={16}
                            testID="session-list-layout-toggle-icon"
                        />
                    </Pressable>
                    <DesktopShortcutTooltip
                        align="right"
                        compact
                        label={layoutActionLabel}
                        testID="session-list-layout-tooltip"
                        visible={Platform.OS === 'web' && layoutTooltipVisible}
                    />
                </View>
            </View>
            {layoutMode === 'projects' ? machineGroups.map((machineGroup, machineIndex) => {
                return (
                    <React.Fragment key={machineGroup.machineId}>
                        {hasMultipleMachines && (
                            <MachineSeparator
                                machineName={machineGroup.machineName}
                                machineId={machineGroup.machineId}
                            />
                        )}
                        {machineGroup.projects.map((projectGroup, projectIndex) => {
                            const firstSession = projectGroup.sessions[0];
                            if (!firstSession) return null;
                            const expanded = !collapsedProjects.has(projectGroup.key);
                            const current = projectGroup.key === selectedProjectKey;
                            const selectedSession = selectedSessionId
                                ? projectGroup.sessions.find((candidate) => candidate.id === selectedSessionId)
                                : null;
                            const activitySession = selectedSession ?? projectGroup.sessions.find((candidate) => (
                                candidate.state === 'permission_required'
                                || candidate.state === 'running'
                                || candidate.hasUnread
                            ));
                            const activity = activitySession
                                ? {
                                    color: activitySession.hasUnread && activitySession.state === 'idle'
                                        ? theme.colors.accent
                                        : STATUS_CONFIG[activitySession.state].dotColor,
                                    isPulsing: STATUS_CONFIG[activitySession.state].isPulsing,
                                    label: `${getSessionStateLabel(activitySession.state)}${activitySession.isConnected ? '' : ` · ${t('status.disconnected')}`}`,
                                    textColor: STATUS_CONFIG[activitySession.state].color,
                                }
                                : null;

                            return (
                                <View
                                    key={projectGroup.key}
                                    style={[
                                        styles.projectGroupWrapper,
                                        {
                                            zIndex: ((machineGroups.length - machineIndex) * 1000)
                                                + (machineGroup.projects.length - projectIndex),
                                        },
                                    ]}
                                >
                                    <ProjectSectionHeader
                                        activity={activity}
                                        current={current}
                                        session={firstSession}
                                        displayPath={projectGroup.displayPath}
                                        expanded={expanded}
                                        machineId={machineGroup.machineId}
                                        path={projectGroup.path}
                                        onCreateSession={() => router.navigate('/new')}
                                        onToggle={() => toggleProject(projectGroup.key)}
                                        testID={`sidebar-project-toggle-${projectGroup.key}`}
                                    />
                                    {expanded ? (
                                        <View style={styles.projectSessions} testID={`sidebar-project-sessions-${projectGroup.key}`}>
                                            {projectGroup.sessions.map((session, index) => (
                                                <CompactSessionRow
                                                    key={session.id}
                                                    session={session}
                                                    selected={selectedSessionId === session.id}
                                                    bulkSelected={selectedIds?.has(session.id) ?? false}
                                                    selectionMode={selectionMode}
                                                    showBorder={index < projectGroup.sessions.length - 1}
                                                    onStartSelection={onStartSelection}
                                                    onToggleSelection={onToggleSelection}
                                                />
                                            ))}
                                        </View>
                                    ) : null}
                                </View>
                            );
                        })}
                    </React.Fragment>
                );
            }) : timeGroups.map((timeGroup) => (
                <View key={timeGroup.key} style={styles.timeGroup} testID={`session-time-group-${timeGroup.dayOffset}`}>
                    <Text style={styles.timeGroupLabel}>{getTimeGroupLabel(timeGroup.dayOffset)}</Text>
                    {timeGroup.sessions.map((session) => (
                        <CompactSessionRow
                            key={session.id}
                            session={session}
                            selected={selectedSessionId === session.id}
                            bulkSelected={selectedIds?.has(session.id) ?? false}
                            selectionMode={selectionMode}
                            showLocation
                            onStartSelection={onStartSelection}
                            onToggleSelection={onToggleSelection}
                        />
                    ))}
                </View>
            ))}
        </View>
    );
}

// Compact Codex-style session row. Runtime status stays visible while actions
// and richer metadata remain available through hover disclosure.
export const CompactSessionRow = React.memo(({ session, selected, bulkSelected, selectionMode, showBorder, showLocation = false, onStartSelection, onToggleSelection }: {
    session: SessionRowData;
    selected?: boolean;
    bulkSelected?: boolean;
    selectionMode?: boolean;
    showBorder?: boolean;
    showLocation?: boolean;
    onStartSelection?: (sessionId: string) => void;
    onToggleSelection?: (sessionId: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const router = useRouter();
    const organization = useLocalSetting('sidebarOrganization');
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
                testID={`session-row-${session.id}`}
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
                                numberOfLines={1}
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
    layoutHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        marginBottom: 8,
        minHeight: 26,
        paddingLeft: 16,
        paddingRight: 10,
        position: 'relative',
        zIndex: 120,
    },
    layoutTitle: {
        color: theme.colors.groupped.sectionTitle,
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    layoutToggleWrapper: {
        position: 'relative',
        zIndex: 120,
    },
    layoutToggle: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceSelected,
        borderRadius: 15,
        height: 30,
        justifyContent: 'center',
        width: 30,
    },
    layoutToggleHovered: {
        backgroundColor: theme.colors.surfacePressed,
    },
    layoutTogglePressed: {
        opacity: 0.72,
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
