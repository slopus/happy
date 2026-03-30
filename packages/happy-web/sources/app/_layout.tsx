import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
    return (
        <>
            <StatusBar style="dark" />
            <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen
                    name="settings"
                    options={{ headerShown: true, headerTitle: 'Settings', presentation: 'modal' }}
                />
            </Stack>
        </>
    );
}
