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
import { StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.listBackground,
    },
    scrollContainer: {
        flex: 1,
    },
    scrollContent: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.subtitleText,
        textAlign: 'center',
        ...Typography.default(),
    },
    offlineWarning: {
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 8,
        padding: 16,
        backgroundColor: '#FFF3CD',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#FFE69C',
    },
    offlineWarningTitle: {
        fontSize: 14,
        color: '#664D03',
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    offlineWarningText: {
        fontSize: 13,
        color: '#664D03',
        lineHeight: 20,
        marginBottom: 4,
        ...Typography.default(),
    },
    machineCard: {
        backgroundColor: theme.colors.cardBackground,
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 12,
        shadowColor: Platform.select({ 
            web: 'rgba(0, 0, 0, 0.05)',
            default: theme.colors.shadowColor 
        }),
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: Platform.select({ web: 1, default: 0.05 }),
        shadowRadius: 3,
        elevation: 2,
    },
    machineHeader: {
        padding: 16,
        borderBottomWidth: 0.5,
        borderBottomColor: theme.colors.divider,
    },
    machineHeaderTop: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 8,
    },
    machineInfo: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
    },
    machineIcon: {
        marginRight: 12,
    },
    machineTextContainer: {
        flex: 1,
    },
    machineName: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.titleText,
        marginBottom: 2,
        ...Typography.default('semiBold'),
    },
    machineHost: {
        fontSize: 13,
        color: theme.colors.subtitleText,
        ...Typography.default(),
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: theme.colors.listBackground,
    },
    statusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        marginRight: 6,
    },
    statusText: {
        fontSize: 11,
        fontWeight: '500',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        ...Typography.default('semiBold'),
    },
    detailsButton: {
        marginTop: 8,
    },
    detailsButtonText: {
        fontSize: 14,
        color: theme.colors.primary,
        ...Typography.default(),
    },
}));

export default function NewSessionScreen() {
    const styles = stylesheet;
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
            <View style={styles.container}>
                {sortedMachines.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>
                            No machines found. Start a Happy session on your computer first.
                        </Text>
                    </View>
                ) : (
                    <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scrollContent}>
                        <View style={styles.contentWrapper}>
                            {sortedMachines.every(([, data]) => !data.isOnline) && (
                                <View style={styles.offlineWarning}>
                                    <Text style={styles.offlineWarningTitle}>
                                        All machines appear offline
                                    </Text>
                                    <View style={{ marginTop: 4 }}>
                                        <Text style={styles.offlineWarningText}>
                                            • Is your computer online?
                                        </Text>
                                        <Text style={styles.offlineWarningText}>
                                            • Is the Happy daemon running? Check with `happy daemon status`
                                        </Text>
                                    </View>
                                </View>
                            )}
                            {sortedMachines.map(([machineId, data]) => {
                            const machine = machines.find(m => m.id === machineId);
                            if (!machine) return null;

                            // Get home directory and display name from machine metadata
                            const homeDir = machine.metadata?.homeDir || '~';
                            const displayName = machine.metadata?.displayName || data.machineHost;
                            const hostName = machine.metadata?.host || machineId;

                            return (
                                <View key={machineId} style={styles.machineCard}>
                                    <View style={styles.machineHeader}>
                                        <View style={styles.machineHeaderTop}>
                                            <View style={styles.machineInfo}>
                                                <View style={styles.machineIcon}>
                                                    <Ionicons
                                                        name="desktop-outline"
                                                        size={24}
                                                        color={data.isOnline ? '#007AFF' : '#8E8E93'}
                                                    />
                                                </View>
                                                <View style={styles.machineTextContainer}>
                                                    <Text style={styles.machineName}>
                                                        {displayName}
                                                    </Text>
                                                    {displayName !== hostName && (
                                                        <Text style={styles.machineHost}>
                                                            {hostName}
                                                        </Text>
                                                    )}
                                                </View>
                                            </View>
                                            <View style={styles.statusContainer}>
                                                <View style={[
                                                    styles.statusDot,
                                                    { backgroundColor: data.isOnline ? '#34C759' : '#C7C7CC' }
                                                ]} />
                                                <Text style={[
                                                    styles.statusText,
                                                    { color: data.isOnline ? '#34C759' : '#8E8E93' }
                                                ]}>
                                                    {data.isOnline ? 'online' : 'offline'}
                                                </Text>
                                            </View>
                                        </View>
                                        <Pressable
                                            onPress={() => router.push(`/machine/${machineId}`)}
                                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                            style={styles.detailsButton}
                                        >
                                            <Text style={styles.detailsButtonText}>
                                                View machine details →
                                            </Text>
                                        </Pressable>
                                    </View>
                                    <MachineSessionLauncher
                                        machineId={machineId}
                                        recentPaths={Array.from(data.paths).sort()}
                                        homeDir={homeDir}
                                        isOnline={data.isOnline}
                                        onStartSession={(path) => handleStartSession(machineId, path)}
                                    />
                                </View>
                            );
                        })}
                        </View>
                    </ScrollView>
                )}
            </View>
        </>
    );
}