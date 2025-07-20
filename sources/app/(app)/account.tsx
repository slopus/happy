import React, { useState } from 'react';
import { View, Text, Alert, ScrollView, Pressable, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';

export default function Account() {
    const auth = useAuth();
    const router = useRouter();
    const [showSecret, setShowSecret] = useState(false);
    
    // Get the current secret key
    const currentSecret = auth.credentials?.secret || '';
    const formattedSecret = currentSecret ? formatSecretKeyForBackup(currentSecret) : '';
    
    const handleShowSecret = () => {
        setShowSecret(true);
    };

    const handleCopySecret = async () => {
        try {
            await Clipboard.setStringAsync(formattedSecret);
            Alert.alert('Success', 'Secret key copied to clipboard. Store it in a safe place!');
        } catch (error) {
            Alert.alert('Error', 'Failed to copy secret key');
        }
    };
    
    const handleLogout = () => {
        Alert.alert(
            'Logout',
            'Are you sure you want to logout? Make sure you have backed up your secret key!',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Logout', style: 'destructive', onPress: () => auth.logout() }
            ]
        );
    };
    
    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: 'Account',
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
                }}
            />
            
            <ScrollView className="flex-1 bg-white">
                <View className="p-6">
                    {/* Backup Section */}
                    <View className="mb-8">
                        <Text style={{ fontSize: 16, color: '#666', marginBottom: 16, ...Typography.default() }}>
                            Your secret key is the only way to recover your account. Save it in a secure place like a password manager.
                        </Text>
                        
                        {showSecret && (
                            <Pressable onPress={handleCopySecret}>
                                <View className="bg-gray-100 p-4 rounded-lg mb-4">
                                    <View className="flex-row items-center justify-between mb-2">
                                        <Text style={{ fontSize: 11, color: '#666', ...Typography.default() }}>
                                            SECRET KEY (TAP TO COPY)
                                        </Text>
                                        <Ionicons name="copy-outline" size={16} color="#666" />
                                    </View>
                                    <Text style={{ 
                                        fontSize: 16, 
                                        fontFamily: 'IBMPlexMono-Regular', 
                                        letterSpacing: 1,
                                        lineHeight: 24
                                    }}>
                                        {formattedSecret}
                                    </Text>
                                </View>
                            </Pressable>
                        )}
                        
                        {!showSecret && (
                            <RoundButton
                                title="Show Secret Key"
                                onPress={handleShowSecret}
                            />
                        )}
                    </View>
                    
                    {/* Danger Zone */}
                    <View className="border-t border-gray-200 pt-6">
                        <View className="flex-row items-center mb-4">
                            <Ionicons name="warning" size={24} color="#dc2626" />
                            <Text style={{ fontSize: 20, marginLeft: 8, color: '#dc2626', ...Typography.default('semiBold') }}>
                                Danger Zone
                            </Text>
                        </View>
                        
                        <Pressable
                            onPress={handleLogout}
                            className="bg-red-500 p-4 rounded-lg items-center"
                        >
                            <Text style={{ color: '#fff', fontSize: 16, ...Typography.default('semiBold') }}>
                                Logout
                            </Text>
                        </Pressable>
                        
                        <Text style={{ fontSize: 12, color: '#666', marginTop: 8, textAlign: 'center', ...Typography.default() }}>
                            Make sure you have backed up your secret key before logging out
                        </Text>
                    </View>
                </View>
            </ScrollView>
        </>
    );
}