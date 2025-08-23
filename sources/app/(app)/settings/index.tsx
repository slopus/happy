import { View, ScrollView, Pressable, Platform, Linking, TextInput, Alert } from 'react-native';
import { Image } from 'expo-image';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useAuth } from '@/auth/AuthContext';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useEntitlement, useLocalSettingMutable } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { isUsingCustomServer } from '@/sync/serverConfig';
import { trackPaywallButtonClicked } from '@/track';
import { PaywallResult } from '@/sync/revenueCat';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';

// Manual Auth Modal Component for Android
function ManualAuthModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string) => void }) {
    const { theme } = useUnistyles();
    const [url, setUrl] = React.useState('');

    return (
        <View style={{ padding: 20, backgroundColor: theme.colors.surface, borderRadius: 12, minWidth: 300 }}>
            <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
                Authenticate Terminal
            </Text>
            <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginBottom: 16 }}>
                Paste the authentication URL from your terminal
            </Text>
            <TextInput
                style={{
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 14,
                    marginBottom: 20,
                    color: theme.colors.input.text,
                    backgroundColor: theme.colors.input.background
                }}
                value={url}
                onChangeText={setUrl}
                placeholder="happy://terminal?..."
                placeholderTextColor={theme.colors.input.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Pressable
                    onPress={onClose}
                    style={{ paddingVertical: 8, paddingHorizontal: 16, marginRight: 8 }}
                >
                    <Text style={{ color: '#007AFF', fontSize: 16 }}>Cancel</Text>
                </Pressable>
                <Pressable
                    onPress={() => {
                        if (url.trim()) {
                            onSubmit(url.trim());
                            onClose();
                        }
                    }}
                    style={{ paddingVertical: 8, paddingHorizontal: 16 }}
                >
                    <Text style={{ color: '#007AFF', fontSize: 16, fontWeight: '600' }}>
                        Authenticate
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

export default React.memo(function SettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const isPro = __DEV__ || useEntitlement('pro');
    const isCustomServer = isUsingCustomServer();
    const allMachines = useAllMachines();

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    const handleGitHub = async () => {
        const url = 'https://github.com/slopus/happy';
        const supported = await Linking.canOpenURL(url);
        if (supported) {
            await Linking.openURL(url);
        }
    };

    const handleReportIssue = async () => {
        const url = 'https://github.com/slopus/happy/issues';
        const supported = await Linking.canOpenURL(url);
        if (supported) {
            await Linking.openURL(url);
        }
    };

    const handleSubscribe = async () => {
        trackPaywallButtonClicked();
        const result = await sync.presentPaywall();
        
        switch (result) {
            case PaywallResult.PURCHASED:
                console.log('Purchase successful!');
                break;
            case PaywallResult.RESTORED:
                console.log('Purchases restored!');
                break;
            case PaywallResult.CANCELLED:
                console.log('Purchase cancelled');
                break;
            case PaywallResult.NOT_INITIALIZED:
                console.error('RevenueCat not initialized');
                break;
            case PaywallResult.ERROR:
                console.error('Failed to present paywall');
                break;
            case PaywallResult.NOT_PRESENTED:
                console.log('Paywall not presented');
                break;
        }
    };

    // Use the multi-click hook for version clicks
    const handleVersionClick = useMultiClick(() => {
        // Toggle dev mode
        const newDevMode = !devModeEnabled;
        setDevModeEnabled(newDevMode);
        Modal.alert(
            'Developer Mode',
            newDevMode ? 'Developer mode enabled' : 'Developer mode disabled'
        );
    }, {
        requiredClicks: 10,
        resetTimeout: 2000
    });


    return (

        <ItemList style={{ paddingTop: 0 }}>
            {/* App Info Header */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginTop: 16, borderRadius: 12, marginHorizontal: 16 }}>
                    <Image
                        source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                        contentFit="contain"
                        style={{ width: 300, height: 90, marginBottom: 12 }}
                    />
                    <Pressable onPress={handleVersionClick} hitSlop={20}>
                        <Text style={{ ...Typography.mono(), fontSize: 14, color: theme.colors.textSecondary }}>
                            Version {appVersion}
                        </Text>
                    </Pressable>
                </View>
            </View>

            {/* Connect Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup>
                    <Item
                        title="Scan QR code to authenticate"
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title="Enter URL manually"
                        icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                        onPress={() => {
                            if (Platform.OS === 'ios') {
                                Alert.prompt(
                                    'Authenticate Terminal',
                                    'Paste the authentication URL from your terminal',
                                    [
                                        { text: 'Cancel', style: 'cancel' },
                                        {
                                            text: 'Authenticate',
                                            onPress: (url?: string) => {
                                                if (url?.trim()) {
                                                    connectWithUrl(url.trim());
                                                }
                                            }
                                        }
                                    ],
                                    'plain-text',
                                    '',
                                    'happy://terminal?...'
                                );
                            } else {
                                // For Android, show a custom modal
                                Modal.show({
                                    component: ManualAuthModal,
                                    props: {
                                        onSubmit: (url: string) => {
                                            connectWithUrl(url);
                                        }
                                    }
                                });
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Support Us */}
            <ItemGroup>
                <Item
                    title="Support us"
                    subtitle={isPro ? 'Thank you for your support!' : 'Support project development'}
                    icon={<Ionicons name="heart" size={29} color="#FF3B30" />}
                    showChevron={false}
                    onPress={isPro ? undefined : handleSubscribe}
                />
            </ItemGroup>

            {/* Machines */}
            {allMachines.length > 0 && (
                <ItemGroup title="Machines">
                    {allMachines.map((machine) => {
                        const isOnline = isMachineOnline(machine);
                        const host = machine.metadata?.host || 'Unknown';
                        const displayName = machine.metadata?.displayName;
                        const platform = machine.metadata?.platform || '';

                        // Use displayName if available, otherwise use host
                        const title = displayName || host;

                        // Build subtitle: show hostname if different from title, plus platform and status
                        let subtitle = '';
                        if (displayName && displayName !== host) {
                            subtitle = host;
                        }
                        if (platform) {
                            subtitle = subtitle ? `${subtitle} • ${platform}` : platform;
                        }
                        subtitle = subtitle ? `${subtitle} • ${isOnline ? 'Online' : 'Offline'}` : (isOnline ? 'Online' : 'Offline');

                        return (
                            <Item
                                key={machine.id}
                                title={title}
                                subtitle={subtitle}
                                icon={
                                    <Ionicons
                                        name="desktop-outline"
                                        size={29}
                                        color={isOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
                                    />
                                }
                                onPress={() => router.push(`/machine/${machine.id}`)}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {/* Features */}
            <ItemGroup title="Features">
                <Item
                    title="Account"
                    subtitle="Manage your account details"
                    icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/account')}
                />
                <Item
                    title="Appearance"
                    subtitle="Customize how the app looks"
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title="Features"
                    subtitle="Enable or disable app features"
                    icon={<Ionicons name="flask-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/settings/features')}
                />
            </ItemGroup>

            {/* Developer */}
            {(__DEV__ || devModeEnabled) && (
                <ItemGroup title="Developer">
                    <Item
                        title="Developer Tools"
                        icon={<Ionicons name="construct-outline" size={29} color="#5856D6" />}
                        onPress={() => router.push('/dev')}
                    />
                </ItemGroup>
            )}

            {/* About */}
            <ItemGroup title="About" footer="Happy Coder is a Claude Code mobile client. It's fully end-to-end encrypted and your account is stored only on your device. Not affiliated with Anthropic.">
                <Item
                    title="GitHub"
                    icon={<Ionicons name="logo-github" size={29} color={theme.colors.text} />}
                    detail="slopus/happy"
                    onPress={handleGitHub}
                />
                <Item
                    title="Report an Issue"
                    icon={<Ionicons name="bug-outline" size={29} color="#FF3B30" />}
                    onPress={handleReportIssue}
                />
                <Item
                    title="Privacy Policy"
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#007AFF" />}
                    onPress={async () => {
                        const url = 'https://happy.engineering/privacy/';
                        const supported = await Linking.canOpenURL(url);
                        if (supported) {
                            await Linking.openURL(url);
                        }
                    }}
                />
                <Item
                    title="Terms of Service"
                    icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                    onPress={async () => {
                        const url = 'https://github.com/slopus/happy/blob/main/TERMS.md';
                        const supported = await Linking.canOpenURL(url);
                        if (supported) {
                            await Linking.openURL(url);
                        }
                    }}
                />
                {Platform.OS === 'ios' && (
                    <Item
                        title="EULA"
                        icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const url = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
                            const supported = await Linking.canOpenURL(url);
                            if (supported) {
                                await Linking.openURL(url);
                            }
                        }}
                    />
                )}
            </ItemGroup>

        </ItemList>
    );
});