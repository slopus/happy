import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { TouchableOpacity, Text } from 'react-native';
import { router } from 'expo-router';

export default function RootLayout() {
    return (
        <>
            <StatusBar style="dark" />
            <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen
                    name="settings"
                    options={{
                        headerShown: true,
                        headerTitle: 'Settings',
                        presentation: 'modal',
                        headerLeft: () => (
                            <TouchableOpacity onPress={() => {
                                if (router.canGoBack()) {
                                    router.back();
                                } else if (typeof window !== 'undefined') {
                                    window.location.href = '/';
                                }
                            }} style={{ paddingHorizontal: 8 }}>
                                <Text style={{ fontSize: 16, color: '#1a73e8' }}>Back</Text>
                            </TouchableOpacity>
                        ),
                    }}
                />
            </Stack>
        </>
    );
}
