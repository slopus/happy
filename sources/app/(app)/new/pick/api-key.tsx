import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { ApiKeysList } from '@/components/apiKeys/ApiKeysList';

export default React.memo(function ApiKeyPickerScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ selectedId?: string }>();
    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';

    const [apiKeys, setApiKeys] = useSettingMutable('apiKeys');

    const setApiKeyParamAndClose = React.useCallback((apiKeyId: string) => {
        router.setParams({ apiKeyId });
        router.back();
    }, [router]);

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
                selectedId={selectedId}
                onSelectId={setApiKeyParamAndClose}
                includeNoneRow
                allowAdd
                allowEdit
                onAfterAddSelectId={setApiKeyParamAndClose}
            />
        </>
    );
});
