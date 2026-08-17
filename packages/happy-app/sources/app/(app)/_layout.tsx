import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, TouchableOpacity, Text } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { CardStackScene } from '@/components/CardStackScene';
import { useIsTablet } from '@/utils/responsive';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const useDesktopSettingsModal = Platform.OS === 'web' && useIsTablet();
    const { theme } = useUnistyles();

    return (
        <CardStackScene>
        <Stack
            initialRouteName='index'
            screenOptions={{
                header: shouldUseCustomHeader ? createHeader : undefined,
                headerBackTitle: t('common.back'),
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
                name="inbox/index"
                options={{
                    headerShown: false,
                    headerTitle: t('tabs.inbox'),
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="settings"
                options={{
                    animation: useDesktopSettingsModal ? 'fade' : 'default',
                    contentStyle: {
                        backgroundColor: useDesktopSettingsModal ? 'transparent' : theme.colors.surface,
                    },
                    headerShown: false,
                    presentation: useDesktopSettingsModal ? 'transparentModal' : 'card',
                }}
            />
            <Stack.Screen
                name="session/[id]"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="relationship-advisor"
                options={{
                    headerShown: true,
                    headerTitle: t('relationshipAdvisor.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/search"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionSearch.title'),
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    headerShown: true,
                    headerBackTitle: t('common.back'),
                    headerTitle: t('common.message')
                }}
            />
            <Stack.Screen
                name="session/[id]/info"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/files"
                options={{
                    headerShown: true,
                    headerTitle: t('common.files'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/file"
                options={{
                    headerShown: true,
                    headerTitle: t('common.fileViewer'),
                    headerBackTitle: t('common.files'),
                }}
            />
            <Stack.Screen
                name="terminal/connect"
                options={{
                    headerTitle: t('navigation.connectTerminal'),
                }}
            />
            <Stack.Screen
                name="terminal/index"
                options={{
                    headerTitle: t('navigation.connectTerminal'),
                }}
            />
            <Stack.Screen
                name="restore/index"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.linkNewDevice'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="restore/manual"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.restoreWithSecretKey'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="changelog"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.whatsNew'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/index"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="generated-images"
                options={{
                    headerShown: true,
                    headerTitle: t('generatedImages.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/[id]"
                options={{
                    headerShown: false, // We'll set header dynamically
                }}
            />
            <Stack.Screen
                name="artifacts/new"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.new'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="artifacts/edit/[id]"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.edit'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="text-selection"
                options={{
                    headerShown: true,
                    headerTitle: t('textSelection.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="friends/index"
                options={({ navigation }) => ({
                    headerShown: true,
                    headerTitle: t('navigation.friends'),
                    headerBackTitle: t('common.back'),
                    headerRight: () => (
                        <TouchableOpacity
                            accessibilityLabel={t('friends.addFriend')}
                            accessibilityRole="button"
                            onPress={() => navigation.navigate('friends/search' as never)}
                            style={{ paddingHorizontal: 16 }}
                        >
                            <Text style={{ color: theme.colors.header.tint, fontSize: 16 }}>
                                {t('friends.addFriend')}
                            </Text>
                        </TouchableOpacity>
                    ),
                })}
            />
            <Stack.Screen
                name="friends/search"
                options={{
                    headerShown: true,
                    headerTitle: t('friends.addFriend'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="user/[id]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="dev/index"
                options={{
                    headerTitle: t('settings.developerTools'),
                }}
            />
            <Stack.Screen
                name="dev/ota-versions"
                options={{
                    headerTitle: t('devTools.otaVersions'),
                }}
            />
            <Stack.Screen
                name="ota-switch"
                options={{
                    headerTitle: t('devTools.switchOtaVersion'),
                }}
            />

            <Stack.Screen
                name="dev/list-demo"
                options={{
                    headerTitle: t('devTools.listComponents'),
                }}
            />
            <Stack.Screen
                name="dev/device-info"
                options={{
                    headerTitle: t('devTools.deviceInfo'),
                }}
            />
            <Stack.Screen
                name="dev/typography"
                options={{
                    headerTitle: t('devTools.typography'),
                }}
            />
            <Stack.Screen
                name="dev/colors"
                options={{
                    headerTitle: t('devTools.colors'),
                }}
            />
            <Stack.Screen
                name="dev/tools2"
                options={{
                    headerTitle: t('devTools.toolViews'),
                }}
            />
            <Stack.Screen
                name="dev/shimmer-demo"
                options={{
                    headerTitle: t('devTools.shimmerView'),
                }}
            />
            <Stack.Screen
                name="dev/multi-text-input"
                options={{
                    headerTitle: t('devTools.multiTextInput'),
                }}
            />
            <Stack.Screen
                name="dev/input-styles"
                options={{
                    headerTitle: t('devTools.inputStyles'),
                }}
            />
            <Stack.Screen
                name="dev/messages-demo"
                options={{
                    headerTitle: t('devTools.messageDemos'),
                }}
            />
            <Stack.Screen
                name="dev/modal-demo"
                options={{
                    headerTitle: t('devTools.modalSystem'),
                }}
            />
            <Stack.Screen
                name="dev/tests"
                options={{
                    headerTitle: t('devTools.unitTests'),
                }}
            />
            <Stack.Screen
                name="dev/unistyles-demo"
                options={{
                    headerTitle: t('devTools.unistylesDemo'),
                }}
            />
            <Stack.Screen
                name="dev/qr-test"
                options={{
                    headerTitle: t('devTools.qrCodeTest'),
                }}
            />
            <Stack.Screen
                name="dev/logs"
                options={{
                    headerTitle: t('devTools.viewLogs'),
                }}
            />
            <Stack.Screen
                name="dev/session-composer"
                options={{
                    headerTitle: t('devTools.sessionComposer'),
                }}
            />
            <Stack.Screen
                name="dev/purchases"
                options={{
                    headerTitle: t('devTools.purchases'),
                }}
            />
            <Stack.Screen
                name="dev/expo-constants"
                options={{
                    headerTitle: t('devTools.expoConstants'),
                }}
            />
            <Stack.Screen
                name="dev/inverted-list"
                options={{
                    headerTitle: t('devTools.invertedListTest'),
                }}
            />
            <Stack.Screen
                name="session/recent"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/index"
                options={{
                    // The new-session route now renders <ComposeHome variant="screen" />,
                    // which draws its own header (back button + machine/agent chip).
                    // Hide the native stack header to avoid stacking two headers —
                    // same pattern as the "index" home screen above.
                    headerShown: false,
                }}
            />
        </Stack>
        </CardStackScene>
    );
}
