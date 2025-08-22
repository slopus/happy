import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Session, Machine } from '@/sync/storageTypes';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { useAllMachines } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        backgroundColor: theme.colors.surface,
        paddingTop: 12,
    },
    projectCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: 12,
        overflow: 'hidden',
    },
    projectCardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    projectCardTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        flex: 1,
        marginRight: 8,
        ...Typography.default('semiBold'),
    },
    projectCardMachine: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    sessionRow: {
        height: 88,
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
        marginLeft: 16,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
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
        width: 48,
        height: 48,
    },
    draftIconContainer: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconOverlay: {
        color: theme.colors.textSecondary,
    },
}));

interface ActiveSessionsGroupProps {
    sessions: Session[];
    selectedSessionId?: string;
}


export function ActiveSessionsGroup({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
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
                    <View key={projectPath} style={styles.projectCard}>
                        {/* Card header with project path and machine name */}
                        <View style={styles.projectCardHeader}>
                            <Text style={styles.projectCardTitle} numberOfLines={1}>
                                {projectGroup.displayPath}
                            </Text>
                            {machineName && (
                                <Text style={styles.projectCardMachine} numberOfLines={1}>
                                    {machineName}
                                </Text>
                            )}
                        </View>

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
                                        />
                                    ))}
                                </View>
                            ))}
                    </View>
                );
            })}
        </View>
    );
}

// Compact session row component with status line
const CompactSessionRow = React.memo(({ session, selected, showBorder }: { session: Session; selected?: boolean; showBorder?: boolean }) => {
    const styles = stylesheet;
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const router = useRouter();

    const avatarId = React.useMemo(() => {
        return getSessionAvatarId(session);
    }, [session]);

    return (
        <Pressable
            style={[
                styles.sessionRow,
                showBorder && styles.sessionRowWithBorder,
                selected && styles.sessionRowSelected
            ]}
            onPress={() => {
                router.push(`/session/${session.id}`);
            }}
        >
            <View style={styles.avatarContainer}>
                <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} />
                {session.draft && (
                    <View style={styles.draftIconContainer}>
                        <Ionicons
                            name="create-outline"
                            size={12}
                            style={styles.draftIconOverlay}
                        />
                    </View>
                )}
            </View>
            <View style={styles.sessionContent}>
                {/* Title line */}
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                    ]} numberOfLines={2}>
                        {sessionName}
                    </Text>
                </View>

                {/* Status line with dot */}
                <View style={styles.statusRow}>
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
            </View>
        </Pressable>
    );
});