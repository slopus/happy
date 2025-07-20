import React, { useState } from 'react';
import { View, Text, TextInput, Alert, ScrollView, Pressable, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { normalizeSecretKey } from '@/auth/secretKeyBackup';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64 } from '@/auth/base64';

export default function Restore() {
    const auth = useAuth();
    const router = useRouter();
    const [restoreKey, setRestoreKey] = useState('');
    const [isRestoring, setIsRestoring] = useState(false);
    
    const handleRestore = async () => {
        const trimmedKey = restoreKey.trim();
        
        if (!trimmedKey) {
            Alert.alert('Error', 'Please enter a secret key');
            return;
        }
        
        setIsRestoring(true);
        
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
            
            Alert.alert('Success', 'Account restored successfully!', [
                { text: 'OK', onPress: () => router.replace('/') }
            ]);
        } catch (error) {
            console.error('Restore error:', error);
            Alert.alert('Error', 'Invalid secret key. Please check and try again.');
        } finally {
            setIsRestoring(false);
        }
    };
    
    return (
        <>
            <Stack.Screen
                options={{
                    presentation: 'modal',
                    headerShown: true,
                    headerTitle: 'Restore Account',
                    headerStyle: {
                        backgroundColor: 'white',
                    },
                    headerTintColor: '#000',
                    headerTitleStyle: {
                        color: '#000',
                        fontSize: 17,
                        fontWeight: '600',
                    },
                    headerRight: Platform.OS === 'ios' ? () => (
                        <Pressable onPress={() => router.back()} hitSlop={10}>
                            <Ionicons name="close" size={24} color="#000" />
                        </Pressable>
                    ) : undefined,
                    headerLeft: Platform.OS === 'android' ? () => (
                        <Pressable onPress={() => router.back()} hitSlop={10} style={{ marginLeft: 16 }}>
                            <Ionicons name="arrow-back" size={24} color="#000" />
                        </Pressable>
                    ) : undefined,
                }}
            />
            
            <ScrollView className="flex-1 bg-white">
                <View className="p-6">
                    <View className="mb-6">
                        <Text style={{ fontSize: 16, color: '#666', marginBottom: 20, ...Typography.default() }}>
                            Enter your secret key to restore access to your account.
                        </Text>
                        
                        <TextInput
                            className="bg-gray-100 p-4 rounded-lg mb-6"
                            style={{ 
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
                            loading={isRestoring}
                            disabled={!restoreKey.trim() || isRestoring}
                        />
                    </View>
                </View>
            </ScrollView>
        </>
    );
}