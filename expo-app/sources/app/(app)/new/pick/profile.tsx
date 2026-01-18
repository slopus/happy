import React from 'react';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useSetting, useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AIBackendProfile } from '@/sync/settings';
import { Modal } from '@/modal';
import type { ItemAction } from '@/components/ItemActionsMenuModal';
import { machinePreviewEnv } from '@/sync/ops';
import { getProfileEnvironmentVariables } from '@/sync/settings';
import { getRequiredSecretEnvVarName } from '@/sync/profileSecrets';
import { storeTempData } from '@/utils/tempDataStore';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import { ApiKeyRequirementModal, type ApiKeyRequirementModalResult } from '@/components/ApiKeyRequirementModal';

export default React.memo(function ProfilePickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string; machineId?: string; profileId?: string | string[] }>();
    const useProfiles = useSetting('useProfiles');
    const experimentsEnabled = useSetting('experiments');
    const [apiKeys, setApiKeys] = useSettingMutable('apiKeys');
    const [defaultApiKeyByProfileId, setDefaultApiKeyByProfileId] = useSettingMutable('defaultApiKeyByProfileId');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');

    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId : undefined;
    const profileId = Array.isArray(params.profileId) ? params.profileId[0] : params.profileId;
    const setParamsOnPreviousAndClose = React.useCallback((next: { profileId: string; apiKeyId?: string; apiKeySessionOnlyId?: string }) => {
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: next },
                source: previousRoute.key,
            } as never);
        }
        router.back();
    }, [navigation, router]);

    const openApiKeyModal = React.useCallback((profile: AIBackendProfile) => {
        const handleResolve = (result: ApiKeyRequirementModalResult) => {
            if (result.action === 'cancel') return;

            if (result.action === 'useMachine') {
                // Explicit choice: prefer machine key (do not auto-apply defaults in parent).
                setParamsOnPreviousAndClose({ profileId: profile.id, apiKeyId: '' });
                return;
            }

            if (result.action === 'enterOnce') {
                const tempId = storeTempData({ apiKey: result.value });
                setParamsOnPreviousAndClose({ profileId: profile.id, apiKeySessionOnlyId: tempId });
                return;
            }

            if (result.action === 'selectSaved') {
                if (result.setDefault) {
                    setDefaultApiKeyByProfileId({
                        ...defaultApiKeyByProfileId,
                        [profile.id]: result.apiKeyId,
                    });
                }
                setParamsOnPreviousAndClose({ profileId: profile.id, apiKeyId: result.apiKeyId });
            }
        };

        Modal.show({
            component: ApiKeyRequirementModal,
            props: {
                profile,
                machineId: machineId ?? null,
                apiKeys,
                defaultApiKeyId: defaultApiKeyByProfileId[profile.id] ?? null,
                onChangeApiKeys: setApiKeys,
                allowSessionOnly: true,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' }),
            },
        });
    }, [apiKeys, defaultApiKeyByProfileId, machineId, setDefaultApiKeyByProfileId, setParamsOnPreviousAndClose]);

    const handleProfilePress = React.useCallback(async (profile: AIBackendProfile) => {
        const profileId = profile.id;
        // Gate API-key profiles: require machine env OR a selected/saved key before selecting.
        const requiredSecret = getRequiredSecretEnvVarName(profile);

        if (machineId && profile && profile.authMode === 'apiKeyEnv' && requiredSecret) {
            const defaultKeyId = defaultApiKeyByProfileId[profileId] ?? '';
            const defaultKey = defaultKeyId ? (apiKeys.find((k) => k.id === defaultKeyId) ?? null) : null;

            // Check machine env for required secret (best-effort; if unsupported treat as "not detected").
            const preview = await machinePreviewEnv(machineId, {
                keys: [requiredSecret],
                extraEnv: getProfileEnvironmentVariables(profile),
                sensitiveKeys: [requiredSecret],
            });
            const machineHasKey = preview.supported
                ? Boolean(preview.response.values[requiredSecret]?.isSet)
                : false;

            if (!machineHasKey && !defaultKey) {
                openApiKeyModal(profile);
                return;
            }

            // Auto-apply default key if available (still overrideable later).
            if (defaultKey) {
                setParamsOnPreviousAndClose({ profileId, apiKeyId: defaultKey.id });
                return;
            }
        }

        const defaultKeyId = defaultApiKeyByProfileId[profileId] ?? '';
        const defaultKey = defaultKeyId ? (apiKeys.find((k) => k.id === defaultKeyId) ?? null) : null;
        setParamsOnPreviousAndClose(defaultKey ? { profileId, apiKeyId: defaultKey.id } : { profileId });
    }, [apiKeys, defaultApiKeyByProfileId, machineId, router, setParamsOnPreviousAndClose]);

    const handleDefaultEnvironmentPress = React.useCallback(() => {
        setParamsOnPreviousAndClose({ profileId: '' });
    }, [setParamsOnPreviousAndClose]);

    React.useEffect(() => {
        if (typeof profileId === 'string' && profileId.length > 0) {
            setParamsOnPreviousAndClose({ profileId });
        }
    }, [profileId, setParamsOnPreviousAndClose]);

    const openProfileCreate = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/profile-edit',
            params: machineId ? { machineId } : {},
        });
    }, [machineId, router]);

    const openProfileEdit = React.useCallback((profileId: string) => {
        router.push({
            pathname: '/new/pick/profile-edit',
            params: machineId ? { profileId, machineId } : { profileId },
        });
    }, [machineId, router]);

    const openProfileDuplicate = React.useCallback((cloneFromProfileId: string) => {
        router.push({
            pathname: '/new/pick/profile-edit',
            params: machineId ? { cloneFromProfileId, machineId } : { cloneFromProfileId },
        });
    }, [machineId, router]);

    const handleAddProfile = React.useCallback(() => {
        openProfileCreate();
    }, [openProfileCreate]);

    const handleDeleteProfile = React.useCallback((profile: AIBackendProfile) => {
        Modal.alert(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            [
                { text: t('profiles.delete.cancel'), style: 'cancel' },
                {
                    text: t('profiles.delete.confirm'),
                    style: 'destructive',
                    onPress: () => {
                        // Only custom profiles live in `profiles` setting.
                        const updatedProfiles = profiles.filter(p => p.id !== profile.id);
                        setProfiles(updatedProfiles);
                        if (selectedId === profile.id) setParamsOnPreviousAndClose({ profileId: '' });
                    },
                },
            ],
        );
    }, [profiles, selectedId, setParamsOnPreviousAndClose, setProfiles]);

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('profiles.title'),
                    headerBackTitle: t('common.back'),
                }}
            />

            {!useProfiles ? (
                <ItemGroup footer={t('settingsFeatures.profilesDisabled')}>
                    <Item
                        title={t('settingsFeatures.profiles')}
                        subtitle={t('settingsFeatures.profilesDisabled')}
                        icon={<Ionicons name="person-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settings.featuresTitle')}
                        subtitle={t('settings.featuresSubtitle')}
                        icon={<Ionicons name="flask-outline" size={29} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/settings/features')}
                    />
                </ItemGroup>
            ) : (
                <ProfilesList
                    customProfiles={profiles}
                    favoriteProfileIds={favoriteProfileIds}
                    onFavoriteProfileIdsChange={setFavoriteProfileIds}
                    experimentsEnabled={experimentsEnabled}
                    selectedProfileId={selectedId || null}
                    onPressProfile={handleProfilePress}
                    includeDefaultEnvironmentRow
                    onPressDefaultEnvironment={handleDefaultEnvironmentPress}
                    includeAddProfileRow
                    onAddProfilePress={handleAddProfile}
                    machineId={machineId ?? null}
                    onEditProfile={(p) => openProfileEdit(p.id)}
                    onDuplicateProfile={(p) => openProfileDuplicate(p.id)}
                    onDeleteProfile={handleDeleteProfile}
                    onApiKeyBadgePress={(profile) => openApiKeyModal(profile)}
                />
            )}
        </>
    );
});

const stylesheet = StyleSheet.create(() => ({}));
