import * as React from 'react';
import { View, RefreshControl } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { Ionicons } from '@expo/vector-icons';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { useClawdbotStatus, useClawdbotSessions, ClawdbotSocket } from '@/clawdbot';
import type { ClawdbotSession } from '@/clawdbot';

export default React.memo(function ClawdbotSessionsScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { isConnected, serverHost } = useClawdbotStatus();
    const { sessions, loading, error, refresh } = useClawdbotSessions();

    // Not connected - show connect prompt
    if (!isConnected) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons
                            name="cloud-offline-outline"
                            size={64}
                            color={theme.colors.textSecondary}
                            style={{ marginBottom: 16 }}
                        />
                        <Text style={{
                            ...Typography.default('semiBold'),
                            fontSize: 18,
                            textAlign: 'center',
                            marginBottom: 8,
                            color: theme.colors.text,
                        }}>
                            {t('clawdbot.notConnected')}
                        </Text>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            lineHeight: 20
                        }}>
                            {t('clawdbot.notConnectedDescription')}
                        </Text>
                    </View>
                </ItemGroup>

                <ItemGroup>
                    <View style={{
                        paddingHorizontal: 16,
                        paddingVertical: 16
                    }}>
                        <RoundButton
                            title={t('clawdbot.connectToGateway')}
                            onPress={() => router.push('/(app)/clawdbot/connect')}
                            size="large"
                        />
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    const handleSessionPress = (session: ClawdbotSession) => {
        router.push({
            pathname: '/(app)/clawdbot/chat/[sessionKey]',
            params: { sessionKey: session.key }
        });
    };

    const handleNewChat = () => {
        router.push('/(app)/clawdbot/new');
    };

    return (
        <ItemList
            refreshControl={
                <RefreshControl
                    refreshing={loading}
                    onRefresh={refresh}
                    tintColor={theme.colors.button.primary.background}
                />
            }
        >
            {/* Connection Status */}
            <ItemGroup>
                <Item
                    title={t('clawdbot.connectedTo')}
                    detail={serverHost ?? t('status.unknown')}
                    icon={<Ionicons name="checkmark-circle" size={29} color="#34C759" />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* New Chat Button */}
            <ItemGroup>
                <View style={{
                    paddingHorizontal: 16,
                    paddingVertical: 12
                }}>
                    <RoundButton
                        title={t('clawdbot.newChat')}
                        onPress={handleNewChat}
                        size="large"
                    />
                </View>
            </ItemGroup>

            {/* Error State */}
            {error && (
                <ItemGroup>
                    <Item
                        title={t('common.error')}
                        subtitle={error}
                        icon={<Ionicons name="warning-outline" size={29} color="#FF3B30" />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Sessions List */}
            {sessions.length > 0 && (
                <ItemGroup title={t('clawdbot.recentSessions')}>
                    {sessions.map((session) => (
                        <Item
                            key={session.key}
                            title={session.displayName || session.label || session.key}
                            subtitle={formatSessionSubtitle(session)}
                            icon={<Ionicons name="chatbubble-outline" size={29} color={theme.colors.button.primary.background} />}
                            onPress={() => handleSessionPress(session)}
                        />
                    ))}
                </ItemGroup>
            )}

            {/* Empty State */}
            {!loading && !error && sessions.length === 0 && (
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 24,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons
                            name="chatbubbles-outline"
                            size={48}
                            color={theme.colors.textSecondary}
                            style={{ marginBottom: 12 }}
                        />
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                        }}>
                            {t('clawdbot.noSessions')}
                        </Text>
                    </View>
                </ItemGroup>
            )}

            {/* Settings Link */}
            <ItemGroup>
                <Item
                    title={t('clawdbot.connectionSettings')}
                    icon={<Ionicons name="settings-outline" size={29} color={theme.colors.button.primary.background} />}
                    onPress={() => router.push('/(app)/clawdbot/connect')}
                />
            </ItemGroup>
        </ItemList>
    );
});

function formatSessionSubtitle(session: ClawdbotSession): string {
    const parts: string[] = [];

    // Show kind/surface info
    if (session.surface) {
        parts.push(session.surface);
    } else if (session.kind && session.kind !== 'unknown') {
        parts.push(session.kind);
    }

    // Show token count if available
    if (session.totalTokens !== undefined && session.totalTokens > 0) {
        parts.push(`${session.totalTokens.toLocaleString()} tokens`);
    }

    // Show last update time
    if (session.updatedAt) {
        const date = new Date(session.updatedAt);
        parts.push(date.toLocaleDateString());
    }

    return parts.join(' • ') || session.key;
}
