import React from 'react';
import { View, Pressable, Platform, ActivityIndicator } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Text } from '@/components/StyledText';
import { router, useRouter } from 'expo-router';
import { Session, Machine } from '@/sync/storageTypes';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { useAllMachines, useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineSpawnNewSession, sessionKill } from '@/sync/ops';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { storage } from '@/sync/storage';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { ProjectGitStatus } from './ProjectGitStatus';
import { getProjectRoot, getWorktreeName } from '@/utils/worktree';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { SessionActionsNativeMenu } from './SessionActionsNativeMenu';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { DraggableProjectGroup } from './DraggableProjectGroup';
import { useProjectGroupReorder } from '@/hooks/useProjectGroupReorder';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        backgroundColor: theme.colors.groupped.background,
        paddingTop: 8,
    },
    projectCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: 8,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    sectionHeader: {
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    sectionHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: 8,
    },
    sectionHeaderAvatar: {
        marginRight: 8,
    },
    sectionHeaderPath: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        flex: 1,
    },
    sessionRow: {
        height: 56,
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
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
    },
    newSessionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        height: 56,
        paddingHorizontal: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    newSessionButtonDisabled: {
        opacity: 0.4,
    },
    newSessionButtonContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    newSessionButtonIcon: {
        marginRight: 8,
        width: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    newSessionButtonText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    swipeAction: {
        width: 112,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: '#FFFFFF',
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    worktreeBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        paddingHorizontal: 6,
        paddingVertical: 2,
        marginLeft: 6,
        gap: 3,
    },
    worktreeBadgeText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
}));

interface ActiveSessionsGroupProps {
    sessions: Session[];
    selectedSessionId?: string;
}


