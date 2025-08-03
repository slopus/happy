import { View, ScrollView, Pressable, Platform, Image, Linking } from 'react-native';
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
import { useEntitlement } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { trackPaywallButtonClicked } from '@/track';

export default function SettingsScreen() {
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const isDev = __DEV__;
    const isPro = useEntitlement('pro');

    const { connectTerminal, isLoading } = useConnectTerminal();

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


    return (

        <ItemList style={{ paddingTop: 0 }}>
            {/* App Info Header */}
            <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: 'white' }}>
                <Image
                    source={require('@/assets/images/happy-otter-2.png')}
                    style={{ width: 100, height: 70, marginBottom: 12 }}
                />
                <Text style={{ ...Typography.logo(), fontSize: 24, fontWeight: 'bold', marginBottom: 4 }}>
                    Happy Coder
                </Text>
                <Text style={{ ...Typography.mono(), fontSize: 14, color: '#8E8E93' }}>
                    Version {appVersion}
                </Text>
            </View>

            {/* Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup>
                    <Item
                        title="Connect Terminal"
                        subtitle="Scan QR code to connect Claude Code"
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Support Us */}
            <ItemGroup>
                <Item
                    title="Support us"
                    subtitle={isPro ? 'Thank you for your support!' : '$20/month'}
                    icon={<Ionicons name="heart" size={29} color="#FF3B30" />}
                    showChevron={false}
                    onPress={isPro ? undefined : handleSubscribe}
                    detail={isPro ? '✓' : undefined}
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
            {isDev && (
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
            </ItemGroup>
        </ItemList>
    );
}