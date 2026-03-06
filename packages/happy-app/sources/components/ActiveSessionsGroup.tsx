import React from 'react';
import { View, Pressable, Platform, LayoutAnimation } from 'react-native';
import { Text } from '@/components/StyledText';
import { Session, Machine } from '@/sync/storageTypes';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { useAllMachines } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { sessionKill, sessionDeactivate, sessionDelete, sessionResume } from '@/sync/ops';
import { Modal } from '@/modal';
import { ProjectGitStatus } from './ProjectGitStatus';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useIsTablet } from '@/utils/responsive';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';

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
    sectionHeaderPath: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
    },
    sectionHeaderMachine: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        maxWidth: 150,
        textAlign: 'right',
    },
    sessionRow: {
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
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
        marginLeft: 10,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    sessionTitle: {
        fontSize: 13,
        fontWeight: '500',
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    avatarContainer: {
        position: 'relative',
        width: 24,
        height: 24,
    },
    newSessionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    newSessionButtonDisabled: {
        opacity: 0.5,
    },
    newSessionButtonContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    newSessionButtonIcon: {
        marginRight: 6,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    newSessionButtonText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    newSessionButtonTextDisabled: {
        color: theme.colors.textSecondary,
    },
    taskStatusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 4,
        height: 16,
        borderRadius: 4,
    },
    taskStatusText: {
        fontSize: 10,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    dotsButton: {
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        alignItems: 'center',
    },
    actionsPanel: {
        flexDirection: 'row',
        paddingHorizontal: 8,
        paddingBottom: 8,
        paddingTop: 4,
        gap: 6,
    },
    actionButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHighest,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonText: {
        fontSize: 11,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    actionButtonDestructive: {
        color: theme.colors.status.error,
    },
}));

interface ActiveSessionsGroupProps {
    sessions: Session[];
    selectedSessionId?: string;
}


export function ActiveSessionsGroup({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const machines = useAllMachines();
    const [expandedSessionId, setExpandedSessionId] = React.useState<string | null>(null);
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
            const projectPath = session.metadata?.path || '';
            const machineId = session.metadata?.machineId || 'unknown';

            // Get machine info
            const machine = machineId !== 'unknown' ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== 'unknown' ? machineId : '<unknown>');

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

    // Sort project groups by display path
    const sortedProjectGroups = React.useMemo(() => {
        return Array.from(projectGroups.entries()).sort(([, groupA], [, groupB]) => {
            return groupA.displayPath.localeCompare(groupB.displayPath);
        });
    }, [projectGroups]);

    return (
        <View style={styles.container}>
            {sortedProjectGroups.map(([projectPath, projectGroup]) => {
                // Get the first machine name from this project's machines
                const firstMachine = Array.from(projectGroup.machines.values())[0];
                const machineName = projectGroup.machines.size === 1
                    ? firstMachine?.machineName
                    : `${projectGroup.machines.size} machines`;

                return (
                    <View key={projectPath}>
                        {/* Section header on grouped background */}
                        <View style={styles.sectionHeader}>
                            <View style={styles.sectionHeaderLeft}>
                                <Text style={styles.sectionHeaderPath}>
                                    {projectGroup.displayPath}
                                </Text>
                            </View>
                            {/* Show git status instead of machine name */}
                            {(() => {
                                // Get the first session from any machine in this project
                                const firstSession = Array.from(projectGroup.machines.values())[0]?.sessions[0];
                                return firstSession ? (
                                    <ProjectGitStatus sessionId={firstSession.id} />
                                ) : (
                                    <Text style={styles.sectionHeaderMachine} numberOfLines={1}>
                                        {machineName}
                                    </Text>
                                );
                            })()}
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
                                                expanded={expandedSessionId === session.id}
                                                onToggleExpand={(id) => {
                                                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                                                    setExpandedSessionId(prev => prev === id ? null : id);
                                                }}
                                            />
                                        ))}
                                    </View>
                                ))}
                        </View>
                    </View>
                );
            })}
        </View>
    );
}

// Action button for expanded session panel
const ActionButton = React.memo(({ icon, label, onPress, destructive }: {
    icon: string;
    label?: string;
    onPress: () => void;
    destructive?: boolean;
}) => {
    const { theme } = useUnistyles();
    const iconColor = destructive ? theme.colors.status.error : theme.colors.text;

    return (
        <Pressable
            style={stylesheet.actionButton}
            onPress={onPress}
            android_ripple={{ color: theme.colors.surfacePressed }}
        >
            <Ionicons name={icon as any} size={16} color={iconColor} />
            {label && <Text style={[stylesheet.actionButtonText, destructive && { color: theme.colors.status.error }]}>{label}</Text>}
        </Pressable>
    );
});

