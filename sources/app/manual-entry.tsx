import { Text, View, TextInput, Pressable, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64, encodeBase64 } from '@/auth/base64';
import { authGetToken } from '@/auth/authGetToken';

export default function ManualEntryModal() {
    const router = useRouter();
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const [manualCode, setManualCode] = React.useState('');

    const processAuthCode = async (code: string) => {
        if (!code.trim()) return;
        
        console.log(code);
        const secret = decodeBase64(code, 'base64url');
        console.log(secret);
        if (secret.length !== 32) {
            throw new Error('Invalid secret');
        }

        // Exchange secret for token
        const token = await authGetToken(secret);
        console.log(token);

        if (token && secret) {
            await auth.login(token, encodeBase64(secret, 'base64url'));
        }
    };

    // Auto-submit when valid input is detected
    React.useEffect(() => {
        if (manualCode.trim().length > 20) { // Reasonable length check
            const submitCode = async () => {
                setIsLoading(true);
                try {
                    await processAuthCode(manualCode.trim());
                    router.back(); // Close modal on success
                } catch (e) {
                    console.error(e);
                    Alert.alert('Error', 'Invalid code or failed to login', [{ text: 'OK' }]);
                } finally {
                    setIsLoading(false);
                }
            };
            
            // Small delay to avoid rapid submissions
            const timer = setTimeout(submitCode, 500);
            return () => clearTimeout(timer);
        }
    }, [manualCode]);

    // TODO use a redirect service to allow swapping out the tutorial video URL without changing the app.
    // Probably just want to send you to a help center website that has the youtube video embedded.

    const openYouTubeVideo = async () => {
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Replace with your actual tutorial video URL
        try {
            await Linking.openURL(url);
        } catch (error) {
            Alert.alert('Error', 'Could not open video', [{ text: 'OK' }]);
        }
    };

    return (
        <KeyboardAvoidingView 
            style={{ flex: 1, backgroundColor: 'white' }}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            {/* Header with close button */}
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 8,
                paddingTop: 10,
                paddingBottom: 8,
            }}>
                <View style={{ width: 40 }} />
                <Text style={{ fontSize: 18, fontWeight: '600' }}>Manual Entry</Text>
                <Pressable
                    onPress={() => router.back()}
                    style={{ padding: 8 }}
                >
                    <Ionicons name="close" size={24} color="#000" />
                </Pressable>
            </View>

            {/* Main content */}
            <View style={{ 
                flex: 1, 
                paddingHorizontal: 24,
                paddingTop: 40,
                justifyContent: 'flex-start'
            }}>
                {/* Icon and title */}
                <View style={{ alignItems: 'center', marginBottom: 40 }}>
                    <View style={{
                        backgroundColor: '#f8f9fa',
                        borderRadius: 40,
                        padding: 20,
                    }}>
                        <Ionicons name="key" size={48} color="#007AFF" />
                    </View>
                </View>

                {/* Input field */}
                <View style={{ marginBottom: 32 }}>
                    <TextInput
                        style={{
                            borderWidth: 2,
                            borderColor: manualCode.length > 0 ? '#007AFF' : '#e1e4e8',
                            borderRadius: 12,
                            padding: 12,
                            fontSize: 16,
                            minHeight: 120,
                            textAlignVertical: 'top',
                            backgroundColor: '#fafbfc',
                            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                        }}
                        placeholder="Paste your authentication code here..."
                        placeholderTextColor="#999"
                        value={manualCode}
                        onChangeText={setManualCode}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        selectTextOnFocus={true}
                        autoFocus={true}
                    />
                    {isLoading && (
                        <View style={{ 
                            position: 'absolute', 
                            top: 0, 
                            left: 0, 
                            right: 0, 
                            bottom: 0, 
                            backgroundColor: 'rgba(255, 255, 255, 0.8)',
                            borderRadius: 12,
                            alignItems: 'center', 
                            justifyContent: 'center' 
                        }}>
                            <ActivityIndicator size="large" color="#007AFF" />
                        </View>
                    )}
                    <Text style={{ 
                        fontSize: 16, 
                        color: '#666', 
                        textAlign: 'left',
                        lineHeight: 22,
                        paddingHorizontal: 12,
                        paddingTop: 8,
                    }}>
                        Copy the code that appears below the QR code when you run <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontWeight: '600' }}>happy-coder</Text> in your terminal
                    </Text>
                </View>

                {/* Help button */}
                <View style={{ paddingBottom: 32 }}>
                    <Pressable
                        onPress={openYouTubeVideo}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            padding: 12,
                            borderRadius: 8,
                            backgroundColor: pressed ? '#f0f0f0' : 'transparent',
                        })}
                    >
                        <Ionicons name="play-circle" size={20} color="#007AFF" style={{ marginRight: 8 }} />
                        <Text style={{ 
                            fontSize: 16, 
                            color: '#007AFF',
                            fontWeight: '600'
                        }}>
                            Show me how to get this code
                        </Text>
                    </Pressable>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
} 