import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Platform } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { spawnRemoteSession } from '@/sync/ops';
import { Modal } from '@/modal';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { MachineSessionLauncher } from '@/components/machines/MachineSessionLauncher';
import { apiSocket } from '@/sync/apiSocket';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';

export default function MachineDetailScreen() {
    const { id: machineId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const sessions = useSessions();
    const machines = useAllMachines();
    const [isDeleting, setIsDeleting] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const machine = useMemo(() => {
        return machines.find(m => m.id === machineId);
    }, [machines, machineId]);

    const machineSessions = useMemo(() => {
        if (!sessions || !machineId) return [];

        return sessions.filter(item => {
            if (typeof item === 'string') return false;
            const session = item as Session;
            return session.metadata?.machineId === machineId;
        }) as Session[];
    }, [sessions, machineId]);

    const recentPaths = useMemo(() => {
        const paths = new Set<string>();
        machineSessions.forEach(session => {
            if (session.metadata?.path) {
                paths.add(session.metadata.path);
            }
        });
        return Array.from(paths).sort();
    }, [machineSessions]);

    const handleStartSession = async (path: string) => {
        if (!machineId) return;

        try {
            console.log(`🚀 Starting session on machine ${machineId} at path: ${path}`);
            const result = await spawnRemoteSession(machineId, path);
            console.log('🎉 daemon result', result);

            if (result.sessionId) {
                console.log('✅ Session spawned successfully:', result.sessionId);

                // Poll for the session to appear
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
                    }
                };

                pollForSession();
            } else {
                console.error('❌ No sessionId in response:', result);
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
            throw error;
        }
    };

    const handleDelete = async () => {
        Modal.alert(
            'Delete Machine',
            `Are you sure you want to delete "${machine?.metadata?.host || machineId}"? This action cannot be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setIsDeleting(true);
                        try {
                            const response = await apiSocket.request(`/v1/machines/${machineId}`, {
                                method: 'DELETE'
                            });

                            if (response.ok) {
                                // Refresh machines list
                                await sync.refreshMachines();
                                router.back();
                            } else {
                                const data = await response.json();
                                Modal.alert('Error', data.error || 'Failed to delete machine');
                            }
                        } catch (error) {
                            console.error('Failed to delete machine:', error);
                            Modal.alert('Error', 'Failed to delete machine. Please try again.');
                        } finally {
                            setIsDeleting(false);
                        }
                    }
                }
            ]
        );
    };

    const handleRefresh = async () => {
        setIsRefreshing(true);
        await sync.refreshMachines();
        setIsRefreshing(false);
    };

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: '',
                        headerBackTitle: 'Back'
                    }}
                />
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={[Typography.default(), { fontSize: 16, color: '#666' }]}>
                        Machine not found
                    </Text>
                </View>
            </>
        );
    }

    const metadata = machine.metadata;
    const machineName = metadata?.host || 'unknown machine';

    const pastUsedRelativePath = useCallback((session: Session) => {
        if (!session.metadata) return 'unknown path';
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }, []);

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: () => (
                        <View style={{ alignItems: 'center' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Ionicons
                                    name="desktop-outline"
                                    size={18}
                                    color="#000"
                                    style={{ marginRight: 6 }}
                                />
                                <Text style={[Typography.default('semiBold'), { fontSize: 17 }]}>
                                    {machineName}
                                </Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                                <View style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 3,
                                    backgroundColor: isMachineOnline(machine) ? '#34C759' : '#999',
                                    marginRight: 4
                                }} />
                                <Text style={[Typography.default(), {
                                    fontSize: 12,
                                    color: isMachineOnline(machine) ? '#34C759' : '#999'
                                }]}>
                                    {isMachineOnline(machine) ? 'online' : 'offline'}
                                </Text>
                            </View>
                        </View>
                    ),
                    headerBackTitle: 'Back'
                }}
            />
            <ScrollView
                style={{ flex: 1, backgroundColor: '#F2F2F7' }}
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={handleRefresh}
                    />
                }
            >
                {/* Recent Projects section with launcher */}
                <ItemList>
                    <ItemGroup title="Recent Projects">
                        <MachineSessionLauncher
                            machineId={machineId!}
                            recentPaths={recentPaths}
                            homeDir={metadata?.homeDirectory}
                            isOnline={isMachineOnline(machine)}
                            onStartSession={handleStartSession}
                        />
                    </ItemGroup>
                </ItemList>

                {/* Active Sessions */}
                {machineSessions.length > 0 && (
                    <ItemList>
                        <ItemGroup title={`Active Sessions (${machineSessions.length})`}>
                            {machineSessions.slice(0, 5).map(session => (
                                <Item
                                    key={session.id}
                                    title={pastUsedRelativePath(session)}
                                    subtitle={session.metadata?.name || 'Untitled Session'}
                                    onPress={() => router.push(`/session/${session.id}`)}
                                    rightElement={<Ionicons name="chevron-forward" size={20} color="#C7C7CC" />}
                                />
                            ))}
                        </ItemGroup>
                    </ItemList>
                )}

                {/* Machine Information */}
                <ItemList>
                    <ItemGroup title="Machine Information">
                        <Item
                            title="Host"
                            subtitle={metadata?.host || machineId}
                        />
                        <Item
                            title="Machine ID"
                            subtitle={machineId}
                            subtitleStyle={{ fontFamily: 'Menlo', fontSize: 12 }}
                        />
                        {metadata?.username && (
                            <Item
                                title="Username"
                                subtitle={metadata.username}
                            />
                        )}
                        {metadata?.homeDirectory && (
                            <Item
                                title="Home Directory"
                                subtitle={metadata.homeDirectory}
                                subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                            />
                        )}
                        {metadata?.platform && (
                            <Item
                                title="Platform"
                                subtitle={metadata.platform}
                            />
                        )}
                        {metadata?.arch && (
                            <Item
                                title="Architecture"
                                subtitle={metadata.arch}
                            />
                        )}
                        <Item
                            title="Last Seen"
                            subtitle={machine.lastActiveAt ? new Date(machine.lastActiveAt).toLocaleString() : 'Never'}
                        />
                        <Item
                            title="Metadata Version"
                            subtitle={String(machine.metadataVersion)}
                        />
                    </ItemGroup>
                </ItemList>

                {/* Actions */}
                <ItemList>
                    <ItemGroup title="Actions">
                        <Item
                            title="Delete Machine"
                            titleStyle={{ color: '#FF3B30' }}
                            onPress={handleDelete}
                            disabled={isDeleting}
                            rightElement={
                                isDeleting ? (
                                    <ActivityIndicator size="small" color="#FF3B30" />
                                ) : (
                                    <Ionicons name="trash" size={20} color="#FF3B30" />
                                )
                            }
                        />
                    </ItemGroup>
                </ItemList>

                <View style={{ height: 40 }} />
            </ScrollView>
        </>
    );
}