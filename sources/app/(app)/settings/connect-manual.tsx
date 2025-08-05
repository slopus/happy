import React, { useState } from 'react';
import { View, TextInput, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ConnectManualScreen() {
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const [authUrl, setAuthUrl] = useState('');
    const { connectWithUrl, isLoading } = useConnectTerminal({
        onSuccess: () => {
            router.back();
        }
    });

    const handleConnect = async () => {
        const trimmedUrl = authUrl.trim();
        if (trimmedUrl) {
            await connectWithUrl(trimmedUrl);
        }
    };

    const isValidUrl = authUrl.trim().startsWith('happy://terminal?');

    return (
        <KeyboardAvoidingView
            style={{ flex: 1, backgroundColor: '#F2F2F7' }}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ScrollView
                contentContainerStyle={{
                    flexGrow: 1,
                    paddingHorizontal: 16,
                    paddingTop: 24,
                    paddingBottom: safeArea.bottom + 24
                }}
                keyboardShouldPersistTaps="handled"
            >
                <View style={{ backgroundColor: 'white', borderRadius: 12, padding: 16, marginBottom: 16 }}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 16, marginBottom: 8 }}>
                        Manual Terminal Connection
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 14, color: '#666', lineHeight: 20 }}>
                        If you're having trouble scanning the QR code, you can paste the authentication link here.
                    </Text>
                </View>

                <View style={{ backgroundColor: 'white', borderRadius: 12, padding: 16, marginBottom: 24 }}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 14, marginBottom: 12 }}>
                        Authentication Link
                    </Text>
                    <TextInput
                        style={{
                            borderWidth: 1,
                            borderColor: '#C7C7CC',
                            borderRadius: 8,
                            padding: 12,
                            fontSize: 14,
                            fontFamily: 'Menlo',
                            backgroundColor: '#F2F2F7',
                            minHeight: 100,
                            textAlignVertical: 'top'
                        }}
                        placeholder="happy://terminal?..."
                        placeholderTextColor="#8E8E93"
                        value={authUrl}
                        onChangeText={setAuthUrl}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline={true}
                        numberOfLines={4}
                    />
                    {authUrl.trim() && !isValidUrl && (
                        <Text style={{ 
                            ...Typography.default(), 
                            fontSize: 12, 
                            color: '#FF3B30', 
                            marginTop: 8 
                        }}>
                            The link must start with "happy://terminal?"
                        </Text>
                    )}
                </View>

                <View style={{ alignItems: 'center' }}>
                    <RoundButton
                        title={isLoading ? "Connecting..." : "Connect"}
                        onPress={handleConnect}
                        size="large"
                        disabled={!isValidUrl || isLoading}
                        loading={isLoading}
                    />
                </View>

                <View style={{ 
                    backgroundColor: '#FFF3CD', 
                    borderRadius: 12, 
                    padding: 16, 
                    marginTop: 24,
                    borderWidth: 1,
                    borderColor: '#FFE69C'
                }}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: '#664D03', marginBottom: 8 }}>
                        How to get the authentication link:
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 13, color: '#664D03', lineHeight: 20 }}>
                        1. Happy installed: `npm i -g happy-coder`{'\n'}
                        2. Run `happy --login`{'\n'}
                        3. Copy the link from the terminal
                    </Text>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}