// Compact session row component with status line and inline actions
const CompactSessionRow = React.memo(({ session, selected, showBorder, expanded, onToggleExpand }: {
    session: Session;
    selected?: boolean;
    showBorder?: boolean;
    expanded?: boolean;
    onToggleExpand?: (id: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const navigateToSession = useNavigateToSession();
    const isTablet = useIsTablet();

    const [confirmingDelete, setConfirmingDelete] = React.useState(false);

    // Reset confirm state when collapsed
    React.useEffect(() => {
        if (!expanded) setConfirmingDelete(false);
    }, [expanded]);

    // Action: Archive (kill + deactivate)
    const [, performArchive] = useHappyAction(async () => {
        const killResult = await sessionKill(session.id);
        if (!killResult.success) {
            const deactivateResult = await sessionDeactivate(session.id);
            if (!deactivateResult.success) {
                throw new HappyError(deactivateResult.message || t('sessionInfo.failedToArchiveSession'), false);
            }
        }
    });

    // Action: Restart (kill + deactivate + resume)
    const [, performRestart] = useHappyAction(async () => {
        const claudeSessionId = session.metadata?.claudeSessionId;
        const directory = session.metadata?.path;
        if (!claudeSessionId || !directory) {
            throw new HappyError('Missing session metadata for restart', false);
        }
        await sessionKill(session.id);
        await sessionDeactivate(session.id);
        const resumeResult = await sessionResume(claudeSessionId, directory);
        if (!resumeResult.success) {
            throw new HappyError(resumeResult.message || 'Failed to resume session', false);
        }
    });

    // Action: Delete (kill + deactivate + delete)
    const [, performDelete] = useHappyAction(async () => {
        await sessionKill(session.id);
        await sessionDeactivate(session.id);
        const deleteResult = await sessionDelete(session.id);
        if (!deleteResult.success) {
            throw new HappyError(deleteResult.message || t('sessionInfo.failedToDeleteSession'), false);
        }
    });

    const avatarId = React.useMemo(() => {
        return getSessionAvatarId(session);
    }, [session]);

    return (
        <View style={showBorder && !expanded ? styles.sessionRowWithBorder : undefined}>
            <View style={[
                styles.sessionRow,
                selected && styles.sessionRowSelected
            ]}>
                <Pressable
                    style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
                    onPressIn={() => {
                        if (isTablet) navigateToSession(session.id);
                    }}
                    onPress={() => {
                        if (!isTablet) navigateToSession(session.id);
                    }}
                >
                    <View style={styles.avatarContainer}>
                        <Avatar id={avatarId} size={24} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} />
                    </View>
                    <View style={styles.sessionContent}>
                        <View style={styles.sessionTitleRow}>
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

                        <View style={styles.statusRow}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <View style={styles.statusDotContainer}>
                                    <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                                </View>
                                <Text style={[
                                    styles.statusText,
                                    { color: sessionStatus.statusColor }
                                ]}>
                                    {sessionStatus.statusText}
                                </Text>
                            </View>

                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, transform: [{ translateY: 1 }] }}>
                                {session.draft && (
                                    <View style={styles.taskStatusContainer}>
                                        <Ionicons name="create-outline" size={10} color={theme.colors.textSecondary} />
                                    </View>
                                )}
                                {Array.isArray(session.todos) && session.todos.length > 0 && (() => {
                                    const totalTasks = session.todos.length;
                                    const completedTasks = session.todos.filter(todo => todo.status === 'completed').length;
                                    if (completedTasks === totalTasks) return null;
                                    return (
                                        <View style={styles.taskStatusContainer}>
                                            <Ionicons name="bulb-outline" size={10} color={theme.colors.textSecondary} style={{ marginRight: 2 }} />
                                            <Text style={styles.taskStatusText}>{completedTasks}/{totalTasks}</Text>
                                        </View>
                                    );
                                })()}
                            </View>
                        </View>
                    </View>
                </Pressable>

                {/* Three dots button — outside main Pressable so it doesn't trigger navigation */}
                <Pressable
                    style={styles.dotsButton}
                    onPress={() => onToggleExpand?.(session.id)}
                    hitSlop={8}
                >
                    <Ionicons
                        name="ellipsis-horizontal"
                        size={16}
                        color={expanded ? theme.colors.text : theme.colors.textSecondary}
                    />
                </Pressable>
            </View>

            {/* Expanded action buttons */}
            {expanded && (
                <View style={[styles.actionsPanel, showBorder ? styles.sessionRowWithBorder : undefined]}>
                    {confirmingDelete ? (
                        <>
                            <ActionButton icon="close-outline" label={t('common.no')} onPress={() => setConfirmingDelete(false)} />
                            <ActionButton icon="checkmark-outline" label={t('common.yes')} onPress={() => { setConfirmingDelete(false); performDelete(); }} destructive />
                        </>
                    ) : (
                        <>
                            <ActionButton icon="refresh-outline" onPress={performRestart} />
                            <ActionButton icon="archive-outline" onPress={performArchive} />
                            <ActionButton icon="trash-outline" onPress={() => setConfirmingDelete(true)} destructive />
                        </>
                    )}
                </View>
            )}
        </View>
    );
});
