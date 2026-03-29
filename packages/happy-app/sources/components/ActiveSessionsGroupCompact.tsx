import React from 'react';
import { View, Pressable, Platform, Image as RNImage } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';
import { Swipeable } from 'react-native-gesture-handler';
import { Text } from '@/components/StyledText';
import { Session, Machine } from '@/sync/storageTypes';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { useAllMachines, useSessionProjectGitStatus, useSessionGitStatus, useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { sessionKill } from '@/sync/ops';
import { isWorktreePath, getRepoPath, getWorktreeName } from '@/utils/worktree';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useRouter } from 'expo-router';

const flavorIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
    openclaw: require('@/assets/images/icon-openclaw.png'),
};

interface ActiveSessionsGroupProps {
    sessions: Session[];
    selectedSessionId?: string;
}

/**
 * Hook to get git display info for a section header:
 * branch name, line changes, and worktree status.
 */
function useSectionGitInfo(sessionId: string) {
    const projectGitStatus = useSessionProjectGitStatus(sessionId);
    const sessionGitStatus = useSessionGitStatus(sessionId);
    const gitStatus = projectGitStatus || sessionGitStatus;

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
const SectionHeader = React.memo(({ session, displayPath }: { session: Session; displayPath: string }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const draft = useNewSessionDraft();

    const sessionPath = session.metadata?.path || '';
    const isWorktree = isWorktreePath(sessionPath);
    const repoPath = isWorktree ? getRepoPath(sessionPath) : sessionPath;
    const repoDisplayPath = isWorktree
        ? formatPathRelativeToHome(repoPath, session.metadata?.homeDir)
        : displayPath;
    const worktreeName = isWorktree ? getWorktreeName(sessionPath) : null;

    const gitInfo = useSectionGitInfo(session.id);
    const branchName = worktreeName || gitInfo.branch;
    const hasBranch = !!branchName;

    const avatarId = React.useMemo(() => getSessionAvatarId(session), [session]);

    const handleAdd = React.useCallback(() => {
        const machineId = session.metadata?.machineId;
        if (machineId) {
            draft.setMachineId(machineId);
        }
        // setMachineId resets path, so set path after
        const pathToSet = formatPathRelativeToHome(repoPath, session.metadata?.homeDir);
        draft.setPath(pathToSet);
        draft.setSessionType(isWorktree ? 'worktree' : 'simple');
        router.navigate('/new');
    }, [session.metadata, repoPath, isWorktree, draft, router]);

    return (
        <View style={hasBranch ? styles.sectionHeader : styles.sectionHeaderSingleLine}>
            {/* Avatar — vertically centered */}
            <View style={styles.sectionHeaderAvatar}>
                <Avatar id={avatarId} size={24} flavor={null} />
            </View>

            {/* Path + branch */}
            <View style={styles.sectionHeaderContent}>
                <Text style={styles.sectionHeaderPath} numberOfLines={1}>
                    {repoDisplayPath}
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

            {/* + button — vertically centered, large hit area */}
            <Pressable
                onPress={handleAdd}
                hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                style={styles.addButton}
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

export function ActiveSessionsGroupCompact({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const machines = useAllMachines();

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
                sessions: Session[];
            }>;
        }>();

        sessions.forEach(session => {
            const machineId = session.metadata?.machineId || unknownText;
            const machine = machineId !== unknownText ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== unknownText ? machineId : `<${unknownText}>`);

            let machineGroup = byMachine.get(machineId);
            if (!machineGroup) {
                machineGroup = { machineId, machineName, projects: new Map() };
                byMachine.set(machineId, machineGroup);
            }

            const projectPath = session.metadata?.path || '';
            let projectGroup = machineGroup.projects.get(projectPath);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(projectPath, session.metadata?.homeDir);
                projectGroup = { displayPath, sessions: [] };
                machineGroup.projects.set(projectPath, projectGroup);
            }

            projectGroup.sessions.push(session);
        });

        // Sort sessions within each project group
        byMachine.forEach(mg => {
            mg.projects.forEach(pg => {
                pg.sessions.sort((a, b) => b.createdAt - a.createdAt);
            });
        });

        const sorted = Array.from(byMachine.values()).sort((a, b) =>
            a.machineName.localeCompare(b.machineName)
        );

        return { machineGroups: sorted, hasMultipleMachines: byMachine.size > 1 };
    }, [sessions, machinesMap]);

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
                                                showBorder={index < projectGroup.sessions.length - 1}
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

