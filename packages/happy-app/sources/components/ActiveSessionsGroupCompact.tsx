import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { SessionRowData } from '@/sync/storage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { type SessionState, formatPathRelativeToHome, getSessionStateLabel } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { storage, useAllMachines, useSessionGitStatus } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor } from './SessionActionsPopover';
import {
    SessionRowActions,
    SessionRowDetails,
    SessionRowLocation,
    useSessionRowDisclosure,
    useSessionRowPresentation,
} from './SessionRowChrome';
import { hapticsLight } from './haptics';
import { isWorktreePath, getRepoPath, getWorktreeName } from '@/utils/worktree';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useRouter } from 'expo-router';
import { useSessionManagementPreferences } from '@/hooks/useSessionManagementPreferences';
import { buildSessionNavigationGroups } from '@/utils/sessionNavigationGroups';
import { sync } from '@/sync/sync';
import { loadPendingPermissionMessageId } from '@/utils/pendingPermission';

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

/**
 * Hook to get git display info for a section header:
 * branch name, line changes, and worktree status.
 */
function useSectionGitInfo(sessionId: string) {
    const gitStatus = useSessionGitStatus(sessionId);

    return React.useMemo(() => {
        if (!gitStatus || gitStatus.lastUpdatedAt === 0) {
            return { branch: null, linesAdded: 0, linesRemoved: 0, hasChanges: false };
        }
        return {
            branch: gitStatus.branch,
            linesAdded: gitStatus.unstagedLinesAdded,
            linesRemoved: gitStatus.unstagedLinesRemoved,
            hasChanges: gitStatus.unstagedLinesAdded > 0 || gitStatus.unstagedLinesRemoved > 0,
        };
    }, [gitStatus]);
}

