import React from 'react';
import { Stack } from 'expo-router';

import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';

export default React.memo(function SecretsSettingsScreen() {
    const [secrets, setSecrets] = useSettingMutable('secrets');

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('settings.secrets'),
                    headerBackTitle: t('common.back'),
                }}
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