// Small agent icon with pulsing animation matching StatusDot behavior
const PulsingAgentIcon = React.memo(({ flavorIcon, isPulsing, tintColor, opacity: baseOpacity }: {
    flavorIcon: any;
    isPulsing: boolean;
    tintColor?: string;
    opacity: number;
}) => {
    const opacity = useSharedValue(baseOpacity);

    React.useEffect(() => {
        if (isPulsing) {
            opacity.value = withRepeat(
                withTiming(0.3, { duration: 1000 }),
                -1,
                true
            );
        } else {
            opacity.value = withTiming(baseOpacity, { duration: 200 });
        }
    }, [isPulsing, baseOpacity]);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
    }));

    return (
        <Animated.View style={[{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center', marginRight: 8 }, animatedStyle]}>
            <RNImage
                source={flavorIcon}
                style={{ width: 8, height: 8 }}
                resizeMode="contain"
                tintColor={tintColor}
            />
        </Animated.View>
    );
});

// Compact session row — agent icon replaces dot when showFlavorIcons is on
const CompactSessionRow = React.memo(({ session, selected, showBorder }: { session: Session; selected?: boolean; showBorder?: boolean }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const navigateToSession = useNavigateToSession();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const swipeEnabled = Platform.OS !== 'web';
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const showFlavorIcons = useSetting('showFlavorIcons');

    const flavor = session.metadata?.flavor || 'claude';
    const flavorIcon = flavorIcons[flavor as keyof typeof flavorIcons] || flavorIcons.claude;

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

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const webMenuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {};

    const itemContent = (
        <Pressable
            style={[
                styles.sessionRow,
                showBorder && styles.sessionRowWithBorder,
                selected && styles.sessionRowSelected
            ]}
            onPress={handlePress}
            {...webMenuProps}
        >
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    {/* Left indicator: agent icon OR status dot/draft */}
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

                        // When showFlavorIcons is on, show agent icon instead of dot
                        if (showFlavorIcons) {
                            return (
                                <PulsingAgentIcon
                                    flavorIcon={flavorIcon}
                                    isPulsing={sessionStatus.state === 'permission_required' || sessionStatus.state === 'thinking'}
                                    tintColor={
                                        (sessionStatus.state === 'permission_required' || sessionStatus.state === 'thinking')
                                            ? sessionStatus.statusDotColor
                                            : flavor === 'codex' ? theme.colors.text : undefined
                                    }
                                    opacity={sessionStatus.state === 'waiting' ? 0.5 : (sessionStatus.isConnected ? 1 : 0.3)}
                                />
                            );
                        }

                        // Show status dot for permission_required/thinking states
                        if (sessionStatus.state === 'permission_required' || sessionStatus.state === 'thinking') {
                            return (
                                <View style={[styles.statusDotContainer, { marginRight: 8 }]}>
                                    <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                                </View>
                            );
                        }

                        // Show grey dot for online without draft
                        if (sessionStatus.state === 'waiting') {
                            return (
                                <View style={[styles.statusDotContainer, { marginRight: 8 }]}>
                                    <StatusDot color={theme.colors.textSecondary} isPulsing={false} />
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
                </View>
            </View>
        </Pressable>
    );

    if (!swipeEnabled) {
        return (
            <>
                {itemContent}
                <SessionActionsPopover
                    anchor={actionsAnchor}
                    onClose={() => setActionsAnchor(null)}
                    session={session}
                    visible={!!actionsAnchor}
                />
            </>
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
        <Swipeable
            ref={swipeableRef}
            renderRightActions={renderRightActions}
            overshootRight={false}
            enabled={!archivingSession}
        >
            {itemContent}
        </Swipeable>
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
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    // Session row styles
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
    agentIconContainer: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
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
}));
