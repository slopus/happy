import React from 'react';
import { View, Text, ScrollView, ActivityIndicator, Platform, Pressable } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { machineSpawnNewSession } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { Modal } from '@/modal';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { MachineSessionLauncher } from '@/components/machines/MachineSessionLauncher';

export default function NewSessionScreen() {
    const router = useRouter();
    const sessions = useSessions();
    const machines = useAllMachines();

    // Group sessions by machineId and combine with machine status
    const machineGroups = React.useMemo(() => {
        const groups: Record<string, {
            machineHost: string,
            paths: Set<string>,
            isOnline: boolean,
            lastSeen?: number,
            metadata?: any
        }> = {};

        // First, add all active machines with their proper host names
        machines.forEach(machine => {
            groups[machine.id] = {
                machineHost: machine.metadata?.host || machine.id,
                paths: new Set(),
                isOnline: isMachineOnline(machine),
                lastSeen: machine.activeAt,
                metadata: machine.metadata
            };
        });

        // Then, collect paths from existing sessions
        if (sessions) {
            sessions.forEach(item => {
                if (typeof item === 'string') return; // Skip section headers

                const session = item as Session;
                if (session.metadata?.machineId) {
                    const machineId = session.metadata.machineId;

                    // Only add path to existing machine groups
                    if (groups[machineId] && session.metadata.path) {
                        groups[machineId].paths.add(session.metadata.path);
                    }
                }
            });
        }

        return groups;
    }, [sessions, machines]);

    const handleStartSession = async (machineId: string, path: string) => {
        try {
            console.log(`🚀 Starting session on machine ${machineId} at path: ${path}`);
            const result = await machineSpawnNewSession(machineId, path);
            console.log('🎉 daemon result', result);

            if (result.sessionId) {
                console.log('✅ Session spawned successfully:', result.sessionId);

                // Poll for the session to appear in our local state
                const pollInterval = 100;
                const maxAttempts = 20;
                let attempts = 0;

                const pollForSession = () => {
                    const state = storage.getState();
                    const newSession = Object.values(state.sessions).find((s: Session) => s.id === result.sessionId);

                    if (newSession) {
                        console.log('📱 Navigating to session:', result.sessionId);
                        router.replace(`/session/${result.sessionId}`);
                        return;
                    }

                    attempts++;
                    if (attempts < maxAttempts) {
                        setTimeout(pollForSession, pollInterval);
                    } else {
                        console.log('⏰ Polling timeout - session should appear soon');
                        Modal.alert('Session started', 'The session was started but may take a moment to appear.');
                        router.back();
                    }
                };

                pollForSession();
            } else {
                console.error('❌ No sessionId in response:', result);
                Modal.alert('Error', 'Session spawning failed - no session ID returned.');
                throw new Error('Session spawning failed - no session ID returned.');
            }
        } catch (error) {
            console.error('💥 Failed to start session', error);

            let errorMessage = 'Failed to start session. Make sure the daemon is running on the target machine.';
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = 'Session startup timed out. The machine may be slow or the daemon may not be responding.';
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = 'Not connected to server. Check your internet connection.';
                }
            }

            Modal.alert('Error', errorMessage);
            throw error; // Re-throw so the component knows it failed
        }
    };


    if (!sessions) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#666" />
            </View>
        );
    }

    const sortedMachines = Object.entries(machineGroups).sort(([, a], [, b]) => {
        // Sort by online status first, then by last seen
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;
        return (b.lastSeen || 0) - (a.lastSeen || 0);
    });

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: 'Start New Session',
                    headerBackTitle: 'Back'
                }}
            />
            <View style={{ flex: 1, backgroundColor: '#F2F2F7' }}>
                {sortedMachines.length === 0 ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                        <Text style={[Typography.default(), { fontSize: 16, color: '#666', textAlign: 'center' }]}>
                            No machines found. Start a Happy session on your computer first.
                        </Text>
                    </View>
                ) : (
                    <ScrollView style={{ flex: 1 }}>
                        {sortedMachines.every(([, data]) => !data.isOnline) && (
                            <View style={{
                                marginHorizontal: 16,
                                marginTop: 16,
                                marginBottom: 8,
                                padding: 16,
                                backgroundColor: '#FFF3CD',
                                borderRadius: 12,
                                borderWidth: 1,
                                borderColor: '#FFE69C'
                            }}>
                                <Text style={[Typography.default('semiBold'), {
                                    fontSize: 14,
                                    color: '#664D03',
                                    marginBottom: 8
                                }]}>
                                    All machines appear offline
                                </Text>
                                <View style={{ marginTop: 4 }}>
                                    <Text style={[Typography.default(), {
                                        fontSize: 13,
                                        color: '#664D03',
                                        lineHeight: 20,
                                        marginBottom: 4
                                    }]}>
                                        • Is your computer online?
                                    </Text>
                                    <Text style={[Typography.default(), {
                                        fontSize: 13,
                                        color: '#664D03',
                                        lineHeight: 20
                                    }]}>
                                        • Is the Happy daemon running? Check with `happy daemon status`
                                    </Text>
                                </View>
                            </View>
                        )}
                        <ItemList>
                            {sortedMachines.map(([machineId, data]) => {
                                const machine = machines.find(m => m.id === machineId);
                                if (!machine) return null;

                                // Get home directory from machine metadata
                                const homeDir = machine.metadata?.homeDir || '~';

                                return (
                                    <ItemGroup
                                        key={machineId}
                                        title={(
                                            <View>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
                                                    <View style={{
                                                        width: 6,
                                                        height: 6,
                                                        borderRadius: 3,
                                                        backgroundColor: data.isOnline ? '#34C759' : '#C7C7CC',
                                                        marginRight: 6
                                                    }} />
                                                    <Text style={[Typography.default(), {
                                                        fontSize: 12,
                                                        color: data.isOnline ? '#34C759' : '#8E8E93'
                                                    }]}>
                                                        {data.isOnline ? 'online' : 'offline'}
                                                    </Text>
                                                </View>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                                                        <Ionicons
                                                            name="desktop-outline"
                                                            size={20}
                                                            color="#007AFF"
                                                            style={{ marginRight: 8 }}
                                                        />
                                                        <Text style={[Typography.default(), { fontSize: 15, color: '#000' }]}>
                                                            {data.machineHost}
                                                        </Text>
                                                    </View>
                                                    <Pressable
                                                        onPress={() => router.push(`/machine/${machineId}`)}
                                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                        style={{ paddingLeft: 8 }}
                                                    >
                                                        <Text style={[Typography.default(), {
                                                            fontSize: 15,
                                                            color: '#007AFF'
                                                        }]}>
                                                            details
                                                        </Text>
                                                    </Pressable>
                                                </View>
                                            </View>
                                        )}
                                    >
                                        <MachineSessionLauncher
                                            machineId={machineId}
                                            recentPaths={Array.from(data.paths).sort()}
                                            homeDir={homeDir}
                                            isOnline={data.isOnline}
                                            onStartSession={(path) => handleStartSession(machineId, path)}
                                        />
                                    </ItemGroup>
                                );
                            })}
                        </ItemList>
                    </ScrollView>
                )}
            </View>
        </>
    );
}