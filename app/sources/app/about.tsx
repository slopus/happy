import { Text, View, ScrollView, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

export default function AboutModal() {
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const jsVersion = Platform.Version;

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
                    <Ionicons name="code-slash" size={64} color="#000" style={{ marginBottom: 16 }} />
                    <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 8 }}>Happy Coder</Text>
                    <Text style={{ fontSize: 16, color: '#666' }}>Version {appVersion}</Text>
                </View>

                <View style={{ marginBottom: 24 }}>
                    <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>About</Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: '#333' }}>
                        Third-party mobile client for Claude Code. Access your coding assistant on the go with full encryption and real-time sync.
                    </Text>
                </View>

                <View style={{ marginBottom: 24 }}>
                    <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>Features</Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: '#333', marginBottom: 4 }}>
                        • Connect to Claude Code sessions
                    </Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: '#333', marginBottom: 4 }}>
                        • End-to-end encrypted conversations
                    </Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: '#333', marginBottom: 4 }}>
                        • Real-time sync with desktop
                    </Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: '#333', marginBottom: 4 }}>
                        • Code syntax highlighting
                    </Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: '#333' }}>
                        • Image and file attachments
                    </Text>
                </View>

                <View style={{ marginBottom: 24 }}>
                    <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>Security</Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: '#333' }}>
                        Your conversations are encrypted using your secret key. Only you can decrypt your messages. The server acts as an encrypted relay.
                    </Text>
                </View>

                <View style={{ marginBottom: 32 }}>
                    <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>Claude Code</Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: '#333' }}>
                        Claude Code is Anthropic's coding assistant. Happy Coder is an independent mobile client that allows you to continue conversations started on desktop.
                    </Text>
                </View>

                <View style={{ alignItems: 'center', paddingBottom: 32 }}>
                    <Text style={{ fontSize: 14, color: '#999' }}>Not affiliated with Anthropic</Text>
                </View>
            </ScrollView>
        </View>
    );
}