export function ActiveSessionsGroupCompact({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const machines = useAllMachines();

    const machinesMap = React.useMemo(() => {
        const map: Record<string, Machine> = {};
        machines.forEach(machine => {
            map[machine.id] = machine;
        });
        return map;
    }, [machines]);

    // Group sessions by project, then associate with machine
    const projectGroups = React.useMemo(() => {
        const groups = new Map<string, {
            path: string;
            displayPath: string;
            machines: Map<string, {
                machine: Machine | null;
                machineName: string;
                sessions: Session[];
            }>;
        }>();

        sessions.forEach(session => {
            const rawPath = session.metadata?.path || '';
            const projectPath = getProjectRoot(rawPath);
            const unknownText = t('status.unknown');
            const machineId = session.metadata?.machineId || unknownText;

            // Get machine info
            const machine = machineId !== unknownText ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== unknownText ? machineId : `<${unknownText}>`);

            // Get or create project group
            let projectGroup = groups.get(projectPath);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(projectPath, session.metadata?.homeDir);
                projectGroup = {
                    path: projectPath,
                    displayPath,
                    machines: new Map()
                };
                groups.set(projectPath, projectGroup);
            }

            // Get or create machine group within project
            let machineGroup = projectGroup.machines.get(machineId);
            if (!machineGroup) {
                machineGroup = {
                    machine,
                    machineName,
                    sessions: []
                };
                projectGroup.machines.set(machineId, machineGroup);
            }

            // Add session to machine group
            machineGroup.sessions.push(session);
        });

        // Sort sessions within each machine group by creation time (newest first)
        groups.forEach(projectGroup => {
            projectGroup.machines.forEach(machineGroup => {
                machineGroup.sessions.sort((a, b) => b.createdAt - a.createdAt);
            });
        });

        return groups;
    }, [sessions, machinesMap]);

    // Sort project groups by custom order, then alphabetically
    const projectGroupOrder = useSetting('projectGroupOrder');
    const sortedProjectGroups = React.useMemo(() => {
        return Array.from(projectGroups.entries()).sort(([pathA, groupA], [pathB, groupB]) => {
            const indexA = projectGroupOrder.indexOf(pathA);
            const indexB = projectGroupOrder.indexOf(pathB);
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;
            return groupA.displayPath.localeCompare(groupB.displayPath);
        });
    }, [projectGroups, projectGroupOrder]);

    const { reorderGroups } = useProjectGroupReorder();
    const allPaths = React.useMemo(() => sortedProjectGroups.map(([path]) => path), [sortedProjectGroups]);
    const handleReorder = React.useCallback((fromIndex: number, toIndex: number) => {
        reorderGroups(fromIndex, toIndex, allPaths);
    }, [reorderGroups, allPaths]);

    return (
        <View style={styles.container}>
            {sortedProjectGroups.map(([projectPath, projectGroup], index) => {

                // Get the avatar ID from the first session
                const firstSession = Array.from(projectGroup.machines.values())[0]?.sessions[0];
                const avatarId = firstSession ? getSessionAvatarId(firstSession) : undefined;

                return (
                    <DraggableProjectGroup key={projectPath} projectPath={projectPath} index={index} onReorder={handleReorder}>
                        {/* Section header on grouped background */}
                        <View style={styles.sectionHeader}>
                            <View style={styles.sectionHeaderLeft}>
                                {Platform.OS === 'web' && (
                                    <Ionicons
                                        name="reorder-two"
                                        size={16}
                                        color={theme.colors.textSecondary}
                                        style={{ marginRight: 6, cursor: 'grab' } as any}
                                    />
                                )}
                                {avatarId && (
                                    <View style={styles.sectionHeaderAvatar}>
                                        <Avatar id={avatarId} size={24} flavor={firstSession?.metadata?.flavor} />
                                    </View>
                                )}
                                <Text style={styles.sectionHeaderPath}>
                                    {projectGroup.displayPath}
                                </Text>
                            </View>
                            {/* Show git status instead of machine name */}
                            {firstSession ? (
                                <ProjectGitStatus sessionId={firstSession.id} />
                            ) : null}
                        </View>

                        {/* Card with just the sessions */}
                        <View style={styles.projectCard}>
                            {/* Sessions grouped by machine within the card */}
                            {Array.from(projectGroup.machines.entries())
                                .sort(([, machineA], [, machineB]) => machineA.machineName.localeCompare(machineB.machineName))
                                .map(([machineId, machineGroup]) => (
                                    <View key={`${projectPath}-${machineId}`}>
                                        {machineGroup.sessions.map((session, index) => (
                                            <CompactSessionRow
                                                key={session.id}
                                                session={session}
                                                selected={selectedSessionId === session.id}
                                                showBorder={index < machineGroup.sessions.length - 1 ||
                                                    Array.from(projectGroup.machines.keys()).indexOf(machineId) < projectGroup.machines.size - 1}
                                                worktreeName={getWorktreeName(session.metadata?.path || '')}
                                            />
                                        ))}
                                    </View>
                                ))}
                        </View>
                    </DraggableProjectGroup>
                );
            })}
        </View>
    );
}

