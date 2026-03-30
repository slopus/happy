import React from 'react';
import { Stack } from 'expo-router';

export default function SettingsLayout() {
    return (
        <Stack screenOptions={{ headerShown: true }}>
            <Stack.Screen name="index" options={{ headerTitle: 'Settings' }} />
        </Stack>
    );
}
