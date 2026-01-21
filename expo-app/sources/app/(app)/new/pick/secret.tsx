import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';

export default React.memo(function SecretPickerScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ selectedId?: string }>();
    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';

    const [secrets, setSecrets] = useSettingMutable('secrets');

    const setSecretParamAndClose = React.useCallback((secretId: string) => {
        router.setParams({ secretId });
        router.back();
    }, [router]);

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
                selectedId={selectedId}
                onSelectId={setSecretParamAndClose}
                includeNoneRow
                allowAdd
                allowEdit
                onAfterAddSelectId={setSecretParamAndClose}
            />
        </>
    );
});

