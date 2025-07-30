import React, { useState } from 'react';
import { View, Text, TextInput, Alert, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { normalizeSecretKey } from '@/auth/secretKeyBackup';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64 } from '@/auth/base64';
import { layout } from '@/components/layout';

export default function Restore() {
    const auth = useAuth();
    const router = useRouter();
    const [restoreKey, setRestoreKey] = useState('');

    const handleRestore = async () => {
        const trimmedKey = restoreKey.trim();

        if (!trimmedKey) {
            Alert.alert('Error', 'Please enter a secret key');
            return;
        }

        try {
            // Normalize the key (handles both base64url and formatted input)
            const normalizedKey = normalizeSecretKey(trimmedKey);

            // Validate the secret key format
            const secretBytes = decodeBase64(normalizedKey, 'base64url');
            if (secretBytes.length !== 32) {
                throw new Error('Invalid secret key length');
            }

            // Get token from secret
            const token = await authGetToken(secretBytes);
            if (!token) {
                throw new Error('Failed to authenticate with provided key');
            }

            // Login with new credentials
            await auth.login(token, normalizedKey);

            // Dismiss
            router.dismissAll();

        } catch (error) {
            console.error('Restore error:', error);
            Alert.alert('Error', 'Invalid secret key. Please check and try again.');
        }
    };

    return (
        <ScrollView style={{ flex: 1, backgroundColor: 'white' }}>
            <View style={{ 
                flex: 1, 
                alignItems: 'center',
                paddingHorizontal: 24
            }}>
                <View style={{ 
                    width: '100%', 
                    maxWidth: layout.maxWidth,
                    paddingVertical: 24
                }}>
                    <Text style={{ 
                        fontSize: 16, 
                        color: '#666', 
                        marginBottom: 20, 
                        ...Typography.default() 
                    }}>
                        Enter your secret key to restore access to your account.
                    </Text>

                    <TextInput
                        style={{
                            backgroundColor: '#f3f4f6',
                            padding: 16,
                            borderRadius: 8,
                            marginBottom: 24,
                            fontFamily: 'IBMPlexMono-Regular',
                            fontSize: 14,
                            minHeight: 120,
                            textAlignVertical: 'top'
                        }}
                        placeholder="XXXXX-XXXXX-XXXXX..."
                        placeholderTextColor="#999"
                        value={restoreKey}
                        onChangeText={setRestoreKey}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        multiline={true}
                        numberOfLines={4}
                    />

                    <RoundButton
                        title="Restore Account"
                        action={handleRestore}
                    />
                </View>
            </View>
        </ScrollView>
    );
}