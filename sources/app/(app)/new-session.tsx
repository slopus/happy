import React from 'react';
import { View, Text, ScrollView, ActivityIndicator, Platform, Pressable } from 'react-native';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { machineSpawnNewSession } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { Modal } from '@/modal';
import { isMachineOnline } from '@/utils/machineUtils';
import { MachineSessionLauncher } from '@/components/MachineSessionLauncher';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
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
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    offlineWarning: {
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 8,
        padding: 16,
        backgroundColor: theme.colors.box.warning.background,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.box.warning.border,
    },
    offlineWarningTitle: {
        fontSize: 14,
        color: theme.colors.box.warning.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    offlineWarningText: {
        fontSize: 13,
        color: theme.colors.box.warning.text,
        lineHeight: 20,
        marginBottom: 4,
        ...Typography.default(),
    },
    machineCard: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 12,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: theme.colors.shadow.opacity,
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
        color: theme.colors.text,
        marginBottom: 2,
        ...Typography.default('semiBold'),
    },
    machineHost: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: theme.colors.groupped.background,
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
        color: theme.colors.text,
        ...Typography.default(),
    },
}));

export default function NewSessionScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const sessions = useSessions();
    const machines = useAllMachines();

    // Group sessions by machineId and combine with machine status
    const machineGroups = React.useMemo(() => {
        const groups: Record<string, {
            machineHost: string,
            pathsWithTimestamps: Map<string, number>,
            isOnline: boolean,
            lastSeen?: number,
            metadata?: any,
            createdAt: number
        }> = {};

        // First, add all active machines with their proper host names
        machines.forEach(machine => {
            groups[machine.id] = {
                machineHost: machine.metadata?.host || machine.id,
                pathsWithTimestamps: new Map(),
                isOnline: isMachineOnline(machine),
                lastSeen: machine.activeAt,
                metadata: machine.metadata,
                createdAt: machine.createdAt
            };
        });

        // Then, collect paths from existing sessions with their timestamps
        if (sessions) {
            sessions.forEach(item => {
                if (typeof item === 'string') return; // Skip section headers

                const session = item as Session;
                if (session.metadata?.machineId) {
                    const machineId = session.metadata.machineId;

                    // Only add path to existing machine groups
                    if (groups[machineId] && session.metadata.path) {
                        const existingTimestamp = groups[machineId].pathsWithTimestamps.get(session.metadata.path);
                        // Update with the most recent timestamp for this path
                        if (!existingTimestamp || session.updatedAt > existingTimestamp) {
                            groups[machineId].pathsWithTimestamps.set(session.metadata.path, session.updatedAt);
                        }
                    }
                }
            });
        }

        return groups;
    }, [sessions, machines]);

    const handleStartSession = async (machineId: string, path: string) => {
        try {
            // Get the machine metadata to access home directory
            const machine = machines.find(m => m.id === machineId);
            const homeDir = machine?.metadata?.homeDir;
            
            // Resolve ~ paths to absolute paths before sending to daemon
            const absolutePath = resolveAbsolutePath(path, homeDir);
            
            console.log(`🚀 Starting session on machine ${machineId} at path: ${path} (resolved to: ${absolutePath})`);
            const result = await machineSpawnNewSession(machineId, absolutePath);
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
                        Modal.alert(t('newSession.sessionStarted'), t('newSession.sessionStartedMessage'));
                        router.back();
                    }
                };

                pollForSession();
            } else {
                console.error('❌ No sessionId in response:', result);
                Modal.alert(t('common.error'), t('newSession.sessionSpawningFailed'));
                throw new Error(t('newSession.sessionSpawningFailed'));
            }
        } catch (error) {
            console.error('💥 Failed to start session', error);

            let errorMessage = t('newSession.failedToStart');
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = t('newSession.sessionTimeout');
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = t('newSession.notConnectedToServer');
                }
            }

            Modal.alert(t('common.error'), errorMessage);
            throw error; // Re-throw so the component knows it failed
        }
    };


    if (!sessions) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    const sortedMachines = Object.entries(machineGroups).sort(([, a], [, b]) => {
        // Sort by online status first, then by last seen
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;
        return (b.createdAt || 0) - (a.createdAt || 0);
    });

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('newSession.title'),
                    headerBackTitle: t('common.back')
                }}
            />
            <View style={styles.container}>
                {sortedMachines.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>
                            {t('newSession.noMachinesFound')}
                        </Text>
                    </View>
                ) : (
                    <ScrollView 
                        style={styles.scrollContainer} 
                        contentContainerStyle={styles.scrollContent}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={styles.contentWrapper}>
                            {sortedMachines.every(([, data]) => !data.isOnline) && (
                                <View style={styles.offlineWarning}>
                                    <Text style={styles.offlineWarningTitle}>
                                        {t('newSession.allMachinesOffline')}
                                    </Text>
                                    <View style={{ marginTop: 4 }}>
                                        <Text style={styles.offlineWarningText}>
                                            {t('newSession.machineOfflineHelp.computerOnline')}
                                        </Text>
                                        <Text style={styles.offlineWarningText}>
                                            {t('newSession.machineOfflineHelp.daemonRunning')}
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
                                                            color={data.isOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
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
                                                        { backgroundColor: data.isOnline ? theme.colors.status.connected : theme.colors.status.disconnected }
                                                    ]} />
                                                    <Text style={[
                                                        styles.statusText,
                                                        { color: data.isOnline ? theme.colors.status.connected : theme.colors.status.disconnected }
                                                    ]}>
                                                        {data.isOnline ? t('status.online') : t('status.offline')}
                                                    </Text>
                                                </View>
                                            </View>
                                            <Pressable
                                                onPress={() => router.push(`/machine/${machineId}`)}
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                style={styles.detailsButton}
                                            >
                                                <Text style={styles.detailsButtonText}>
                                                    {t('newSession.machineDetails')}
                                                </Text>
                                            </Pressable>
                                        </View>
                                        <MachineSessionLauncher
                                            machineId={machineId}
                                            recentPaths={Array.from(data.pathsWithTimestamps.entries())
                                                .sort((a, b) => b[1] - a[1]) // Sort by timestamp (most recent first)
                                                .map(([path]) => path)} // Extract just the paths
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
