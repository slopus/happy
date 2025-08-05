import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllDaemonStatuses } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { spawnRemoteSession } from '@/sync/ops';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { Modal } from '@/modal';

export default function NewSessionScreen() {
    const router = useRouter();
    const sessions = useSessions();
    const daemonStatuses = useAllDaemonStatuses();
    const [customPaths, setCustomPaths] = useState<Record<string, string>>({});
    const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
    const [isSpawning, setIsSpawning] = useState(false);

    // Group sessions by machineId and combine with daemon status
    const machineGroups = React.useMemo(() => {
        const groups: Record<string, { 
            machineHost: string, 
            paths: Set<string>,
            isOnline: boolean,
            lastSeen?: number
        }> = {};
        
        // First, add all online daemons
        daemonStatuses.forEach(daemon => {
            groups[daemon.machineId] = {
                machineHost: daemon.machineId, // We'll update this from sessions
                paths: new Set(),
                isOnline: daemon.online,
                lastSeen: daemon.lastSeen
            };
        });
        
        // Then, enrich with session data
        if (sessions) {
            sessions.forEach(item => {
                if (typeof item === 'string') return; // Skip section headers
                
                const session = item as Session;
                if (session.metadata?.machineId) {
                    const machineId = session.metadata.machineId;
                    if (!groups[machineId]) {
                        groups[machineId] = {
                            machineHost: session.metadata.host || 'Unknown',
                            paths: new Set(),
                            isOnline: false, // Daemon not online
                            lastSeen: session.updatedAt
                        };
                    } else {
                        // Update host name from session metadata
                        groups[machineId].machineHost = session.metadata.host || groups[machineId].machineHost;
                    }
                    
                    // Add path if it exists
                    if (session.metadata.path) {
                        groups[machineId].paths.add(session.metadata.path);
                    }
                    
                    // Update last seen if more recent
                    if (session.updatedAt > (groups[machineId].lastSeen || 0)) {
                        groups[machineId].lastSeen = session.updatedAt;
                    }
                }
            });
        }
        
        return groups;
    }, [sessions, daemonStatuses]);

    const handleStartSession = async (machineId: string, path: string) => {
        if (!isSpawning) {
            setIsSpawning(true);
            try {
                const result = await spawnRemoteSession(machineId, path);
                if (result.sessionId) {
                    router.replace(`/session/${result.sessionId}`);
                }
            } catch (error) {
                Modal.alert('Error', 'Failed to start session. Make sure the daemon is running on the target machine.');
            } finally {
                setIsSpawning(false);
            }
        }
    };

    const handleCustomPathChange = (machineId: string, path: string) => {
        setCustomPaths(prev => ({ ...prev, [machineId]: path }));
        setSelectedMachine(machineId);
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
                                        lineHeight: 20,
                                        marginBottom: 4
                                    }]}>
                                        • Is it asleep? If you're using a Mac, search App Store for 'Amphetamine' - prevents sleep even when the lid is closed
                                    </Text>
                                    <Text style={[Typography.default(), { 
                                        fontSize: 13, 
                                        color: '#664D03',
                                        lineHeight: 20
                                    }]}>
                                        • Is the Happy daemon running?
                                    </Text>
                                </View>
                            </View>
                        )}
                        <ItemList>
                            {sortedMachines.map(([machineId, data]) => (
                                <ItemGroup key={machineId} title={(
                                    <View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                            <Ionicons 
                                                name={Platform.OS === 'ios' ? 'desktop' : 'desktop-outline'} 
                                                size={16} 
                                                color="#666" 
                                                style={{ marginRight: 6 }}
                                            />
                                            <Text style={[Typography.default('semiBold'), { fontSize: 16 }]}>
                                                {data.machineHost}
                                            </Text>
                                            <View style={{ 
                                                width: 8, 
                                                height: 8, 
                                                borderRadius: 4, 
                                                backgroundColor: data.isOnline ? '#34C759' : '#C7C7CC',
                                                marginLeft: 8
                                            }} />
                                            <Text style={[Typography.default(), { 
                                                fontSize: 12, 
                                                color: data.isOnline ? '#34C759' : '#8E8E93',
                                                marginLeft: 4
                                            }]}>
                                                {data.isOnline ? 'online' : 'offline'}
                                            </Text>
                                        </View>
                                    </View>
                                )
                                }>
                                    {Array.from(data.paths).slice(0, 3).map(path => (
                                        <Item
                                            key={path}
                                            title={path}
                                            titleStyle={{ fontFamily: 'Menlo', fontSize: 14 }}
                                            onPress={() => {
                                                setSelectedMachine(machineId);
                                                setCustomPaths(prev => ({ ...prev, [machineId]: path }));
                                            }}
                                            selected={selectedMachine === machineId && customPaths[machineId] === path}
                                        />
                                    ))}
                                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                                        <TextInput
                                            style={{
                                                borderWidth: 1,
                                                borderColor: selectedMachine === machineId ? '#007AFF' : '#C7C7CC',
                                                borderRadius: 8,
                                                padding: 12,
                                                fontSize: 14,
                                                fontFamily: 'Menlo',
                                                backgroundColor: selectedMachine === machineId ? '#F0F8FF' : '#F2F2F7',
                                                minHeight: 44,
                                                textAlignVertical: 'top'
                                            }}
                                            placeholder="Enter custom path (default: ~)"
                                            placeholderTextColor="#8E8E93"
                                            value={customPaths[machineId] || ''}
                                            onChangeText={(text) => handleCustomPathChange(machineId, text)}
                                            onFocus={() => setSelectedMachine(machineId)}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            multiline={true}
                                        />
                                        {customPaths[machineId] && customPaths[machineId].trim() !== '' && (
                                            <View style={{ marginTop: 12, alignItems: 'flex-end' }}>
                                                <RoundButton
                                                    title={isSpawning ? "Starting..." : "Start"}
                                                    onPress={() => handleStartSession(machineId, customPaths[machineId])}
                                                    size="small"
                                                    disabled={isSpawning}
                                                    loading={isSpawning}
                                                />
                                            </View>
                                        )}
                                    </View>
                                </ItemGroup>
                            ))}
                        </ItemList>
                    </ScrollView>
                )}
            </View>
        </>
    );
}