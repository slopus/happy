import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { spawnRemoteSession } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { Modal } from '@/modal';

export default function NewSessionScreen() {
    const router = useRouter();
    const sessions = useSessions();
    const machines = useAllMachines();
    const [customPaths, setCustomPaths] = useState<Record<string, string>>({});
    const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
    const [isSpawning, setIsSpawning] = useState(false);

    // Group sessions by machineId and combine with machine status
    const machineGroups = React.useMemo(() => {
        const groups: Record<string, { 
            machineHost: string, 
            paths: Set<string>,
            isOnline: boolean,
            lastSeen?: number
        }> = {};
        
        // First, add all active machines with their proper host names
        machines.forEach(machine => {
            groups[machine.id] = {
                machineHost: machine.metadata?.host || machine.id,
                paths: new Set(),
                isOnline: machine.active,
                lastSeen: machine.lastActiveAt
            };
        });
        
        // Then, collect paths from existing sessions
        if (sessions) {
            console.log('[new-session] Total sessions:', sessions.length);
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
        
        console.log('[new-session] Machine groups:', Object.entries(groups).map(([id, data]) => ({
            machineId: id,
            host: data.machineHost,
            pathCount: data.paths.size,
            paths: Array.from(data.paths),
            isOnline: data.isOnline
        })));
        
        return groups;
    }, [sessions, machines]);

    const handleStartSession = async (machineId: string, path: string) => {
        if (!isSpawning) {
            setIsSpawning(true);
            try {
                const result = await spawnRemoteSession(machineId, path);
                console.log('daemon result', result);
                if (result.sessionId) {
                    // NOTE: This does not really work for some reason : D
                    console.log('Session spawned:', result.sessionId);
                    
                    // Poll for the session to appear in our local state
                    const pollInterval = 100; // Poll every 100ms
                    const maxAttempts = 20; // Max 2 seconds
                    let attempts = 0;
                    
                    const pollForSession = () => {
                        const state = storage.getState();
                        const newSession = Object.values(state.sessions).find((s: Session) => s.id === result.sessionId);
                        
                        if (newSession) {
                            // Session found! Navigate to it using replace to remove new-session screen from stack
                            router.replace(`/session/${result.sessionId}`);
                            return;
                        }
                        
                        attempts++;
                        if (attempts < maxAttempts) {
                            setTimeout(pollForSession, pollInterval);
                        } else {
                            // Timeout - session didn't appear
                            setIsSpawning(false);
                            Modal.alert('Session started', 'The session was started but may take a moment to appear. Pull to refresh on the main screen.');
                            router.back();
                        }
                    };
                    
                    // Start polling
                    pollForSession();
                }
            } catch (error) {
                console.error('Failed to start session', error);
                Modal.alert('Error', 'Failed to start session. Make sure the daemon is running on the target machine.');
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