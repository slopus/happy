import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { Machine } from '@/sync/storageTypes';
import { SessionRowData } from '@/sync/storage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { type SessionState, formatPathRelativeToHome, vibingMessages, formatLastSeen } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { useAllMachines, useSessionGitStatus } from '@/sync/storage';
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
import { sortSessionsForList } from '@/utils/sessionPinning';

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean; isConnected: boolean }> = {
    disconnected: { color: '#999', dotColor: '#999', isPulsing: false, isConnected: false },
    thinking: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true, isConnected: true },
    waiting: { color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true, isConnected: true },
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
const SectionHeader = React.memo(({ session, displayPath }: { session: SessionRowData; displayPath: string }) => {
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
            style={hasBranch ? styles.sectionHeader : styles.sectionHeaderSingleLine}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
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

            {/* + button — vertically centered, large hit area; desktop: hover-only */}
            <Pressable
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

    const machinesMap = React.useMemo(() => {
        const map: Record<string, Machine> = {};
        machines.forEach(machine => {
            map[machine.id] = machine;
        });
        return map;
    }, [machines]);

    // Group sessions by machine, then by project within each machine
    const { machineGroups, hasMultipleMachines } = React.useMemo(() => {
        const unknownText = t('status.unknown');
        const byMachine = new Map<string, {
            machineId: string;
            machineName: string;
            projects: Map<string, {
                displayPath: string;
                sessions: SessionRowData[];
            }>;
        }>();

        sessions.forEach(session => {
            const machineId = session.machineId || unknownText;
            const machine = machineId !== unknownText ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== unknownText ? machineId : `<${unknownText}>`);

            let machineGroup = byMachine.get(machineId);
            if (!machineGroup) {
                machineGroup = { machineId, machineName, projects: new Map() };
                byMachine.set(machineId, machineGroup);
            }

            const projectPath = session.path || '';
            let projectGroup = machineGroup.projects.get(projectPath);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(projectPath, session.homeDir ?? undefined);
                projectGroup = { displayPath, sessions: [] };
                machineGroup.projects.set(projectPath, projectGroup);
            }

            projectGroup.sessions.push(session);
        });

        // Sort sessions within each project group
        byMachine.forEach(mg => {
            mg.projects.forEach(pg => {
                pg.sessions = sortSessionsForList(pg.sessions, sessionManagement.preferences.pinnedOrder);
            });
        });

        const sorted = Array.from(byMachine.values()).sort((a, b) =>
            a.machineName.localeCompare(b.machineName)
        );

        return { machineGroups: sorted, hasMultipleMachines: byMachine.size > 1 };
    }, [sessions, machinesMap, sessionManagement.preferences.pinnedOrder]);

    return (
        <View style={styles.container}>
            {machineGroups.map(machineGroup => {
                const sortedProjects = Array.from(machineGroup.projects.entries()).sort(
                    ([, a], [, b]) => a.displayPath.localeCompare(b.displayPath)
                );

                return (
                    <React.Fragment key={machineGroup.machineId}>
                        {hasMultipleMachines && (
                            <MachineSeparator
                                machineName={machineGroup.machineName}
                                machineId={machineGroup.machineId}
                            />
                        )}
                        {sortedProjects.map(([projectPath, projectGroup]) => {
                            const firstSession = projectGroup.sessions[0];
                            if (!firstSession) return null;

                            return (
                                <View key={projectPath}>
                                    <SectionHeader
                                        session={firstSession}
                                        displayPath={projectGroup.displayPath}
                                    />
                                    <View style={styles.projectCard}>
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
    // Override to solid blue when session has unread results
    const status = session.hasUnread
        ? { ...baseStatus, color: theme.colors.accent, dotColor: theme.colors.accent, isPulsing: false, isConnected: baseStatus.isConnected }
        : baseStatus;
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const disclosure = useSessionRowDisclosure(session.name);
    const presentation = useSessionRowPresentation(session);

    const handlePress = React.useCallback(() => {
        if (selectionMode) {
            onToggleSelection?.(session.id);
            return;
        }
        navigateToSession(session.id);
    }, [navigateToSession, onToggleSelection, selectionMode, session.id]);

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
        } else if (session.state === 'waiting' && session.hasDraft) {
            indicator = (
                <Ionicons
                    name="create-outline"
                    size={14}
                    color={theme.colors.textSecondary}
                />
            );
        } else if (session.state === 'permission_required' || session.state === 'thinking') {
            indicator = <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />;
        } else if (session.state === 'waiting') {
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
                accessibilityLabel={session.name}
                accessibilityRole="button"
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
                                status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                            ]}
                            numberOfLines={1}
                            testID="session-row-title"
                            {...titleHint}
                        >
                            {session.name}
                        </Text>
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
