import React from 'react';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform, Pressable } from 'react-native';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting, useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AIBackendProfile } from '@/sync/settings';
import { Modal } from '@/modal';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { machinePreviewEnv } from '@/sync/ops';
import { getProfileEnvironmentVariables } from '@/sync/settings';
import { getRequiredSecretEnvVarNames } from '@/sync/profileSecrets';
import { getTempData, storeTempData } from '@/utils/tempDataStore';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { useMachineEnvPresence } from '@/hooks/useMachineEnvPresence';
import { PopoverPortalTargetProvider } from '@/components/ui/popover';

export default React.memo(function ProfilePickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string; machineId?: string; profileId?: string | string[]; secretRequirementResultId?: string }>();
    const useProfiles = useSetting('useProfiles');
    const experimentsEnabled = useSetting('experiments');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');

    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId : undefined;
    const profileId = Array.isArray(params.profileId) ? params.profileId[0] : params.profileId;
    const secretRequirementResultId = typeof params.secretRequirementResultId === 'string' ? params.secretRequirementResultId : '';
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

    // When the secret requirement screen is used (native), it returns a temp id via params.
    // We handle it here and then return to the previous route with the correct selection.
    React.useEffect(() => {
        if (typeof secretRequirementResultId !== 'string' || secretRequirementResultId.length === 0) {
            return;
        }

        const entry = getTempData<{
            profileId: string;
            revertOnCancel: boolean;
            result: SecretRequirementModalResult;
        }>(secretRequirementResultId);

        const clearParam = () => {
            const setParams = (navigation as any)?.setParams;
            if (typeof setParams === 'function') {
                setParams({ secretRequirementResultId: undefined });
            } else {
                navigation.dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { secretRequirementResultId: undefined } },
                } as never);
            }
        };

        if (!entry || !entry?.result) {
            clearParam();
            return;
        }

        const result = entry.result;
        if (result.action === 'cancel') {
            clearParam();
            return;
        }

        const resolvedProfileId = entry.profileId;
        if (result.action === 'useMachine') {
            setParamsOnPreviousAndClose({ profileId: resolvedProfileId, secretId: '' });
            return;
        }

        if (result.action === 'enterOnce') {
            const tempId = storeTempData({ secret: result.value });
            setParamsOnPreviousAndClose({ profileId: resolvedProfileId, secretSessionOnlyId: tempId });
            return;
        }

        if (result.action === 'selectSaved') {
            const envVarName = result.envVarName.trim().toUpperCase();
            if (result.setDefault && envVarName.length > 0) {
                setSecretBindingsByProfileId({
                    ...secretBindingsByProfileId,
                    [resolvedProfileId]: {
                        ...(secretBindingsByProfileId[resolvedProfileId] ?? {}),
                        [envVarName]: result.secretId,
                    },
                });
            }
            setParamsOnPreviousAndClose({ profileId: resolvedProfileId, secretId: result.secretId });
            return;
        }

        clearParam();
    }, [navigation, secretBindingsByProfileId, secretRequirementResultId, setParamsOnPreviousAndClose, setSecretBindingsByProfileId]);

    const openSecretModal = React.useCallback((profile: AIBackendProfile, envVarName: string) => {
        const requiredSecretName = envVarName.trim().toUpperCase();
        if (!requiredSecretName) return;

        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);

        if (Platform.OS !== 'web') {
            const selectedSecretIdByEnvVarName = secretBindingsByProfileId[profile.id] ?? null;
            router.push({
                pathname: '/new/pick/secret-requirement',
                params: {
                    profileId: profile.id,
                    machineId: machineId ?? undefined,
                    secretEnvVarName: requiredSecretName,
                    secretEnvVarNames: requiredSecretNames.join(','),
                    revertOnCancel: '0',
                    selectedSecretIdByEnvVarName: selectedSecretIdByEnvVarName
                        ? encodeURIComponent(JSON.stringify(selectedSecretIdByEnvVarName))
                        : undefined,
                },
            } as any);
            return;
        }

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
    }, [machineId, router, secretBindingsByProfileId, secrets, setParamsOnPreviousAndClose, setSecretBindingsByProfileId, setSecrets]);

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

    const handleBackPress = React.useCallback(() => {
        navigation.goBack();
    }, [navigation]);

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

    const screenOptions = React.useCallback(() => {
        return {
            headerShown: true,
            title: t('profiles.title'),
            headerTitle: t('profiles.title'),
            headerBackTitle: t('common.back'),
            // /new is presented as `containedModal` on iOS. Ensure picker screens are too,
            // otherwise they can be pushed "behind" the modal (invisible but on the back stack).
            presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
            headerLeft,
        } as const;
    }, [headerLeft]);

    return (
        <PopoverPortalTargetProvider>
            <>
                <Stack.Screen
                    options={screenOptions}
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
        </PopoverPortalTargetProvider>
    );
});

const stylesheet = StyleSheet.create(() => ({}));
