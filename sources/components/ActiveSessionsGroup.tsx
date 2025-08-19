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

interface ActiveSessionsGroupProps {
    sessions: Session[];
    selectedSessionId?: string;
}

interface MachineGroup {
    machine: Machine | null;
    machineName: string;
    projects: Map<string, {
        path: string;
        displayPath: string;
        sessions: Session[];
    }>;
}

export function ActiveSessionsGroup({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
    const machines = useAllMachines();
    const machinesMap = React.useMemo(() => {
        const map: Record<string, Machine> = {};
        machines.forEach(machine => {
            map[machine.id] = machine;
        });
        return map;
    }, [machines]);

    // Group sessions by machine and project
    const machineGroups = React.useMemo(() => {
        const groups = new Map<string, MachineGroup>();

        sessions.forEach(session => {
            const machineId = session.metadata?.machineId || 'unknown';
            const projectPath = session.metadata?.path || '';
            
            // Get machine info
            const machine = machineId !== 'unknown' ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName || 
                              machine?.metadata?.host || 
                              (machineId !== 'unknown' ? machineId : '<unknown>');

            // Get or create machine group
            let machineGroup = groups.get(machineId);
            if (!machineGroup) {
                machineGroup = {
                    machine,
                    machineName,
                    projects: new Map()
                };
                groups.set(machineId, machineGroup);
            }

            // Get or create project group within machine
            let projectGroup = machineGroup.projects.get(projectPath);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(projectPath, session.metadata?.homeDir);
                projectGroup = {
                    path: projectPath,
                    displayPath,
                    sessions: []
                };
                machineGroup.projects.set(projectPath, projectGroup);
            }

            // Add session to project group
            projectGroup.sessions.push(session);
        });

        // Sort sessions within each project by creation time (newest first)
        groups.forEach(machineGroup => {
            machineGroup.projects.forEach(projectGroup => {
                projectGroup.sessions.sort((a, b) => b.createdAt - a.createdAt);
            });
        });

        return groups;
    }, [sessions, machinesMap]);

    // Sort machine groups by name
    const sortedMachineGroups = React.useMemo(() => {
        return Array.from(machineGroups.entries()).sort(([, groupA], [, groupB]) => {
            return groupA.machineName.localeCompare(groupB.machineName);
        });
    }, [machineGroups]);

    return (
        <View style={{ backgroundColor: '#fff' }}>
            {sortedMachineGroups.map(([machineId, machineGroup]) => (
                <View key={machineId}>
                    {/* Machine header */}
                    <View style={{
                        paddingHorizontal: 16,
                        paddingVertical: 8,
                        backgroundColor: '#F8F8F8',
                        borderBottomWidth: 0.5,
                        borderBottomColor: '#E5E5E7'
                    }}>
                        <Text style={{ 
                            fontSize: 13, 
                            fontWeight: '600', 
                            color: '#000',
                            ...Typography.default('semiBold') 
                        }}>
                            {machineGroup.machineName}
                        </Text>
                    </View>

                    {/* Project groups */}
                    {Array.from(machineGroup.projects.entries())
                        .sort(([, projectA], [, projectB]) => projectA.displayPath.localeCompare(projectB.displayPath))
                        .map(([projectPath, projectGroup]) => (
                            <View key={`${machineId}-${projectPath}`}>
                                {/* Project path header */}
                                <View style={{
                                    paddingHorizontal: 16,
                                    paddingVertical: 6,
                                    backgroundColor: '#FAFAFA'
                                }}>
                                    <Text style={{ 
                                        fontSize: 11, 
                                        color: '#8E8E93',
                                        ...Typography.default() 
                                    }}>
                                        {projectGroup.displayPath}
                                    </Text>
                                </View>

                                {/* Sessions */}
                                {projectGroup.sessions.map(session => (
                                    <CompactSessionRow 
                                        key={session.id} 
                                        session={session} 
                                        selected={selectedSessionId === session.id}
                                    />
                                ))}
                            </View>
                        ))}
                </View>
            ))}
        </View>
    );
}

// Compact session row component with status line
const CompactSessionRow = React.memo(({ session, selected }: { session: Session; selected?: boolean }) => {
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const router = useRouter();

    const avatarId = React.useMemo(() => {
        return getSessionAvatarId(session);
    }, [session]);

    return (
        <Pressable
            style={{
                height: 88,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                backgroundColor: selected ? '#f9f9f9' : '#fff'
            }}
            onPress={() => {
                router.push(`/session/${session.id}`);
            }}
        >
            <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} />
            <View style={{ flex: 1, marginLeft: 16, justifyContent: 'center' }}>
                {/* Title line with draft icon */}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                    <Text style={{
                        fontSize: 15,
                        fontWeight: '500',
                        color: sessionStatus.isConnected ? '#000' : '#999',
                        flex: 1,
                        ...Typography.default('semiBold')
                    }} numberOfLines={2}>
                        {sessionName}
                    </Text>
                    {session.draft && (
                        <Ionicons
                            name="create-outline"
                            size={16}
                            color="#8E8E93"
                            style={{ marginLeft: 6 }}
                        />
                    )}
                </View>

                {/* Status line with dot */}
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: 16,
                        marginTop: 2,
                        marginRight: 4
                    }}>
                        <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                    </View>
                    <Text style={{
                        fontSize: 12,
                        color: sessionStatus.statusColor,
                        fontWeight: '500',
                        lineHeight: 16,
                        ...Typography.default()
                    }}>
                        {sessionStatus.statusText}
                    </Text>
                </View>
            </View>
        </Pressable>
    );
});