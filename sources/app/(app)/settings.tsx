import { View, ScrollView, Pressable, Platform, Image, Alert, Linking, TextInput } from 'react-native';
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
import { OpenAIKeyStorage } from '@/auth/openAIKeyStorage';
import { useState, useEffect } from 'react';

export default function SettingsScreen() {
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const isDev = __DEV__;
    const [openAIKey, setOpenAIKey] = useState('');
    const [isEditingAPIKey, setIsEditingAPIKey] = useState(false);
    const [isSavingAPIKey, setIsSavingAPIKey] = useState(false);
    
    useEffect(() => {
        // Load saved API key on mount
        OpenAIKeyStorage.getAPIKey().then(key => {
            if (key) {
                setOpenAIKey(key);
            }
        });
    }, []);

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
    
    const handleSaveAPIKey = async () => {
        setIsSavingAPIKey(true);
        try {
            if (openAIKey.trim()) {
                await OpenAIKeyStorage.setAPIKey(openAIKey.trim());
                Alert.alert('Success', 'OpenAI API key saved successfully');
            } else {
                await OpenAIKeyStorage.removeAPIKey();
                Alert.alert('Success', 'OpenAI API key removed');
            }
            setIsEditingAPIKey(false);
        } catch (error) {
            Alert.alert('Error', 'Failed to save API key');
        } finally {
            setIsSavingAPIKey(false);
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
                <ItemGroup title="Connection">
                    <Item 
                        title="Connect Terminal"
                        subtitle="Scan QR code to connect Claude Code"
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push('/connect')}
                    />
                </ItemGroup>
                
                {/* Voice Settings */}
                <ItemGroup title="Voice Assistant">
                    <Item 
                        title="OpenAI API Key"
                        subtitle={openAIKey ? "Key configured" : "Required for voice control"}
                        icon={<Ionicons name="key-outline" size={29} color="#34C759" />}
                        detail={isEditingAPIKey ? undefined : (openAIKey ? "•••••" + openAIKey.slice(-4) : "Not set")}
                        rightElement={isEditingAPIKey ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <TextInput
                                    style={{
                                        backgroundColor: '#F2F2F7',
                                        borderRadius: 8,
                                        padding: 8,
                                        width: 200,
                                        fontSize: 14,
                                    }}
                                    value={openAIKey}
                                    onChangeText={setOpenAIKey}
                                    placeholder="sk-..."
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    secureTextEntry={!isEditingAPIKey}
                                />
                                <Pressable 
                                    onPress={handleSaveAPIKey}
                                    disabled={isSavingAPIKey}
                                    style={{ padding: 8 }}
                                >
                                    <Text style={{ color: '#007AFF', fontSize: 16, fontWeight: '600' }}>
                                        {isSavingAPIKey ? 'Saving...' : 'Save'}
                                    </Text>
                                </Pressable>
                                <Pressable 
                                    onPress={() => {
                                        setIsEditingAPIKey(false);
                                        // Restore original value
                                        OpenAIKeyStorage.getAPIKey().then(key => {
                                            setOpenAIKey(key || '');
                                        });
                                    }}
                                    style={{ padding: 8 }}
                                >
                                    <Text style={{ color: '#8E8E93', fontSize: 16 }}>Cancel</Text>
                                </Pressable>
                            </View>
                        ) : undefined}
                        onPress={!isEditingAPIKey ? () => setIsEditingAPIKey(true) : undefined}
                        showChevron={!isEditingAPIKey}
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