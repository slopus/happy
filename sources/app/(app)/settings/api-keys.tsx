import React from 'react';
import { Stack } from 'expo-router';

import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { ApiKeysList } from '@/components/apiKeys/ApiKeysList';

export default React.memo(function ApiKeysSettingsScreen() {
    const [apiKeys, setApiKeys] = useSettingMutable('apiKeys');

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('settings.apiKeys'),
                    headerBackTitle: t('common.back'),
                }}
            />

            <ApiKeysList
                apiKeys={apiKeys}
                onChangeApiKeys={setApiKeys}
                allowAdd
                allowEdit
            />
        </>
    );
});
