import React from 'react';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useUnistyles } from 'react-native-unistyles';

export default React.memo(function SecretPickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string }>();
    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';

    const [secrets, setSecrets] = useSettingMutable('secrets');

    const setSecretParamAndClose = React.useCallback((secretId: string) => {
        router.setParams({ secretId });
        navigation.goBack();
    }, [navigation, router]);

    const handleBackPress = React.useCallback(() => {
        navigation.goBack();
    }, [navigation]);

    const headerTitle = t('settings.secrets');
    const headerBackTitle = t('common.back');

    const headerLeft = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleBackPress}
                hitSlop={10}
                style={({ pressed }) => ({ marginLeft: 10, padding: 4, opacity: pressed ? 0.7 : 1 })}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
            >
                <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
            </Pressable>
        );
    }, [handleBackPress, theme.colors.header.tint]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
            // /new is presented as `containedModal` on iOS. Ensure picker screens are too,
            // otherwise they can be pushed "behind" the modal (invisible but on the back stack).
            presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
            headerLeft,
        } as const;
    }, [headerBackTitle, headerLeft, headerTitle]);

    return (
        <>
            <Stack.Screen
                options={screenOptions}
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