// Section header: avatar | path + branch + tree icon + line changes | + button
const SectionHeader = React.memo(({
    current,
    displayPath,
    expanded,
    onToggle,
    session,
    testID,
}: {
    current: boolean;
    displayPath: string;
    expanded: boolean;
    onToggle: () => void;
    session: SessionRowData;
    testID: string;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const draft = useNewSessionDraft();

    const sessionPath = session.path || '';
    const isWorktree = isWorktreePath(sessionPath);
    const repoPath = isWorktree ? getRepoPath(sessionPath) : sessionPath;
    const repoDisplayPath = isWorktree
        ? formatPathRelativeToHome(repoPath, session.homeDir ?? undefined)
        : displayPath;
    const repoFolderName = repoPath.split(/[/\\]/).filter(Boolean).pop() || repoDisplayPath;
    const worktreeName = isWorktree ? getWorktreeName(sessionPath) : null;

    const gitInfo = useSectionGitInfo(session.id);
    const branchName = worktreeName || gitInfo.branch;
    const hasBranch = !!branchName;

    const handleAdd = React.useCallback(() => {
        const machineId = session.machineId;
        if (machineId) {
            draft.setMachineId(machineId);
        }
        const pathToSet = formatPathRelativeToHome(repoPath, session.homeDir ?? undefined);
        draft.setPath(pathToSet);
        draft.setSessionType(isWorktree ? 'worktree' : 'simple');
        draft.setWorktreeKey(isWorktree ? sessionPath : null);
        router.navigate('/new');
    }, [session.machineId, session.homeDir, repoPath, isWorktree, sessionPath, draft, router]);

    const [isHovered, setIsHovered] = React.useState(false);

    return (
        <View
            style={[
                hasBranch ? styles.sectionHeader : styles.sectionHeaderSingleLine,
                current && styles.sectionHeaderCurrent,
            ]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            <Pressable
                accessibilityLabel={repoFolderName}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
                onPress={onToggle}
                style={styles.sectionHeaderPressTarget}
                testID={testID}
            >
                <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={14}
                    color={current ? theme.colors.textLink : theme.colors.textSecondary}
                    style={styles.sectionChevron}
                />

                {/* Avatar — vertically centered */}
                <View style={styles.sectionHeaderAvatar}>
                    <Avatar id={session.avatarId} size={24} flavor={null} />
                </View>

                {/* Path + branch */}
                <View style={styles.sectionHeaderContent}>
                    <Text style={styles.sectionHeaderPath} numberOfLines={1}>
                        {repoFolderName}
                    </Text>
                    {hasBranch && (
                        <View style={styles.branchRow}>
                            <Text style={styles.branchText} numberOfLines={1}>
                                {branchName}
                            </Text>
                            {isWorktree && (
                                <MaterialCommunityIcons
                                    name="tree"
                                    size={11}
                                    color={theme.colors.textSecondary}
                                    style={styles.worktreeIcon}
                                />
                            )}
                            {gitInfo.linesAdded > 0 && (
                                <Text style={styles.addedText}>+{gitInfo.linesAdded}</Text>
                            )}
                            {gitInfo.linesRemoved > 0 && (
                                <Text style={styles.removedText}>-{gitInfo.linesRemoved}</Text>
                            )}
                        </View>
                    )}
                </View>
                {current ? (
                    <Ionicons
                        name="ellipse"
                        size={7}
                        color={theme.colors.textLink}
                        style={styles.currentProjectIndicator}
                    />
                ) : null}
            </Pressable>

            {/* + button — vertically centered, large hit area; desktop: hover-only */}
            <Pressable
                accessibilityLabel={t('sidebar.newSession')}
                accessibilityRole="button"
                onPress={handleAdd}
                hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                style={[styles.addButton, { opacity: Platform.OS !== 'web' || isHovered ? 1 : 0 }]}
            >
                <Ionicons name="add-outline" size={14} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

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
            <Ionicons name="desktop-outline" size={11} color={theme.colors.textSecondary} style={{ marginHorizontal: 6 }} />
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
    const machines = useAllMachines();
    const sessionIds = React.useMemo(() => sessions.map(session => session.id), [sessions]);
    const sessionManagement = useSessionManagementPreferences(sessionIds, { prune: false });

    // Machines are an explicit grouping dimension; projects are the compact,
    // collapsible units users scan to find recent sessions.
    const machineGroups = React.useMemo(() => buildSessionNavigationGroups({
        machines,
        pinnedOrder: sessionManagement.preferences.pinnedOrder,
        sessions,
        unknownLabel: t('status.unknown'),
    }), [machines, sessionManagement.preferences.pinnedOrder, sessions]);
    const hasMultipleMachines = machineGroups.length > 1;
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

    return (
        <View style={styles.container}>
            {machineGroups.map(machineGroup => {
                return (
                    <React.Fragment key={machineGroup.machineId}>
                        {hasMultipleMachines && (
                            <MachineSeparator
                                machineName={machineGroup.machineName}
                                machineId={machineGroup.machineId}
                            />
                        )}
                        {machineGroup.projects.map((projectGroup) => {
                            const firstSession = projectGroup.sessions[0];
                            if (!firstSession) return null;
                            const expanded = !collapsedProjects.has(projectGroup.key);
                            const current = projectGroup.key === selectedProjectKey;

                            return (
                                <View key={projectGroup.key}>
                                    <SectionHeader
                                        current={current}
                                        session={firstSession}
                                        displayPath={projectGroup.displayPath}
                                        expanded={expanded}
                                        onToggle={() => toggleProject(projectGroup.key)}
                                        testID={`sidebar-project-toggle-${projectGroup.key}`}
                                    />
                                    {expanded ? (
                                        <View style={styles.projectCard} testID={`sidebar-project-sessions-${projectGroup.key}`}>
                                            {projectGroup.sessions.map((session, index) => (
                                                <CompactSessionRow
                                                    key={session.id}
                                                    session={session}
                                                    selected={selectedSessionId === session.id}
                                                    bulkSelected={selectedIds?.has(session.id) ?? false}
                                                    selectionMode={selectionMode}
                                                    showBorder={index < projectGroup.sessions.length - 1}
                                                    pinned={sessionManagement.isPinned(session.id)}
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
            })}
        </View>
    );
}

// Compact session row with status dot indicator
const CompactSessionRow = React.memo(({ session, selected, bulkSelected, selectionMode, showBorder, pinned, onStartSelection, onToggleSelection }: {
    session: SessionRowData;
    selected?: boolean;
    bulkSelected?: boolean;
    selectionMode?: boolean;
    showBorder?: boolean;
    pinned?: boolean;
    onStartSelection?: (sessionId: string) => void;
    onToggleSelection?: (sessionId: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const baseStatus = STATUS_CONFIG[session.state];
    // Runtime outcomes keep their own marker priority, while an otherwise-idle
    // unread session retains the existing blue unread marker.
    const status = session.hasUnread && session.state === 'idle'
        ? { ...baseStatus, dotColor: theme.colors.accent, isPulsing: false }
        : baseStatus;
    const navigateToSession = useNavigateToSession();
    const router = useRouter();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const disclosure = useSessionRowDisclosure(session.name);
    const presentation = useSessionRowPresentation(session);

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
                        <Ionicons
                            name="checkmark"
                            size={14}
                            color="#FFFFFF"
                        />
                    ) : null}
                </View>
            );
        } else if (session.state === 'permission_required' || session.state === 'running') {
            indicator = <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />;
        } else if (session.state === 'failed' || session.state === 'completed') {
            indicator = <StatusDot color={status.dotColor} isPulsing={false} />;
        } else if (pinned) {
            indicator = (
                <Ionicons
                    name="pin"
                    size={14}
                    color={theme.colors.textSecondary}
                />
            );
        } else if (session.hasUnread) {
            indicator = <StatusDot color={status.dotColor} isPulsing={false} />;
        } else if (session.state === 'idle' && session.hasDraft) {
            indicator = (
                <Ionicons
                    name="create-outline"
                    size={14}
                    color={theme.colors.textSecondary}
                />
            );
        } else if (session.state === 'idle') {
            indicator = <StatusDot color={theme.colors.textSecondary} isPulsing={false} />;
        }

        return (
            <View style={styles.leadingIndicatorSlot}>
                {indicator}
            </View>
        );
    };

    const titleHint = Platform.OS === 'web' && disclosure.titleOverflowing
        ? { title: session.name } as any
        : {};

    const itemContent = (
        <View
            style={[
                styles.sessionRow,
                showBorder && styles.sessionRowWithBorder,
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
                <View style={styles.sessionContent}>
                    <View style={styles.sessionTitleRow}>
                        {renderLeadingIndicator()}

                        <Text
                            style={[
                                styles.sessionTitle,
                                session.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                            ]}
                            numberOfLines={1}
                            testID="session-row-title"
                            {...titleHint}
                        >
                            {session.name}
                        </Text>
                        <View
                            accessibilityLabel={`${getSessionStateLabel(session.state)}${session.isConnected ? '' : `, ${t('status.disconnected')}`}`}
                            style={styles.sessionStatusBadge}
                            testID={`session-row-status-${session.id}`}
                        >
                            <Text style={[styles.sessionStatusText, { color: status.color }]} numberOfLines={1}>
                                {getSessionStateLabel(session.state)}
                            </Text>
                            {!session.isConnected ? (
                                <Ionicons name="cloud-offline-outline" size={12} color={theme.colors.textSecondary} />
                            ) : null}
                        </View>
                    </View>
                    <SessionRowLocation presentation={presentation} />
                </View>
            </Pressable>
            {!selectionMode ? (
                <SessionRowActions
                    contextAnchor={actionsAnchor}
                    onContextAnchorChange={setActionsAnchor}
                    onStartSelection={onStartSelection ? () => onStartSelection(session.id) : undefined}
                    sessionId={session.id}
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
            <SessionRowDetails presentation={presentation} visible={!selectionMode && disclosure.visible} />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.groupped.background,
        paddingTop: 8,
    },
    // Section header styles
    sectionHeader: {
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderSingleLine: {
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderCurrent: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sectionHeaderPressTarget: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        minHeight: 40,
        minWidth: 0,
    },
    sectionChevron: {
        marginRight: 4,
    },
    sectionHeaderAvatar: {
        marginRight: 8,
    },
    sectionHeaderContent: {
        flex: 1,
        justifyContent: 'center',
        minWidth: 0,
    },
    sectionHeaderPath: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        flexShrink: 1,
    },
    branchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 1,
    },
    branchText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        flexShrink: 1,
    },
    worktreeIcon: {
        marginLeft: 4,
    },
    addedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitAddedText,
        marginLeft: 6,
    },
    removedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitRemovedText,
        marginLeft: 3,
    },
    addButton: {
        marginLeft: 4,
        padding: 8,
    },
    currentProjectIndicator: {
        marginLeft: 6,
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
    // Project card styles
    projectCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: 8,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        overflow: 'visible',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    // Session row styles
    sessionRow: {
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.surface,
    },
    sessionRowWithBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    sessionRowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        justifyContent: 'center',
    },
    sessionPressTarget: {
        flex: 1,
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
        flexDirection: 'row',
        alignItems: 'center',
    },
    sessionTitle: {
        fontSize: 15,
        flex: 1,
        ...Typography.default('regular'),
    },
    sessionStatusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: 3,
        marginLeft: 8,
        maxWidth: 96,
    },
    sessionStatusText: {
        fontSize: 11,
        fontWeight: '600',
        ...Typography.default('semiBold'),
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
