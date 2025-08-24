import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const { theme } = useUnistyles();

    return (
        <Stack
            initialRouteName='index'
            screenOptions={{
                header: shouldUseCustomHeader ? createHeader : undefined,
                headerBackTitle: 'Back',
                headerShadowVisible: false,
                contentStyle: {
                    backgroundColor: theme.colors.surface,
                },
                headerStyle: {
                    backgroundColor: theme.colors.header.background,
                },
                headerTintColor: theme.colors.header.tint,
                headerTitleStyle: {
                    color: theme.colors.header.tint,
                    ...Typography.default('semiBold'),
                },

            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    headerShown: false,
                    headerTitle: ''
                }}
            />
            <Stack.Screen
                name="settings/index"
                options={{
                    headerShown: true,
                    headerTitle: 'Settings',
                    headerBackTitle: 'Home'
                }}
            />
            <Stack.Screen
                name="session/[id]"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    headerShown: true,
                    headerBackTitle: 'Back',
                    headerTitle: 'Message'
                }}
            />
            <Stack.Screen
                name="session/[id]/info"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: 'Back',
                }}
            />
            <Stack.Screen
                name="session/[id]/files"
                options={{
                    headerShown: true,
                    headerTitle: 'Files',
                    headerBackTitle: 'Back',
                }}
            />
            <Stack.Screen
                name="session/[id]/file"
                options={{
                    headerShown: true,
                    headerTitle: 'File Viewer',
                    headerBackTitle: 'Files',
                }}
            />
            <Stack.Screen
                name="settings/account"
                options={{
                    headerTitle: 'Account',
                }}
            />
            <Stack.Screen
                name="settings/appearance"
                options={{
                    headerTitle: 'Appearance',
                }}
            />
            <Stack.Screen
                name="settings/features"
                options={{
                    headerTitle: 'Features',
                }}
            />
            <Stack.Screen
                name="terminal/connect"
                options={{
                    headerTitle: 'Connect Terminal',
                }}
            />
            <Stack.Screen
                name="terminal/index"
                options={{
                    headerTitle: 'Connect Terminal',
                }}
            />
            <Stack.Screen
                name="restore/index"
                options={{
                    headerShown: true,
                    headerTitle: 'Link New Device',
                    headerBackTitle: 'Back',
                }}
            />
            <Stack.Screen
                name="restore/manual"
                options={{
                    headerShown: true,
                    headerTitle: 'Restore with Secret Key',
                    headerBackTitle: 'Back',
                }}
            />
            <Stack.Screen
                name="dev/index"
                options={{
                    headerTitle: 'Developer Tools',
                }}
            />

            <Stack.Screen
                name="dev/list-demo"
                options={{
                    headerTitle: 'List Components Demo',
                }}
            />
            <Stack.Screen
                name="dev/typography"
                options={{
                    headerTitle: 'Typography',
                }}
            />
            <Stack.Screen
                name="dev/colors"
                options={{
                    headerTitle: 'Colors',
                }}
            />
            <Stack.Screen
                name="dev/tools2"
                options={{
                    headerTitle: 'Tool Views Demo',
                }}
            />
            <Stack.Screen
                name="dev/masked-progress"
                options={{
                    headerTitle: 'Masked Progress',
                }}
            />
            <Stack.Screen
                name="dev/shimmer-demo"
                options={{
                    headerTitle: 'Shimmer View Demo',
                }}
            />
            <Stack.Screen
                name="dev/multi-text-input"
                options={{
                    headerTitle: 'Multi Text Input',
                }}
            />
        </Stack>
    );
}
