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
            className="flex-1 bg-white"
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            {/* Header with close button */}
            <View className="flex-row items-center justify-between px-2 pt-2.5 pb-2">
                <View className="w-10" />
                <Text className="text-lg font-semibold">Manual Entry</Text>
                <Pressable
                    onPress={() => router.back()}
                    className="p-2"
                >
                    <Ionicons name="close" size={24} color="#000" />
                </Pressable>
            </View>

            {/* Main content */}
            <View className="flex-1 px-6 pt-10 justify-start">
                {/* Icon and title */}
                <View className="items-center mb-10">
                    <View className="bg-gray-50 rounded-full p-5">
                        <Ionicons name="key" size={48} color="#007AFF" />
                    </View>
                </View>

                {/* Input field */}
                <View className="mb-8">
                    <TextInput
                        className={`border-2 ${manualCode.length > 0 ? 'border-blue-500' : 'border-gray-300'} rounded-xl p-3 text-base bg-gray-50`}
                        style={{
                            minHeight: 120,
                            textAlignVertical: 'top',
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
                        <View className="absolute inset-0 bg-white/80 rounded-xl items-center justify-center">
                            <ActivityIndicator size="large" color="#007AFF" />
                        </View>
                    )}
                    <Text className="text-base text-gray-600 text-left leading-6 px-3 pt-2">
                        Copy the code that appears below the QR code when you run <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontWeight: '600' }}>happy-coder</Text> in your terminal
                    </Text>
                </View>

                {/* Help button */}
                <View className="pb-8">
                    <Pressable
                        onPress={openYouTubeVideo}
                        style={({ pressed }) => ({
                            backgroundColor: pressed ? '#f0f0f0' : 'transparent',
                        })}
                        className="flex-row items-center p-3 rounded-lg"
                    >
                        <Ionicons name="play-circle" size={20} color="#007AFF" style={{ marginRight: 8 }} />
                        <Text className="text-base text-blue-500 font-semibold">
                            Show me how to get this code
                        </Text>
                    </Pressable>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
} 