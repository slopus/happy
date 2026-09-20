import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter, useSegments } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAuth } from '@/auth/AuthContext';
import { getServerInfo } from '@/sync/serverConfig';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The gear on the link-your-computer screen. Two things a person might need
 * before a computer is linked: point at a different server, or throw the
 * account away and start again. Logging out here is safe: nothing is linked
 * to the account yet, so there is nothing to lose.
 */
export default function OnboardingSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const auth = useAuth();
    useSegments(); // Re-render on return so a changed server shows.
    const serverInfo = getServerInfo();
    const serverLabel = serverInfo.isCustom
        ? serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '')
        : t('onboarding.settingsServerDefault');

    const logout = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('onboarding.logoutConfirmTitle'),
            t('onboarding.logoutConfirmBody'),
            { confirmText: t('common.logout'), destructive: true },
        );
        if (confirmed) {
            await auth.logout();
        }
    }, [auth]);

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('onboarding.settingsTitle'),
                    headerTitleAlign: 'center',
                    headerBackTitle: t('common.back'),
                }}
            />
            <ItemList>
                <ItemGroup>
                    <Item
                        title={t('onboarding.settingsServer')}
                        detail={serverLabel}
                        icon={<Ionicons name="server-outline" size={28} color={theme.colors.textSecondary} />}
                        showChevron={true}
                        onPress={() => router.push('/server')}
                    />
                </ItemGroup>
                <ItemGroup footer={t('onboarding.logoutFooter')}>
                    <Item
                        title={t('onboarding.logoutStartOver')}
                        icon={<Ionicons name="log-out-outline" size={28} color={theme.colors.textDestructive} />}
                        destructive
                        showChevron={false}
                        onPress={() => { void logout(); }}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}
