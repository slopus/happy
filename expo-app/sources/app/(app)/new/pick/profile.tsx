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
import type { ItemAction } from '@/components/itemActions/types';
import { machinePreviewEnv } from '@/sync/ops';
import { getProfileEnvironmentVariables } from '@/sync/settings';
import { getRequiredSecretEnvVarNames } from '@/sync/profileSecrets';
import { storeTempData } from '@/utils/tempDataStore';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/SecretRequirementModal';
import { getSecretSatisfaction } from '@/utils/secretSatisfaction';
import { useMachineEnvPresence } from '@/hooks/useMachineEnvPresence';

export default React.memo(function ProfilePickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string; machineId?: string; profileId?: string | string[] }>();
    const useProfiles = useSetting('useProfiles');
    const experimentsEnabled = useSetting('experiments');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');

    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId : undefined;
    const profileId = Array.isArray(params.profileId) ? params.profileId[0] : params.profileId;
    const setParamsOnPreviousAndClose = React.useCallback((next: { profileId: string; secretId?: string; secretSessionOnlyId?: string }) => {
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

    const openSecretModal = React.useCallback((profile: AIBackendProfile, envVarName: string) => {
        const requiredSecretName = envVarName.trim().toUpperCase();
        if (!requiredSecretName) return;

        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);

        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action === 'cancel') return;

            if (result.action === 'useMachine') {
                // Explicit choice: prefer machine key (do not auto-apply defaults in parent).
                setParamsOnPreviousAndClose({ profileId: profile.id, secretId: '' });
                return;
            }

            if (result.action === 'enterOnce') {
                const tempId = storeTempData({ secret: result.value });
                setParamsOnPreviousAndClose({ profileId: profile.id, secretSessionOnlyId: tempId });
                return;
            }

            if (result.action === 'selectSaved') {
                if (result.setDefault) {
                    setSecretBindingsByProfileId({
                        ...secretBindingsByProfileId,
                        [profile.id]: {
                            ...(secretBindingsByProfileId[profile.id] ?? {}),
                            [requiredSecretName]: result.secretId,
                        },
                    });
                }
                setParamsOnPreviousAndClose({ profileId: profile.id, secretId: result.secretId });
            }
        };

        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile,
                secretEnvVarName: requiredSecretName,
                secretEnvVarNames: requiredSecretNames,
                machineId: machineId ?? null,
                secrets,
                defaultSecretId: secretBindingsByProfileId[profile.id]?.[requiredSecretName] ?? null,
                defaultSecretIdByEnvVarName: secretBindingsByProfileId[profile.id] ?? null,
                onChangeSecrets: setSecrets,
                allowSessionOnly: true,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' }),
            },
            closeOnBackdrop: true,
        });
    }, [machineId, secretBindingsByProfileId, secrets, setParamsOnPreviousAndClose, setSecretBindingsByProfileId, setSecrets]);

    const handleProfilePress = React.useCallback(async (profile: AIBackendProfile) => {
        const profileId = profile.id;
        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);
        const machineEnvReadyByName: Record<string, boolean> = {};

        if (machineId && requiredSecretNames.length > 0) {
            // Best-effort: ask daemon for presence of all required secrets.
            const preview = await machinePreviewEnv(machineId, {
                keys: requiredSecretNames,
                extraEnv: getProfileEnvironmentVariables(profile),
                sensitiveKeys: requiredSecretNames,
            });
            if (preview.supported) {
                for (const name of requiredSecretNames) {
                    machineEnvReadyByName[name] = Boolean(preview.response.values[name]?.isSet);
                }
            } else {
                for (const name of requiredSecretNames) {
                    machineEnvReadyByName[name] = false;
                }
            }
        }

        const satisfaction = getSecretSatisfaction({
            profile,
            secrets,
            defaultBindings: secretBindingsByProfileId[profileId] ?? null,
            machineEnvReadyByName: machineId ? machineEnvReadyByName : null,
        });

        // If all required secrets are satisfied solely by a default saved secret AND this is the primary secret,
        // we can still support the single-secret return param for legacy callers.
        if (requiredSecretNames.length === 1) {
            const only = requiredSecretNames[0]!;
            const item = satisfaction.items.find((i) => i.envVarName === only) ?? null;
            if (item?.satisfiedBy === 'defaultSaved' && item.savedSecretId) {
                setParamsOnPreviousAndClose({ profileId, secretId: item.savedSecretId });
                return;
            }
        }

        if (!satisfaction.isSatisfied) {
            const missing = satisfaction.items.find((i) => i.required && !i.isSatisfied)?.envVarName ?? null;
            if (missing) {
                openSecretModal(profile, missing);
                return;
            }
        }

        setParamsOnPreviousAndClose({ profileId });
    }, [machineId, openSecretModal, secretBindingsByProfileId, secrets, setParamsOnPreviousAndClose]);

    const allRequiredSecretNames = React.useMemo(() => {
        const names = new Set<string>();
        for (const p of profiles) {
            for (const req of getRequiredSecretEnvVarNames(p)) {
                names.add(req);
            }
        }
        return Array.from(names);
    }, [profiles]);

    const machineEnvPresence = useMachineEnvPresence(machineId ?? null, allRequiredSecretNames, { ttlMs: 5 * 60_000 });

    const getSecretMachineEnvOverride = React.useCallback((profile: AIBackendProfile) => {
        const required = getRequiredSecretEnvVarNames(profile);
        if (required.length === 0) return null;
        if (!machineId) return null;
        if (!machineEnvPresence.isPreviewEnvSupported) return null;
        return {
            isReady: required.every((name) => Boolean(machineEnvPresence.meta[name]?.isSet)),
            isLoading: machineEnvPresence.isLoading,
        };
    }, [machineEnvPresence.isLoading, machineEnvPresence.isPreviewEnvSupported, machineEnvPresence.meta, machineId]);

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
                    getSecretOverrideReady={(profile) => {
                        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);
                        if (requiredSecretNames.length === 0) return false;
                        const satisfaction = getSecretSatisfaction({
                            profile,
                            secrets,
                            defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
                            machineEnvReadyByName: null,
                        });
                        if (!satisfaction.isSatisfied) return false;
                        const required = satisfaction.items.filter((i) => i.required);
                        if (required.length == 0) return false;
                        return required.some((i) => i.satisfiedBy !== 'machineEnv');
                    }}
                    getSecretMachineEnvOverride={getSecretMachineEnvOverride}
                    onEditProfile={(p) => openProfileEdit(p.id)}
                    onDuplicateProfile={(p) => openProfileDuplicate(p.id)}
                    onDeleteProfile={handleDeleteProfile}
                    onSecretBadgePress={(profile) => {
                        const missing = getSecretSatisfaction({
                            profile,
                            secrets,
                            defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
                            machineEnvReadyByName: machineEnvPresence.meta
                                ? Object.fromEntries(Object.entries(machineEnvPresence.meta).map(([k, v]) => [k, Boolean(v?.isSet)]))
                                : null,
                        }).items.find((i) => i.required && !i.isSatisfied)?.envVarName ?? null;
                        openSecretModal(profile, missing ?? (getRequiredSecretEnvVarNames(profile)[0] ?? ''));
                    }}
                />
            )}
        </>
    );
});

const stylesheet = StyleSheet.create(() => ({}));
