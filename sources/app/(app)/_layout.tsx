import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, Pressable } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';

export const unstable_settings = {
  initialRouteName: 'index',
};

// Component for repository folder button in session info header
function RepositoryFolderButton() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<{ id: string }>();

  const handlePress = () => {
    if (params.id) {
      // Navigate to repository browser (to be implemented)
      router.push(`/session/${params.id}/repository`);
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={15}
      style={{
        padding: 8,
        opacity: 1,
      }}
    >
      <Ionicons
        name="folder-outline"
        size={24}
        color={theme.colors.header.tint}
      />
    </Pressable>
  );
}

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
          headerTitle: '',
        }}
      />
      <Stack.Screen
        name="settings/index"
        options={{
          headerShown: true,
          headerTitle: t('settings.title'),
          headerBackTitle: t('common.home'),
        }}
      />
      <Stack.Screen
        name="session/[id]"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="session/[id]/message/[messageId]"
        options={{
          headerShown: true,
          headerBackTitle: t('common.back'),
          headerTitle: t('common.message'),
        }}
      />
      <Stack.Screen
        name="session/[id]/info"
        options={{
          headerShown: true,
          headerTitle: '',
          headerBackTitle: t('common.back'),
          headerRight: () => <RepositoryFolderButton />,
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
        name="session/[id]/repository"
        options={{
          headerShown: true,
          headerTitle: 'Repository',
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
        name="text-selection"
        options={{
          headerShown: true,
          headerTitle: t('textSelection.title'),
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
        name="new/index"
        options={{
          headerTitle: t('newSession.title'),
          headerBackTitle: t('common.back'),
        }}
      />
      <Stack.Screen
        name="password/unlock"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="password/setup"
        options={{
          headerShown: true,
          headerTitle: t('password.setupPassword'),
          headerBackTitle: t('common.back'),
        }}
      />
      <Stack.Screen
        name="password/change"
        options={{
          headerShown: true,
          headerTitle: t('password.changePassword'),
          headerBackTitle: t('common.back'),
        }}
      />
      <Stack.Screen
        name="password/recovery"
        options={{
          headerShown: true,
          headerTitle: t('password.recoveryTitle'),
          headerBackTitle: t('common.back'),
        }}
      />
    </Stack>
  );
}
