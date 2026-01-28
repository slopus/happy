/**
 * Moltbot Machine Detail Page
 *
 * Shows machine details and session list for a Moltbot machine.
 * Handles connection to the Moltbot gateway and displays sessions.
 */

import React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl, Platform, ActionSheetIOS } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useMoltbotMachine, useMachine } from '@/sync/storage';
import { useMoltbotConnection } from '@/moltbot/connection';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal/ModalManager';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
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

    // Loading state for operations
    const [isUpdating, setIsUpdating] = React.useState(false);
    // Menu visibility state
    const [menuVisible, setMenuVisible] = React.useState(false);

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

    // Handle rename machine
    const handleRenameMachine = React.useCallback(async () => {
        if (!machineId || !machine) return;

        const currentName = machine.metadata?.name || '';
        const newName = await Modal.prompt(
            t('moltbot.renameMachine'),
            undefined,
            {
                placeholder: t('moltbot.machineNamePlaceholder'),
                defaultValue: currentName,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            }
        );

        if (newName && newName !== currentName) {
            setIsUpdating(true);
            try {
                await sync.updateMoltbotMachine(machineId, { name: newName });
            } catch (err) {
                console.error('Failed to update machine:', err);
                Modal.alert(t('common.error'), err instanceof Error ? err.message : 'Failed to update machine');
            } finally {
                setIsUpdating(false);
            }
        }
    }, [machineId, machine]);

    // Handle edit gateway URL (for direct type machines)
    const handleEditGatewayUrl = React.useCallback(async () => {
        if (!machineId || !machine || machine.type !== 'direct') return;

        const currentUrl = machine.directConfig?.url || '';
        const newUrl = await Modal.prompt(
            t('moltbot.editGatewayUrl'),
            undefined,
            {
                placeholder: t('moltbot.gatewayUrl'),
                defaultValue: currentUrl,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            }
        );

        if (newUrl && newUrl !== currentUrl) {
            setIsUpdating(true);
            try {
                await sync.updateMoltbotMachine(machineId, {
                    directConfig: {
                        url: newUrl,
                        password: machine.directConfig?.password,
                    }
                });
            } catch (err) {
                console.error('Failed to update gateway URL:', err);
                Modal.alert(t('common.error'), err instanceof Error ? err.message : 'Failed to update gateway URL');
            } finally {
                setIsUpdating(false);
            }
        }
    }, [machineId, machine]);

    // Handle edit gateway password (for direct type machines)
    const handleEditGatewayPassword = React.useCallback(async () => {
        if (!machineId || !machine || machine.type !== 'direct') return;

        const currentPassword = machine.directConfig?.password || '';
        const newPassword = await Modal.prompt(
            t('moltbot.editGatewayPassword'),
            undefined,
            {
                placeholder: t('moltbot.gatewayToken'),
                defaultValue: currentPassword,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
                inputType: 'secure-text',
            }
        );

        if (newPassword !== null && newPassword !== currentPassword) {
            setIsUpdating(true);
            try {
                await sync.updateMoltbotMachine(machineId, {
                    directConfig: {
                        url: machine.directConfig?.url || '',
                        password: newPassword || undefined,
                    }
                });
            } catch (err) {
                console.error('Failed to update gateway password:', err);
                Modal.alert(t('common.error'), err instanceof Error ? err.message : 'Failed to update gateway password');
            } finally {
                setIsUpdating(false);
            }
        }
    }, [machineId, machine]);

    // Handle delete machine
    const handleDeleteMachine = React.useCallback(async () => {
        if (!machineId) return;

        const confirmed = await Modal.confirm(
            t('moltbot.deleteMachine'),
            t('moltbot.deleteMachineConfirmMessage'),
            {
                confirmText: t('common.delete'),
                cancelText: t('common.cancel'),
                destructive: true,
            }
        );

        if (confirmed) {
            setIsUpdating(true);
            try {
                await sync.deleteMoltbotMachine(machineId);
                router.back();
            } catch (err) {
                console.error('Failed to delete machine:', err);
                Modal.alert(t('common.error'), err instanceof Error ? err.message : 'Failed to delete machine');
                setIsUpdating(false);
            }
        }
    }, [machineId, router]);

    // Handle menu button press
    const handleMenuPress = React.useCallback(() => {
        if (Platform.OS === 'ios') {
            // Build options based on machine type
            const isDirectType = machine?.type === 'direct';
            const options = isDirectType
                ? [t('common.cancel'), t('moltbot.renameMachine'), t('moltbot.editGatewayUrl'), t('moltbot.editGatewayPassword'), t('moltbot.deleteMachine')]
                : [t('common.cancel'), t('moltbot.renameMachine'), t('moltbot.deleteMachine')];
            const destructiveIndex = isDirectType ? 4 : 2;

            ActionSheetIOS.showActionSheetWithOptions(
                {
                    options,
                    destructiveButtonIndex: destructiveIndex,
                    cancelButtonIndex: 0,
                },
                (buttonIndex) => {
                    if (isDirectType) {
                        if (buttonIndex === 1) handleRenameMachine();
                        else if (buttonIndex === 2) handleEditGatewayUrl();
                        else if (buttonIndex === 3) handleEditGatewayPassword();
                        else if (buttonIndex === 4) handleDeleteMachine();
                    } else {
                        if (buttonIndex === 1) handleRenameMachine();
                        else if (buttonIndex === 2) handleDeleteMachine();
                    }
                }
            );
        } else {
            // For Android and Web, use ActionMenuModal
            setMenuVisible(true);
        }
    }, [machine?.type, handleRenameMachine, handleEditGatewayUrl, handleEditGatewayPassword, handleDeleteMachine]);

    // Menu items for ActionMenuModal
    const menuItems: ActionMenuItem[] = React.useMemo(() => {
        const items: ActionMenuItem[] = [
            { label: t('moltbot.renameMachine'), onPress: handleRenameMachine },
        ];
        // Add direct config options for direct type machines
        if (machine?.type === 'direct') {
            items.push(
                { label: t('moltbot.editGatewayUrl'), onPress: handleEditGatewayUrl },
                { label: t('moltbot.editGatewayPassword'), onPress: handleEditGatewayPassword },
            );
        }
        items.push({ label: t('moltbot.deleteMachine'), onPress: handleDeleteMachine, destructive: true });
        return items;
    }, [machine?.type, handleRenameMachine, handleEditGatewayUrl, handleEditGatewayPassword, handleDeleteMachine]);

    // Get machine name
    const machineName = machine?.metadata?.name ||
        (machine?.type === 'happy' ? happyMachine?.metadata?.host : machine?.directConfig?.url) ||
        t('moltbot.unknownMachine');

    // Get status config for header subtitle
    const getStatusConfig = () => {
        switch (status) {
            case 'connected':
                return {
                    color: theme.colors.status.connected,
                    text: t('status.connected'),
                };
            case 'connecting':
                return {
                    color: theme.colors.status.connecting,
                    text: t('status.connecting'),
                };
            case 'pairing_required':
                return {
                    color: theme.colors.radio.active,
                    text: t('moltbot.pairingRequired'),
                };
            case 'error':
                return {
                    color: theme.colors.status.disconnected,
                    text: error || t('status.error'),
                };
            default:
                return {
                    color: theme.colors.textSecondary,
                    text: t('status.disconnected'),
                };
        }
    };

    const statusConfig = getStatusConfig();

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
                    headerLeft: () => (
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Pressable
                                onPress={() => router.back()}
                                style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                            >
                                <Ionicons
                                    name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                    size={Platform.OS === 'ios' ? 28 : 24}
                                    color={theme.colors.header.tint}
                                />
                            </Pressable>
                            <View style={{ width: 44 }} />
                        </View>
                    ),
                    headerTitle: () => (
                        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={[Typography.default('semiBold'), { fontSize: 17, lineHeight: 24, color: theme.colors.header.tint }]}
                            >
                                {machineName}
                            </Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: -2 }}>
                                <View style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 3,
                                    backgroundColor: statusConfig.color,
                                    marginRight: 4
                                }} />
                                <Text
                                    numberOfLines={1}
                                    style={[Typography.default(), { fontSize: 12, color: statusConfig.color }]}
                                >
                                    {statusConfig.text}
                                </Text>
                            </View>
                        </View>
                    ),
                    headerRight: () => (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Pressable
                                onPress={handleNewSession}
                                style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                                disabled={!isConnected || isUpdating}
                            >
                                <Ionicons
                                    name="add"
                                    size={24}
                                    color={isConnected && !isUpdating ? theme.colors.header.tint : theme.colors.textSecondary}
                                />
                            </Pressable>
                            <Pressable
                                onPress={handleMenuPress}
                                style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                                disabled={isUpdating}
                            >
                                <Ionicons
                                    name="ellipsis-vertical"
                                    size={20}
                                    color={isUpdating ? theme.colors.textSecondary : theme.colors.header.tint}
                                />
                            </Pressable>
                        </View>
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
                        <Ionicons name="key" size={48} color={theme.colors.radio.active} />
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

            {/* Action Menu for Android/Web */}
            <ActionMenuModal
                visible={menuVisible}
                items={menuItems}
                onClose={() => setMenuVisible(false)}
            />
        </View>
    );
}
