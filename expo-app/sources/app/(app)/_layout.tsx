import { Stack, router, useSegments } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, TouchableOpacity, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useAuth } from '@/auth/AuthContext';
import { isPublicRouteForUnauthenticated } from '@/auth/authRouting';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    const auth = useAuth();
    const segments = useSegments();
    const { theme } = useUnistyles();

    const shouldRedirect = !auth.isAuthenticated && !isPublicRouteForUnauthenticated(segments);
    React.useEffect(() => {
        if (!shouldRedirect) return;
        router.replace('/');
    }, [shouldRedirect]);

    // Avoid rendering protected screens for a frame during redirect.
    if (shouldRedirect) {
        return null;
    }

    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';

    return (
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
                name="settings/index"
                options={{
                    headerShown: true,
                    headerTitle: t('settings.title'),
                    headerBackTitle: t('common.home')
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
                name="settings/account"
                options={{
                    headerTitle: t('settings.account'),
                }}
            />
            <Stack.Screen
                name="settings/appearance"
                options={{
                    headerTitle: t('settings.appearance'),
                }}
            />
            <Stack.Screen
                name="settings/features"
                options={{
                    headerTitle: t('settings.features'),
                }}
            />
            <Stack.Screen
                name="settings/profiles"
                options={{
                    headerTitle: t('settingsFeatures.profiles'),
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
                            onPress={() => navigation.navigate('friends/search' as never)}
                            style={{ paddingHorizontal: 16 }}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint, fontSize: 16 }}>
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
            <Stack.Screen
                name="session/recent"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="settings/connect/claude"
                options={{
                    headerShown: true,
                    headerTitle: 'Connect to Claude',
                    headerBackTitle: t('common.back'),
                    // headerStyle: {
                    //     backgroundColor: Platform.OS === 'web' ? theme.colors.header.background : '#1F1E1C',
                    // },
                    // headerTintColor: Platform.OS === 'web' ? theme.colors.header.tint : '#FFFFFF',
                    // headerTitleStyle: {
                    //     color: Platform.OS === 'web' ? theme.colors.header.tint : '#FFFFFF',
                    // },
                }}
            />
            <Stack.Screen
                name="new/pick/machine"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/path"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/profile"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/profile-edit"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                    // When /new is presented as `containedModal` on iOS, pushing a default "card" screen
                    // from within it can end up behind the modal (increasing the back stack without
                    // becoming visible). Present profile-edit as `containedModal` too so it always
                    // shows above the wizard.
                    presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
                }}
            />
            <Stack.Screen
                name="new/index"
                options={{
                    headerTitle: t('newSession.title'),
                    headerShown: true,
                    headerBackTitle: t('common.cancel'),
                    // On iOS, presenting this as a native "modal" can cause React Native <Modal>
                    // (used by our in-app modal system) to appear behind it and block touches.
                    // `containedModal` keeps presentation within the stack so overlays work reliably.
                    presentation: Platform.OS === 'ios' ? 'containedModal' : 'modal',
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                    // `containedModal` is reliable for stacking in-app modals above this screen on iOS,
                    // but swipe-to-dismiss is not consistently available. Always provide a close button.
                    headerBackVisible: false,
                    headerLeft: () => null,
                    headerRight: () => (
                        <TouchableOpacity
                            onPress={() => router.back()}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            style={{ paddingHorizontal: 12, paddingVertical: 6 }}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                        >
                            <Ionicons name="close" size={22} color={theme.colors.header.tint} />
                        </TouchableOpacity>
                    ),
                }}
            />
            <Stack.Screen
                name="zen/index"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="zen/new"
                options={{
                    presentation: 'modal',
                    headerTitle: 'New Task',
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="zen/view"
                options={{
                    presentation: 'modal',
                    headerTitle: 'Task Details',
                    headerBackTitle: t('common.back'),
                }}
            />
        </Stack>
    );
}