// Compact session row component with status line
const CompactSessionRow = React.memo(({ session, selected, showBorder, worktreeName }: { session: Session; selected?: boolean; showBorder?: boolean; worktreeName?: string | null }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const navigateToSession = useNavigateToSession();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const triggerRef = React.useRef<View | null>(null);
    const suppressPressUntilRef = React.useRef(0);
    const swipeEnabled = Platform.OS !== 'web';
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    const [archivingSession, performArchive] = useHappyAction(async () => {
        const result = await sessionKill(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
        }
    });

    const handleArchive = React.useCallback(() => {
        swipeableRef.current?.close();
        performArchive();
    }, [performArchive]);

    const openActionsFromTrigger = React.useCallback(() => {
        if (!triggerRef.current) {
            return;
        }

        suppressPressUntilRef.current = Date.now() + 750;
        triggerRef.current.measureInWindow((x, y, width, height) => {
            setActionsAnchor({
                type: 'rect',
                x,
                y,
                width,
                height,
            });
        });
    }, []);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        suppressPressUntilRef.current = Date.now() + 750;
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const handleKeyDown = React.useCallback((event: any) => {
        const key = event.nativeEvent?.key;
        const shiftKey = !!event.nativeEvent?.shiftKey;
        if (key === 'ContextMenu' || (shiftKey && key === 'F10')) {
            event.preventDefault?.();
            openActionsFromTrigger();
        }
    }, [openActionsFromTrigger]);

    const handlePress = React.useCallback(() => {
        if (Date.now() < suppressPressUntilRef.current) {
            return;
        }
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleWebLongPress = React.useCallback(() => {
        suppressPressUntilRef.current = Date.now() + 750;
        openActionsFromTrigger();
    }, [openActionsFromTrigger]);

    const webMenuProps = Platform.OS === 'web' ? {
        'aria-expanded': !!actionsAnchor,
        'aria-haspopup': 'menu',
        onContextMenu: handleContextMenu,
        onKeyDown: handleKeyDown,
    } as any : {};

    const itemContent = (
        <Pressable
            style={[
                styles.sessionRow,
                showBorder && styles.sessionRowWithBorder,
                selected && styles.sessionRowSelected
            ]}
            onLongPress={Platform.OS === 'web' ? handleWebLongPress : undefined}
            onPress={handlePress}
            {...webMenuProps}
        >
            <View style={styles.sessionContent}>
                {/* Title line with status */}
                <View style={styles.sessionTitleRow}>
                    {/* Status dot or draft icon on the left */}
                    {(() => {
                        // Show draft icon when online with draft
                        if (sessionStatus.state === 'waiting' && session.draft) {
                            return (
                                <Ionicons
                                    name="create-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                    style={{ marginRight: 8 }}
                                />
                            );
                        }
                        
                        // Show status dot only for permission_required/thinking states
                        if (sessionStatus.state === 'permission_required' || sessionStatus.state === 'thinking') {
                            return (
                                <View style={[styles.statusDotContainer, { marginRight: 8 }]}>
                                    <StatusDot 
                                        color={sessionStatus.statusDotColor} 
                                        isPulsing={sessionStatus.isPulsing} 
                                    />
                                </View>
                            );
                        }
                        
                        // Show grey dot for online without draft
                        if (sessionStatus.state === 'waiting') {
                            return (
                                <View style={[styles.statusDotContainer, { marginRight: 8 }]}>
                                    <StatusDot 
                                        color={theme.colors.textSecondary} 
                                        isPulsing={false} 
                                    />
                                </View>
                            );
                        }
                        
                        return null;
                    })()}
                    
                    <Text
                        style={[
                            styles.sessionTitle,
                            sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                        ]}
                        numberOfLines={2}
                    >
                        {sessionName}
                    </Text>
                    {worktreeName ? (
                        <View style={styles.worktreeBadge}>
                            <Octicons name="git-branch" size={10} color={theme.colors.textSecondary} />
                            <Text style={styles.worktreeBadgeText} numberOfLines={1}>
                                {worktreeName}
                            </Text>
                        </View>
                    ) : null}
                </View>
            </View>
        </Pressable>
    );

    const wrappedItemContent = (
        <SessionActionsNativeMenu session={session}>
            {itemContent}
        </SessionActionsNativeMenu>
    );

    if (!swipeEnabled) {
        return (
            <View collapsable={false} ref={triggerRef}>
                {wrappedItemContent}
                <SessionActionsPopover
                    anchor={actionsAnchor}
                    onClose={() => setActionsAnchor(null)}
                    session={session}
                    visible={!!actionsAnchor}
                />
            </View>
        );
    }

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeAction}
            onPress={handleArchive}
            disabled={archivingSession}
        >
            <Ionicons name="archive-outline" size={20} color="#FFFFFF" />
            <Text style={styles.swipeActionText} numberOfLines={2}>
                {t('sessionInfo.archiveSession')}
            </Text>
        </Pressable>
    );

    return (
        <View collapsable={false} ref={triggerRef}>
            <Swipeable
                ref={swipeableRef}
                renderRightActions={renderRightActions}
                overshootRight={false}
                enabled={!archivingSession}
            >
                {wrappedItemContent}
            </Swipeable>
        </View>
    );
});
