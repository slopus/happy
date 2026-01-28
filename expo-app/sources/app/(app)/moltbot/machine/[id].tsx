/**
 * Moltbot Machine Detail Page
 *
 * Shows machine details and session list for a Moltbot machine.
 * Handles connection to the Moltbot gateway and displays sessions.
 */

import React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { StatusDot } from '@/components/StatusDot';
import { useMoltbotMachine, useMachine } from '@/sync/storage';
import { useMoltbotConnection } from '@/moltbot/connection';
import type { MoltbotSession } from '@/moltbot/types';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollContent: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
        paddingBottom: 24,
    },
    statusBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: 16,
        marginHorizontal: 16,
        marginTop: 16,
        borderRadius: 8,
        gap: 8,
    },
    statusBannerConnected: {
        backgroundColor: 'rgba(52, 199, 89, 0.15)',
    },
    statusBannerConnecting: {
        backgroundColor: 'rgba(255, 159, 10, 0.15)',
    },
    statusBannerError: {
        backgroundColor: 'rgba(255, 59, 48, 0.15)',
    },
    statusBannerPairing: {
        backgroundColor: 'rgba(0, 122, 255, 0.15)',
    },
    statusText: {
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    sessionIcon: {
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 48,
        paddingHorizontal: 24,
    },
    emptyTitle: {
        fontSize: 18,
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    emptyDescription: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
        ...Typography.default(),
    },
    connectButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
        marginTop: 16,
    },
    connectButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    sessionStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    sessionStatusText: {
        fontSize: 12,
        ...Typography.default(),
    },
    headerRight: {
        paddingHorizontal: 16,
    },
}));

interface SessionItemProps {
    session: MoltbotSession;
    onPress: () => void;
}

const SessionItem = React.memo(({ session, onPress }: SessionItemProps) => {
    const { theme } = useUnistyles();

    // Get session display name
    const displayName = session.displayName || session.label || session.key;

    // Get session type icon
    const getSessionIcon = () => {
        switch (session.kind) {
            case 'direct':
                return 'chatbubble';
            case 'group':
                return 'people';
            case 'global':
                return 'globe';
            default:
                return 'ellipse';
        }
    };

    // Format updated time
    const formatTime = (timestamp: number | null) => {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 1) return t('time.justNow');
        if (diffMins < 60) return t('time.minutesAgo', { count: diffMins });
        if (diffHours < 24) return t('time.hoursAgo', { count: diffHours });
        return t('sessionHistory.daysAgo', { count: diffDays });
    };

    const iconElement = (
        <View style={[styles.sessionIcon, { backgroundColor: theme.colors.surfacePressed }]}>
            <Ionicons name={getSessionIcon()} size={18} color={theme.colors.textSecondary} />
        </View>
    );

    const subtitle = session.model
        ? `${session.model}${session.updatedAt ? ' • ' + formatTime(session.updatedAt) : ''}`
        : formatTime(session.updatedAt);

    return (
        <Item
            title={displayName}
            subtitle={subtitle || session.kind}
            subtitleLines={1}
            leftElement={iconElement}
            onPress={onPress}
            showChevron={true}
        />
    );
});

