import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, TouchableOpacity, Text } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

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
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/browser"
                options={{
                    headerShown: true,
                    headerTitle: t('browser.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/commits"
                options={{
                    headerShown: true,
                    headerTitle: t('commits.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/commit"
                options={{
                    headerShown: true,
                    headerTitle: t('commits.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/status"
                options={{
                    headerShown: true,
                    headerTitle: t('status.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/edit"
                options={{
                    headerShown: true,
                    headerTitle: t('files.editFileTitle'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/tool-diff"
                options={{
                    headerShown: true,
                    headerTitle: t('common.fileViewer'),
                    headerBackTitle: t('common.back'),
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
                name="settings/notifications"
                options={{
                    headerTitle: t('settingsNotifications.title'),
                }}
            />
            <Stack.Screen
                name="settings/voice"
                options={{
                    headerTitle: t('settings.voiceAssistant'),
                }}
            />
            <Stack.Screen
                name="settings/voice/elevenlabs"
                options={{
                    headerTitle: t('settingsVoice.elevenLabsTitle'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="settings/voice/happy-voice"
                options={{
                    headerTitle: t('settingsVoice.happyVoiceTitle'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="settings/voice/language"
                options={{
                    headerTitle: t('settingsVoice.preferredLanguage'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="settings/voice/welcome-message"
                options={{
                    headerTitle: t('settingsVoice.welcomeMessage'),
                    headerBackTitle: t('common.back'),
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
                name="session/claude"
                options={{
                    headerShown: true,
                    headerTitle: t('claudeHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/history"
                options={{
                    headerShown: true,
                    headerTitle: t('agentHistory.title'),
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
                name="settings/connect/dootask"
                options={{
                    headerShown: true,
                    headerTitle: t('settings.connectDootask'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="dootask/[taskId]"
                options={{
                    headerShown: true,
                    headerTitle: t('dootask.taskDetail'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="dootask/chat/[dialogId]"
                options={{
                    headerShown: true,
                    headerTitle: t('dootask.chatTitle'),
                    headerBackTitle: t('common.back'),
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
                name="new/pick/profile-edit"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/index"
                options={{
                    headerTitle: t('newSession.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
<Stack.Screen
                name="openclaw/index"
                options={{
                    headerShown: true,
                    headerTitle: t('tabs.openclaw'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="openclaw/add"
                options={{
                    headerTitle: t('openclaw.addMachine'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="machine/[id]/repo/[repoId]"
                options={{
                    headerShown: true,
                    headerTitle: t('repoEdit.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="machine/[id]/repo/script-editor"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="openclaw/machine/[id]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="openclaw/chat"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="openclaw/new"
                options={{
                    headerShown: true,
                    headerTitle: t('openclaw.newSession'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="scanner"
                options={{
                    headerShown: false,
                    presentation: 'fullScreenModal',
                    animation: 'fade_from_bottom',
                }}
            />
        </Stack>
    );
}
