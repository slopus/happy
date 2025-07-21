import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    return (
        <Stack
            initialRouteName='index'
            screenOptions={{
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
                name="settings"
                options={{
                    presentation: 'modal',
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="session/[id]"
                options={{
                    headerTitle: 'Session',
                    headerBackTitle: 'Home'
                }}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    presentation: 'modal',
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="account"
                options={{
                    presentation: 'modal',
                    headerShown: true,
                    headerTitle: 'Account',
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
                name="dev"
                options={{
                    headerShown: true,
                    headerTitle: 'Developer Tools',
                }}
            />
        </Stack>
    );
}
