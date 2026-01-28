/**
 * Moltbot New Session Page
 *
 * Create a new Moltbot session on a specific machine.
 * Allows user to configure session parameters before starting.
 */

import React from 'react';
import {
    View,
    Text,
    TextInput,
    ScrollView,
    Pressable,
    ActivityIndicator,
    Alert,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useMoltbotConnection } from '@/moltbot/connection';
import { useMoltbotMachine } from '@/sync/storage';

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
    inputContainer: {
        marginHorizontal: 16,
        marginTop: 8,
    },
    input: {
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default(),
        minHeight: 100,
        textAlignVertical: 'top',
    },
    singleLineInput: {
        minHeight: 44,
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        marginHorizontal: 16,
        marginTop: 24,
        paddingVertical: 14,
        borderRadius: 8,
        alignItems: 'center',
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    statusContainer: {
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
    statusConnected: {
        backgroundColor: 'rgba(52, 199, 89, 0.15)',
    },
    statusConnecting: {
        backgroundColor: 'rgba(255, 159, 10, 0.15)',
    },
    statusError: {
        backgroundColor: 'rgba(255, 59, 48, 0.15)',
    },
    statusText: {
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    sessionTypeOption: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    sessionTypeIcon: {
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkmark: {
        marginLeft: 'auto',
    },
}));

type SessionKind = 'direct' | 'group' | 'global';

export default function MoltbotNewSessionPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { machineId } = useLocalSearchParams<{ machineId: string }>();

    // Get machine data
    const machine = useMoltbotMachine(machineId ?? '');

    // Connection hook
    const {
        status,
        isConnected,
        isConnecting,
        error,
        send,
        connect,
    } = useMoltbotConnection(machineId ?? '', {
        autoConnect: true,
    });

    // Form state
    const [sessionName, setSessionName] = React.useState('');
    const [sessionKind, setSessionKind] = React.useState<SessionKind>('direct');
    const [initialMessage, setInitialMessage] = React.useState('');
    const [isCreating, setIsCreating] = React.useState(false);

    const canCreate = isConnected && !isCreating;

    const handleCreate = React.useCallback(async () => {
        if (!canCreate) return;

        setIsCreating(true);

        try {
            // Create session via gateway
            const result = await send('sessions.create', {
                kind: sessionKind,
                label: sessionName.trim() || undefined,
                initialMessage: initialMessage.trim() || undefined,
            });

            if (result.ok && result.payload) {
                const session = result.payload as { key: string };

                // Navigate to the new chat
                router.replace({
                    pathname: '/moltbot/chat',
                    params: {
                        machineId: machineId,
                        sessionKey: session.key,
                    },
                });
            } else {
                Alert.alert(
                    t('common.error'),
                    (result.error as { message?: string })?.message || 'Failed to create session'
                );
            }
        } catch (err) {
            console.error('Failed to create session:', err);
            Alert.alert(
                t('common.error'),
                err instanceof Error ? err.message : 'Failed to create session'
            );
        } finally {
            setIsCreating(false);
        }
    }, [canCreate, send, sessionKind, sessionName, initialMessage, machineId, router]);

    // Get header title
    const machineName = machine?.metadata?.name || t('moltbot.unknownMachine');

    // Get status config
    const getStatusConfig = () => {
        switch (status) {
            case 'connected':
                return {
                    style: styles.statusConnected,
                    color: theme.colors.status.connected,
                    text: t('status.connected'),
                    icon: 'checkmark-circle' as const,
                };
            case 'connecting':
                return {
                    style: styles.statusConnecting,
                    color: theme.colors.status.connecting,
                    text: t('status.connecting'),
                    icon: 'sync' as const,
                };
            default:
                return {
                    style: styles.statusError,
                    color: theme.colors.status.disconnected,
                    text: error || t('status.disconnected'),
                    icon: 'alert-circle' as const,
                };
        }
    };

    const statusConfig = getStatusConfig();

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    headerTitle: t('moltbot.newSession'),
                }}
            />
            <ScrollView
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingBottom: safeArea.bottom + 24 },
                ]}
            >
                {/* Connection Status */}
                <View style={[styles.statusContainer, statusConfig.style]}>
                    {isConnecting ? (
                        <ActivityIndicator size="small" color={statusConfig.color} />
                    ) : (
                        <Ionicons name={statusConfig.icon} size={20} color={statusConfig.color} />
                    )}
                    <Text style={[styles.statusText, { color: statusConfig.color }]}>
                        {machineName} - {statusConfig.text}
                    </Text>
                </View>

                {/* Session Name (Optional) */}
                <ItemGroup title={`${t('moltbot.sessionName')} (${t('common.optional')})`}>
                    <View style={styles.inputContainer}>
                        <TextInput
                            style={[styles.input, styles.singleLineInput, { borderWidth: 1, borderColor: theme.colors.divider }]}
                            value={sessionName}
                            onChangeText={setSessionName}
                            placeholder="My Chat Session"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="words"
                            autoCorrect={false}
                            editable={isConnected}
                        />
                    </View>
                </ItemGroup>

                {/* Session Type */}
                <ItemGroup title={t('moltbot.sessionType')}>
                    <Item
                        title={t('moltbot.sessionTypeDirect')}
                        subtitle={t('moltbot.sessionTypeDirectDescription')}
                        subtitleLines={2}
                        leftElement={
                            <View style={[styles.sessionTypeIcon, { backgroundColor: theme.colors.surfacePressed }]}>
                                <Ionicons name="chatbubble" size={18} color={theme.colors.textSecondary} />
                            </View>
                        }
                        rightElement={sessionKind === 'direct' ? (
                            <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} style={styles.checkmark} />
                        ) : null}
                        onPress={() => setSessionKind('direct')}
                    />
                    <Item
                        title={t('moltbot.sessionTypeGlobal')}
                        subtitle={t('moltbot.sessionTypeGlobalDescription')}
                        subtitleLines={2}
                        leftElement={
                            <View style={[styles.sessionTypeIcon, { backgroundColor: theme.colors.surfacePressed }]}>
                                <Ionicons name="globe" size={18} color={theme.colors.textSecondary} />
                            </View>
                        }
                        rightElement={sessionKind === 'global' ? (
                            <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} style={styles.checkmark} />
                        ) : null}
                        onPress={() => setSessionKind('global')}
                    />
                </ItemGroup>

                {/* Initial Message (Optional) */}
                <ItemGroup title={`${t('moltbot.initialMessage')} (${t('common.optional')})`}>
                    <View style={styles.inputContainer}>
                        <TextInput
                            style={[styles.input, { borderWidth: 1, borderColor: theme.colors.divider }]}
                            value={initialMessage}
                            onChangeText={setInitialMessage}
                            placeholder={t('moltbot.initialMessagePlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            multiline
                            autoCapitalize="sentences"
                            autoCorrect
                            editable={isConnected}
                        />
                    </View>
                </ItemGroup>

                {/* Create Button */}
                <Pressable
                    style={[styles.submitButton, !canCreate && styles.submitButtonDisabled]}
                    onPress={handleCreate}
                    disabled={!canCreate}
                >
                    {isCreating ? (
                        <ActivityIndicator color="#FFFFFF" />
                    ) : (
                        <Text style={styles.submitButtonText}>{t('moltbot.createSession')}</Text>
                    )}
                </Pressable>
            </ScrollView>
        </View>
    );
}
