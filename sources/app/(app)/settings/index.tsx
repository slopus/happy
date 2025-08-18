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
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { PlusPlus } from '@/components/PlusPlus';

// Manual Auth Modal Component for Android
function ManualAuthModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string) => void }) {
    const [url, setUrl] = React.useState('');
    
    return (
        <View style={{ padding: 20, backgroundColor: 'white', borderRadius: 12, minWidth: 300 }}>
            <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
                Authenticate Terminal
            </Text>
            <Text style={{ fontSize: 14, color: '#666', marginBottom: 16 }}>
                Paste the authentication URL from your terminal
            </Text>
            <TextInput
                style={{
                    borderWidth: 1,
                    borderColor: '#ddd',
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 14,
                    marginBottom: 20
                }}
                value={url}
                onChangeText={setUrl}
                placeholder="happy://terminal?..."
                placeholderTextColor="#999"
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

export default function SettingsScreen() {
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const isPro = __DEV__ || useEntitlement('pro');
    const isCustomServer = isUsingCustomServer();

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
        if (!result.success) {
            console.error('Failed to present paywall:', result.error);
        } else if (result.purchased) {
            console.log('Purchase successful!');
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
            <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: 'white' }}>
                <Image
                    source={require('@/assets/images/logotype-dark.png')}
                    contentFit="contain"
                    style={{ width: 300, height: 90, marginBottom: 12 }}
                />
                <Pressable onPress={handleVersionClick} hitSlop={20}>
                    <Text style={{ ...Typography.mono(), fontSize: 14, color: '#8E8E93' }}>
                        Version {appVersion}
                    </Text>
                </Pressable>
            </View>

            {/* Connect Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup title="Connect Terminal">
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

            {/* Features */}
            <ItemGroup title="Features">
                <Item
                    title="Features"
                    subtitle="Enable or disable app features"
                    icon={<Ionicons name="flask-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/settings/features')}
                />
                <Item
                    title="Appearance"
                    subtitle="Customize how the app looks"
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title="Account"
                    subtitle="Manage your account details"
                    icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/account')}
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
                    icon={<Ionicons name="logo-github" size={29} color="#000" />}
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
}