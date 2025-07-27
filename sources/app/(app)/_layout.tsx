import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform } from 'react-native';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    return (
        <Stack
            initialRouteName='index'
            screenOptions={{
                header: Platform.OS === 'ios' ? undefined : createHeader,
                headerBackTitle: 'Back',
                headerShadowVisible: false,
                contentStyle: {
                    backgroundColor: 'white',
                },
                headerStyle: {
                    backgroundColor: 'white',
                },
                headerTintColor: '#000',
                headerTitleStyle: {
                    color: '#000',
                },
            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    headerShown: true,
                    headerTitle: () => (
                        <Text useDefaultTypography={false} style={{ fontSize: 24, color: '#000', ...Typography.logo() }}>
                            Happy Coder
                        </Text>
                    )
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
                    headerTitle: '',
                    headerBackTitle: 'Home'
                }}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    presentation: 'modal',
                    headerShown: true,
                }}
            />
            <Stack.Screen
                name="session/[id]/info"
                options={{
                    presentation: 'modal',
                    headerShown: true,
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
                name="restore"
                options={{
                    presentation: 'modal',
                    headerShown: true,
                    headerTitle: 'Restore Account',
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
        </Stack>
    );
}
