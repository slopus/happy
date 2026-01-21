import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useUnistyles } from 'react-native-unistyles';

export default React.memo(function SecretPickerScreen() {
    const { theme } = useUnistyles();
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
                    // /new is presented as `containedModal` on iOS. Ensure picker screens are too,
                    // otherwise they can be pushed "behind" the modal (invisible but on the back stack).
                    presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
                    headerLeft: () => (
                        <Pressable
                            onPress={() => router.back()}
                            hitSlop={10}
                            style={({ pressed }) => ({ marginLeft: 10, padding: 4, opacity: pressed ? 0.7 : 1 })}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.back')}
                        >
                            <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
                        </Pressable>
                    ),
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
