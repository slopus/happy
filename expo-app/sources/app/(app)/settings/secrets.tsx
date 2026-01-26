import React from 'react';
import { Stack } from 'expo-router';

import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';

export default React.memo(function SecretsSettingsScreen() {
    const [secrets, setSecrets] = useSettingMutable('secrets');

    const headerTitle = t('settings.secrets');
    const headerBackTitle = t('common.back');

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            headerTitle,
            headerBackTitle,
        } as const;
    }, [headerBackTitle, headerTitle]);

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />

            <SecretsList
                secrets={secrets}
                onChangeSecrets={setSecrets}
                allowAdd
                allowEdit
            />
        </>
    );
});
