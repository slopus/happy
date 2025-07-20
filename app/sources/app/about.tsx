import { View, ScrollView, Pressable, Platform, Image } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { RoundButton } from '@/components/RoundButton';
import { useAuth } from '@/auth/AuthContext';
import { ConnectButton } from '@/components/ConnectButton';
import { Typography } from "@/constants/Typography";

export default function AboutModal() {
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();

    return (
        <View style={{ flex: 1, backgroundColor: 'white' }}>
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 8,
                position: 'absolute',
                top: 10,
                left: 0,
                right: 0,
                zIndex: 1000,
            }}>
                <Text style={{ fontSize: 18, fontWeight: '600' }}></Text>
                <Pressable
                    onPress={() => router.back()}
                    style={{ padding: 8 }}
                >
                    <Ionicons name="close" size={24} color="#000" />
                </Pressable>
            </View>

            <ScrollView style={{ flex: 1, padding: 16, paddingTop: 32 }}>
                <View style={{ alignItems: 'center', marginBottom: 32 }}>
                    <Image source={require('../assets/images/happy-otter-2.png')} style={{ width: 200, height: 140, marginBottom: 16, marginTop: 16 }} />
                    <Text style={{ ...Typography.logo(), fontSize: 24, fontWeight: 'bold', marginBottom: 8 }}>Happy Coder</Text>
                    <Text style={{ ...Typography.mono(), fontSize: 14, color: '#666' }}>{appVersion}</Text>
                    <View style={{ alignItems: 'center', paddingBottom: 32, marginTop: 16, width: '80%' }}>
                    <Text style={{ fontSize: 16, color: '#666', textAlign: 'center' }}>Happy Code is a Claude Code mobile client.
                        It's fully end-to-end encrypted and your account is stored only on your device.
                        {'\n'}{'\n'}
                        It's not affiliated with Anthropic.</Text>
                    </View>
                </View>

                {/* <View style={{ marginBottom: 12, alignSelf: 'center' }}>
                    <ConnectButton />
                </View> */}

                <View style={{ marginBottom: 12, alignSelf: 'center' }}>
                    <RoundButton 
                        title="Account" 
                        onPress={() => router.push('/account')}
                    />
                </View>
            </ScrollView>
        </View>
    );
}