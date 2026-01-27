import * as React from 'react';
import { View, TextInput, Platform } from 'react-native';
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
import { ClawdbotSocket, useClawdbotStatus } from '@/clawdbot';
import { saveClawdbotConfig, loadClawdbotConfig, clearClawdbotConfig } from '@/clawdbot';
import { useHappyAction } from '@/hooks/useHappyAction';

export default React.memo(function ClawdbotConnectScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { status, isConnected, isPairingRequired, deviceId, serverHost, retryConnect } = useClawdbotStatus();

    // Load saved config on mount
    const savedConfig = React.useMemo(() => loadClawdbotConfig(), []);
    const [url, setUrl] = React.useState(savedConfig?.url ?? 'ws://127.0.0.1:18789');
    const [token, setToken] = React.useState(savedConfig?.token ?? '');
    const [password, setPassword] = React.useState(savedConfig?.password ?? '');

    const [isConnecting, doConnect] = useHappyAction(React.useCallback(async () => {
        const config = {
            url: url.trim(),
            token: token.trim() || undefined,
            password: password.trim() || undefined,
        };
        saveClawdbotConfig(config);
        ClawdbotSocket.connect(config);

        // Wait a bit for connection
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (ClawdbotSocket.isConnected()) {
            router.back();
        }
    }, [url, token, password, router]));

    const handleDisconnect = React.useCallback(() => {
        ClawdbotSocket.disconnect();
        clearClawdbotConfig();
    }, []);

    // If already connected, show connected state
    if (isConnected) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons
                            name="checkmark-circle"
                            size={64}
                            color="#34C759"
                            style={{ marginBottom: 16 }}
                        />
                        <Text style={{
                            ...Typography.default('semiBold'),
                            fontSize: 18,
                            textAlign: 'center',
                            marginBottom: 8,
                            color: theme.colors.text,
                        }}>
                            {t('clawdbot.connected')}
                        </Text>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                        }}>
                            {serverHost ?? url}
                        </Text>
                    </View>
                </ItemGroup>

                <ItemGroup>
                    <View style={{
                        paddingHorizontal: 16,
                        paddingVertical: 16,
                        gap: 12
                    }}>
                        <RoundButton
                            title={t('clawdbot.viewSessions')}
                            onPress={() => router.replace('/(app)/clawdbot')}
                            size="large"
                        />
                        <RoundButton
                            title={t('clawdbot.disconnect')}
                            onPress={handleDisconnect}
                            size="large"
                            display="inverted"
                        />
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    // Show pairing required UI
    if (isPairingRequired) {
        const shortDeviceId = deviceId ? `${deviceId.slice(0, 8)}...${deviceId.slice(-8)}` : '';
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons
                            name="hand-left-outline"
                            size={64}
                            color="#FF9500"
                            style={{ marginBottom: 16 }}
                        />
                        <Text style={{
                            ...Typography.default('semiBold'),
                            fontSize: 20,
                            textAlign: 'center',
                            marginBottom: 12,
                            color: theme.colors.text,
                        }}>
                            {t('clawdbot.pairingRequired')}
                        </Text>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            lineHeight: 20,
                            marginBottom: 16,
                        }}>
                            {t('clawdbot.pairingDescription')}
                        </Text>
                    </View>
                </ItemGroup>

                {/* Instructions */}
                <ItemGroup title={t('clawdbot.pairingInstructions')}>
                    <Item
                        title={t('clawdbot.pairingStep1Title')}
                        subtitle={t('clawdbot.pairingStep1Description')}
                        icon={<Text style={{ fontSize: 20, color: theme.colors.button.primary.background }}>1</Text>}
                        showChevron={false}
                    />
                    <Item
                        title={t('clawdbot.pairingStep2Title')}
                        subtitle={t('clawdbot.pairingStep2Description')}
                        icon={<Text style={{ fontSize: 20, color: theme.colors.button.primary.background }}>2</Text>}
                        showChevron={false}
                    />
                    <Item
                        title={t('clawdbot.pairingStep3Title')}
                        subtitle={t('clawdbot.pairingStep3Description')}
                        icon={<Text style={{ fontSize: 20, color: theme.colors.button.primary.background }}>3</Text>}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Device ID for reference */}
                {deviceId && (
                    <ItemGroup title={t('clawdbot.deviceInfo')}>
                        <Item
                            title={t('clawdbot.deviceId')}
                            subtitle={shortDeviceId}
                            icon={<Ionicons name="finger-print-outline" size={29} color={theme.colors.textSecondary} />}
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

                {/* Retry Button */}
                <ItemGroup>
                    <View style={{
                        paddingHorizontal: 16,
                        paddingVertical: 16,
                        gap: 12
                    }}>
                        <RoundButton
                            title={t('clawdbot.retryConnection')}
                            onPress={retryConnect}
                            size="large"
                        />
                        <RoundButton
                            title={t('common.cancel')}
                            onPress={handleDisconnect}
                            size="large"
                            display="inverted"
                        />
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList>
            {/* Header */}
            <ItemGroup>
                <View style={{
                    alignItems: 'center',
                    paddingVertical: 24,
                    paddingHorizontal: 16
                }}>
                    <Ionicons
                        name="link-outline"
                        size={48}
                        color={theme.colors.button.primary.background}
                        style={{ marginBottom: 16 }}
                    />
                    <Text style={{
                        ...Typography.default('semiBold'),
                        fontSize: 20,
                        textAlign: 'center',
                        marginBottom: 12,
                        color: theme.colors.text,
                    }}>
                        {t('clawdbot.connectTitle')}
                    </Text>
                    <Text style={{
                        ...Typography.default(),
                        fontSize: 14,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        lineHeight: 20
                    }}>
                        {t('clawdbot.connectDescription')}
                    </Text>
                </View>
            </ItemGroup>

            {/* Connection Settings */}
            <ItemGroup title={t('clawdbot.connectionSettings')}>
                <Item
                    title={t('clawdbot.gatewayUrl')}
                    showChevron={false}
                    icon={<Ionicons name="server-outline" size={29} color={theme.colors.button.primary.background} />}
                />
                <View style={{
                    paddingHorizontal: 16,
                    paddingBottom: 12,
                }}>
                    <TextInput
                        value={url}
                        onChangeText={setUrl}
                        placeholder="ws://127.0.0.1:18789"
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        style={{
                            ...Typography.default(),
                            fontSize: 16,
                            color: theme.colors.text,
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 8,
                            paddingHorizontal: 12,
                            paddingVertical: Platform.OS === 'ios' ? 12 : 8,
                        }}
                    />
                </View>

                <Item
                    title={t('clawdbot.token')}
                    subtitle={t('clawdbot.tokenDescription')}
                    showChevron={false}
                    icon={<Ionicons name="key-outline" size={29} color={theme.colors.button.primary.background} />}
                />
                <View style={{
                    paddingHorizontal: 16,
                    paddingBottom: 12,
                }}>
                    <TextInput
                        value={token}
                        onChangeText={setToken}
                        placeholder={t('clawdbot.tokenPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                        style={{
                            ...Typography.default(),
                            fontSize: 16,
                            color: theme.colors.text,
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 8,
                            paddingHorizontal: 12,
                            paddingVertical: Platform.OS === 'ios' ? 12 : 8,
                        }}
                    />
                </View>
            </ItemGroup>

            {/* Token Command Help */}
            <ItemGroup title={t('clawdbot.tokenCommand')}>
                <View style={{
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                }}>
                    <Text style={{
                        ...Typography.default(),
                        fontSize: 13,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                    }}>
                        {t('clawdbot.tokenCommandHint')}
                    </Text>
                    <View style={{
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                    }}>
                        <Text style={{
                            ...Typography.mono(),
                            fontSize: 14,
                            color: theme.colors.text,
                        }}>
                            {t('clawdbot.tokenCommandValue')}
                        </Text>
                    </View>
                    <Text style={{
                        ...Typography.default(),
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginTop: 8,
                        lineHeight: 18,
                    }}>
                        {t('clawdbot.tokenCommandDescription')}
                    </Text>
                </View>
            </ItemGroup>

            {/* Status */}
            {status === 'error' && (
                <ItemGroup>
                    <Item
                        title={t('clawdbot.connectionFailed')}
                        subtitle={t('clawdbot.checkSettings')}
                        icon={<Ionicons name="warning-outline" size={29} color="#FF3B30" />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Connect Button */}
            <ItemGroup>
                <View style={{
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    gap: 12
                }}>
                    <RoundButton
                        title={isConnecting || status === 'connecting' ? t('clawdbot.connecting') : t('clawdbot.connect')}
                        onPress={doConnect}
                        size="large"
                        disabled={isConnecting || status === 'connecting' || !url.trim()}
                        loading={isConnecting || status === 'connecting'}
                    />
                </View>
            </ItemGroup>

            {/* Info */}
            <ItemGroup
                footer={t('clawdbot.connectFooter')}
            >
                <Item
                    title={t('clawdbot.localConnection')}
                    subtitle={t('clawdbot.localConnectionDescription')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