export default function MoltbotMachineDetailPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { id: machineId } = useLocalSearchParams<{ id: string }>();

    // Get machine data
    const machine = useMoltbotMachine(machineId ?? '');
    const happyMachine = useMachine(machine?.happyMachineId ?? '');

    // Connection hook
    const {
        status,
        isConnected,
        isConnecting,
        isPairingRequired,
        error,
        connect,
        send,
        reconnect,
    } = useMoltbotConnection(machineId ?? '', {
        autoConnect: true,
        onEvent: (event, payload) => {
            // Handle real-time events if needed
            console.log('[Moltbot] Event:', event, payload);
        },
    });

    // Sessions state
    const [sessions, setSessions] = React.useState<MoltbotSession[]>([]);
    const [isLoadingSessions, setIsLoadingSessions] = React.useState(false);
    const [refreshing, setRefreshing] = React.useState(false);

    // Fetch sessions when connected
    const fetchSessions = React.useCallback(async () => {
        if (!isConnected) return;

        setIsLoadingSessions(true);
        try {
            const result = await send('sessions.list', {});
            if (result.ok && result.payload) {
                const sessionList = (result.payload as { sessions?: MoltbotSession[] }).sessions ?? [];
                setSessions(sessionList);
            }
        } catch (err) {
            console.error('Failed to fetch sessions:', err);
        } finally {
            setIsLoadingSessions(false);
        }
    }, [isConnected, send]);

    // Fetch sessions when connected
    React.useEffect(() => {
        if (isConnected) {
            fetchSessions();
        }
    }, [isConnected, fetchSessions]);

    // Handle refresh
    const handleRefresh = React.useCallback(async () => {
        setRefreshing(true);
        await fetchSessions();
        setRefreshing(false);
    }, [fetchSessions]);

    // Handle session press
    const handleSessionPress = React.useCallback((session: MoltbotSession) => {
        router.push({
            pathname: '/moltbot/chat',
            params: {
                machineId: machineId,
                sessionKey: session.key,
            },
        });
    }, [router, machineId]);

    // Handle new session
    const handleNewSession = React.useCallback(() => {
        router.push({
            pathname: '/moltbot/new',
            params: { machineId: machineId },
        });
    }, [router, machineId]);

    // Get machine name
    const machineName = machine?.metadata?.name ||
        (machine?.type === 'happy' ? happyMachine?.metadata?.host : machine?.directConfig?.url) ||
        t('moltbot.unknownMachine');

    // Get status banner config
    const getStatusBannerConfig = () => {
        switch (status) {
            case 'connected':
                return {
                    style: styles.statusBannerConnected,
                    color: theme.colors.status.connected,
                    text: t('status.connected'),
                    icon: 'checkmark-circle' as const,
                };
            case 'connecting':
                return {
                    style: styles.statusBannerConnecting,
                    color: theme.colors.status.connecting,
                    text: t('status.connecting'),
                    icon: 'sync' as const,
                };
            case 'pairing_required':
                return {
                    style: styles.statusBannerPairing,
                    color: theme.colors.button.primary.background,
                    text: t('moltbot.pairingRequired'),
                    icon: 'key' as const,
                };
            case 'error':
                return {
                    style: styles.statusBannerError,
                    color: theme.colors.status.disconnected,
                    text: error || t('status.error'),
                    icon: 'alert-circle' as const,
                };
            default:
                return {
                    style: styles.statusBannerError,
                    color: theme.colors.textSecondary,
                    text: t('status.disconnected'),
                    icon: 'cloud-offline' as const,
                };
        }
    };

    const statusConfig = getStatusBannerConfig();

    if (!machine) {
        return (
            <View style={styles.container}>
                <Stack.Screen options={{ headerTitle: t('common.notFound') }} />
                <View style={styles.emptyContainer}>
                    <Ionicons name="alert-circle" size={48} color={theme.colors.textSecondary} />
                    <Text style={[styles.emptyTitle, { marginTop: 16 }]}>{t('moltbot.machineNotFound')}</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    headerTitle: machineName,
                    headerRight: () => (
                        <Pressable
                            onPress={handleNewSession}
                            style={styles.headerRight}
                            disabled={!isConnected}
                        >
                            <Ionicons
                                name="add"
                                size={24}
                                color={isConnected ? theme.colors.header.tint : theme.colors.textSecondary}
                            />
                        </Pressable>
                    ),
                }}
            />
            <ScrollView
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingBottom: safeArea.bottom + 24 }
                ]}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor={theme.colors.textSecondary}
                    />
                }
            >
                {/* Status Banner */}
                <View style={[styles.statusBanner, statusConfig.style]}>
                    {isConnecting ? (
                        <ActivityIndicator size="small" color={statusConfig.color} />
                    ) : (
                        <Ionicons name={statusConfig.icon} size={20} color={statusConfig.color} />
                    )}
                    <Text style={[styles.statusText, { color: statusConfig.color }]}>
                        {statusConfig.text}
                    </Text>
                </View>

                {/* Error/Disconnected state with connect button */}
                {(status === 'disconnected' || status === 'error') && (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyDescription}>
                            {error || t('moltbot.notConnected')}
                        </Text>
                        <Pressable style={styles.connectButton} onPress={() => connect()}>
                            <Text style={styles.connectButtonText}>{t('moltbot.connect')}</Text>
                        </Pressable>
                    </View>
                )}

                {/* Pairing required state */}
                {isPairingRequired && (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="key" size={48} color={theme.colors.button.primary.background} />
                        <Text style={[styles.emptyTitle, { marginTop: 16 }]}>
                            {t('moltbot.pairingRequired')}
                        </Text>
                        <Text style={styles.emptyDescription}>
                            {t('moltbot.pairingInstructions')}
                        </Text>
                    </View>
                )}

                {/* Loading sessions */}
                {isConnected && isLoadingSessions && sessions.length === 0 && (
                    <View style={styles.emptyContainer}>
                        <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                    </View>
                )}

                {/* Sessions list */}
                {isConnected && !isLoadingSessions && sessions.length === 0 && (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="chatbubbles-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={[styles.emptyTitle, { marginTop: 16 }]}>
                            {t('moltbot.noSessions')}
                        </Text>
                        <Text style={styles.emptyDescription}>
                            {t('moltbot.noSessionsDescription')}
                        </Text>
                        <Pressable style={styles.connectButton} onPress={handleNewSession}>
                            <Text style={styles.connectButtonText}>{t('moltbot.newSession')}</Text>
                        </Pressable>
                    </View>
                )}

                {isConnected && sessions.length > 0 && (
                    <ItemGroup title={t('moltbot.sessions')}>
                        {sessions.map((session) => (
                            <SessionItem
                                key={session.key}
                                session={session}
                                onPress={() => handleSessionPress(session)}
                            />
                        ))}
                    </ItemGroup>
                )}
            </ScrollView>
        </View>
    );
}
