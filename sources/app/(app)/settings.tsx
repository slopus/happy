import { View, ScrollView, Pressable, Platform, Image, Alert, Linking } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useAuth } from '@/auth/AuthContext';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { ConnectButton } from '@/components/ConnectButton';

export default function SettingsScreen() {
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const isDev = __DEV__;

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


    return (
        <View style={{ flex: 1, backgroundColor: '#F2F2F7' }}>
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 8,
                paddingTop: Platform.OS === 'ios' ? 10 : 20,
                paddingBottom: 10,
                backgroundColor: 'white',
            }}>
                <Text style={{ fontSize: 18, fontWeight: '600', flex: 1, textAlign: 'center' }}>Settings</Text>
                <Pressable
                    onPress={() => router.back()}
                    style={{ padding: 8, position: 'absolute', right: 8 }}
                >
                    <Ionicons name="close" size={24} color="#000" />
                </Pressable>
            </View>

            <ItemList style={{ paddingTop: 0 }}>
                {/* App Info Header */}
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: 'white', marginBottom: 35 }}>
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

                {/* Connection */}
                <ItemGroup>
                    <Item 
                        title="Connect Terminal"
                        subtitle="Scan QR code to connect Claude Code"
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        rightElement={<ConnectButton />}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Account */}
                <ItemGroup title="Account">
                    <Item 
                        title="Account Details"
                        icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push('/account')}
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
        </View>
    );
}