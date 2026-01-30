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
    ScrollView,
    Pressable,
    Platform,
    useWindowDimensions,
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
    inputWrapper: {
        backgroundColor: theme.colors.surface,
        borderRadius: 10,
        overflow: 'hidden',
    },
    input: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default(),
        minHeight: 100,
        textAlignVertical: 'top',
    },
    singleLineInput: {
        minHeight: 44,
    },
    typeIcon: {
        width: 28,
        height: 28,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        marginHorizontal: 16,
        marginTop: 24,
        paddingVertical: 14,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        height: 50,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: '#FFFFFF',
        fontSize: 17,
        ...Typography.default('semiBold'),
    },
}));

type SessionKind = 'direct' | 'group' | 'global';

// Header button width constants
const HEADER_BUTTON_WIDTH = 40; // 24px icon + 16px padding
const HEADER_PADDING = Platform.OS === 'ios' ? 16 : 32; // 8*2 or 16*2
const HEADER_CENTER_PADDING = 24; // 12*2 for centerContainer

export default function MoltbotNewSessionPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { machineId } = useLocalSearchParams<{ machineId: string }>();
    const { width: screenWidth } = useWindowDimensions();

    // Left: back button (1), Right: placeholder (1) - use larger side * 2 for symmetry
    const headerTitleMaxWidth = screenWidth - (HEADER_BUTTON_WIDTH * 2) - HEADER_PADDING - HEADER_CENTER_PADDING;

    // Connection hook
    const {
        status,
        isConnected,
        isConnecting,
    } = useMoltbotConnection(machineId ?? '', {
        autoConnect: true,
    });

    // Form state
    const [sessionKind, setSessionKind] = React.useState<SessionKind>('direct');

    const canCreate = isConnected;

    const handleCreate = React.useCallback(() => {
        if (!canCreate) return;

        // Moltbot creates sessions on-demand when first message is sent.
        // The session key determines the session type:
        // - 'direct': main DM session (shared across channels)
        // - 'global': global scope session
        const sessionKey = sessionKind === 'direct' ? 'direct' : 'global';

        // Navigate to the chat page - session will be created when first message is sent
        router.replace({
            pathname: '/moltbot/chat',
            params: {
                machineId: machineId,
                sessionKey: sessionKey,
            },
        });
    }, [canCreate, sessionKind, machineId, router]);

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
            default:
                return {
                    color: theme.colors.status.disconnected,
                    text: t('status.disconnected'),
                };
        }
    };

    const statusConfig = getStatusConfig();

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    headerLeft: () => (
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
                    ),
                    headerTitle: () => (
                        <View style={{ alignItems: 'center', justifyContent: 'center', maxWidth: headerTitleMaxWidth }}>
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={[Typography.default('semiBold'), { fontSize: 17, lineHeight: 24, color: theme.colors.header.tint, flexShrink: 1 }]}
                            >
                                {t('moltbot.newSession')}
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
                    headerRight: () => <View style={{ width: 24, height: 24 }} />,
                }}
            />
            <ScrollView
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingBottom: safeArea.bottom + 24 },
                ]}
            >
                {/* Session Type */}
                <ItemGroup title={t('moltbot.sessionType')}>
                    <Item
                        title={t('moltbot.sessionTypeDirect')}
                        subtitle={t('moltbot.sessionTypeDirectDescription')}
                        subtitleLines={2}
                        leftElement={
                            <View style={[styles.typeIcon, { backgroundColor: theme.colors.status.connected + '20' }]}>
                                <Ionicons name="chatbubble" size={16} color={theme.colors.status.connected} />
                            </View>
                        }
                        rightElement={sessionKind === 'direct' ? (
                            <Ionicons name="checkmark-circle" size={24} color={theme.colors.status.connected} />
                        ) : (
                            <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: theme.colors.divider }} />
                        )}
                        onPress={() => setSessionKind('direct')}
                        showChevron={false}
                    />
                    <Item
                        title={t('moltbot.sessionTypeGlobal')}
                        subtitle={t('moltbot.sessionTypeGlobalDescription')}
                        subtitleLines={2}
                        leftElement={
                            <View style={[styles.typeIcon, { backgroundColor: theme.colors.surfacePressed }]}>
                                <Ionicons name="globe" size={16} color={theme.colors.text} />
                            </View>
                        }
                        rightElement={sessionKind === 'global' ? (
                            <Ionicons name="checkmark-circle" size={24} color={theme.colors.status.connected} />
                        ) : (
                            <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: theme.colors.divider }} />
                        )}
                        onPress={() => setSessionKind('global')}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Create Button */}
                <Pressable
                    style={[styles.submitButton, !canCreate && styles.submitButtonDisabled]}
                    onPress={handleCreate}
                    disabled={!canCreate}
                >
                    <Text style={styles.submitButtonText}>{t('moltbot.createSession')}</Text>
                </Pressable>
            </ScrollView>
        </View>
    );
}
