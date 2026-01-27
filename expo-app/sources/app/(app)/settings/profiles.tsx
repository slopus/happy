import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRouter } from 'expo-router';
import { useSettingMutable } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Modal } from '@/modal';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { AIBackendProfile } from '@/sync/settings';
import { DEFAULT_PROFILES, getBuiltInProfileNameKey, resolveProfileById } from '@/sync/profileUtils';
import { ProfileEditForm } from '@/components/profiles/edit';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/Switch';
import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/profileMutations';
import { useSetting } from '@/sync/storage';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { getRequiredSecretEnvVarNames } from '@/sync/profileSecrets';

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

// Profile utilities now imported from @/sync/profileUtils
const ProfileManager = React.memo(function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [lastUsedProfile, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [editingProfile, setEditingProfile] = React.useState<AIBackendProfile | null>(null);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const [isEditingDirty, setIsEditingDirty] = React.useState(false);
    const isEditingDirtyRef = React.useRef(false);
    const saveRef = React.useRef<(() => boolean) | null>(null);
    const experimentsEnabled = useSetting('experiments');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');

    const openSecretModal = React.useCallback((profile: AIBackendProfile, envVarName?: string) => {
        const requiredSecretNames = getRequiredSecretEnvVarNames(profile);
        const requiredSecretName = (envVarName ?? requiredSecretNames[0] ?? '').trim().toUpperCase();
        if (!requiredSecretName) return;

        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action !== 'selectSaved') return;
            setSecretBindingsByProfileId({
                ...secretBindingsByProfileId,
                [profile.id]: {
                    ...(secretBindingsByProfileId[profile.id] ?? {}),
                    [requiredSecretName]: result.secretId,
                },
            });
        };

        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile,
                secretEnvVarName: requiredSecretName,
                secretEnvVarNames: requiredSecretNames,
                machineId: null,
                secrets,
                defaultSecretId: secretBindingsByProfileId[profile.id]?.[requiredSecretName] ?? null,
                defaultSecretIdByEnvVarName: secretBindingsByProfileId[profile.id] ?? null,
                onChangeSecrets: setSecrets,
                allowSessionOnly: false,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' } as SecretRequirementModalResult),
            },
            closeOnBackdrop: true,
        });
    }, [secrets, secretBindingsByProfileId, setSecretBindingsByProfileId]);

    React.useEffect(() => {
        isEditingDirtyRef.current = isEditingDirty;
    }, [isEditingDirty]);

    const handleAddProfile = () => {
        if (Platform.OS !== 'web') {
            router.push({ pathname: '/new/pick/profile-edit', params: {} } as any);
            return;
        }
        setEditingProfile(createEmptyCustomProfile());
        setShowAddForm(true);
    };

    const handleEditProfile = (profile: AIBackendProfile) => {
        if (Platform.OS !== 'web') {
            router.push({ pathname: '/new/pick/profile-edit', params: { profileId: profile.id } } as any);
            return;
        }
        setEditingProfile({ ...profile });
        setShowAddForm(true);
    };

    const handleDuplicateProfile = (profile: AIBackendProfile) => {
        if (Platform.OS !== 'web') {
            router.push({ pathname: '/new/pick/profile-edit', params: { cloneFromProfileId: profile.id } } as any);
            return;
        }
        setEditingProfile(duplicateProfileForEdit(profile, { copySuffix: t('profiles.copySuffix') }));
        setShowAddForm(true);
    };

    const closeEditor = React.useCallback(() => {
        setShowAddForm(false);
        setEditingProfile(null);
        setIsEditingDirty(false);
    }, []);

    const requestCloseEditor = React.useCallback(() => {
        void (async () => {
            if (!isEditingDirtyRef.current) {
                closeEditor();
                return;
            }
            const isBuiltIn = !!editingProfile && DEFAULT_PROFILES.some((bp) => bp.id === editingProfile.id);
            const saveText = isBuiltIn ? t('common.saveAs') : t('common.save');
            const message = isBuiltIn
                ? `${t('common.unsavedChangesWarning')}\n\n${t('profiles.builtInSaveAsHint')}`
                : t('common.unsavedChangesWarning');
            const decision = await promptUnsavedChangesAlert(
                (title, message, buttons) => Modal.alert(title, message, buttons),
                {
                    title: t('common.discardChanges'),
                    message,
                    discardText: t('common.discard'),
                    saveText,
                    keepEditingText: t('common.keepEditing'),
                },
            );

            if (decision === 'discard') {
                isEditingDirtyRef.current = false;
                closeEditor();
            } else if (decision === 'save') {
                // Save the form state (not the initial profile snapshot).
                saveRef.current?.();
            }
        })();
    }, [closeEditor, editingProfile]);

    React.useEffect(() => {
        const addListener = (navigation as any)?.addListener;
        if (typeof addListener !== 'function') {
            return;
        }

        const subscription = addListener.call(navigation, 'beforeRemove', (e: any) => {
            if (!showAddForm || !isEditingDirtyRef.current) return;

            e.preventDefault();

            void (async () => {
                const isBuiltIn = !!editingProfile && DEFAULT_PROFILES.some((bp) => bp.id === editingProfile.id);
                const saveText = isBuiltIn ? t('common.saveAs') : t('common.save');
                const message = isBuiltIn
                    ? `${t('common.unsavedChangesWarning')}\n\n${t('profiles.builtInSaveAsHint')}`
                    : t('common.unsavedChangesWarning');

                const decision = await promptUnsavedChangesAlert(
                    (title, message, buttons) => Modal.alert(title, message, buttons),
                    {
                        title: t('common.discardChanges'),
                        message,
                        discardText: t('common.discard'),
                        saveText,
                        keepEditingText: t('common.keepEditing'),
                    },
                );

                if (decision === 'discard') {
                    isEditingDirtyRef.current = false;
                    closeEditor();
                    (navigation as any).dispatch(e.data.action);
                } else if (decision === 'save') {
                    // Save form state; only continue navigation if save succeeded.
                    const didSave = saveRef.current?.() ?? false;
                    if (didSave) {
                        isEditingDirtyRef.current = false;
                        (navigation as any).dispatch(e.data.action);
                    }
                }
            })();
        });

        return () => subscription?.remove?.();
    }, [closeEditor, editingProfile, navigation, showAddForm]);

    const handleDeleteProfile = async (profile: AIBackendProfile) => {
        const confirmed = await Modal.confirm(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            { cancelText: t('profiles.delete.cancel'), confirmText: t('profiles.delete.confirm'), destructive: true }
        );
        if (!confirmed) return;

        const updatedProfiles = profiles.filter(p => p.id !== profile.id);
        setProfiles(updatedProfiles);

        // Clear last used profile if it was deleted
        if (lastUsedProfile === profile.id) {
            setLastUsedProfile(null);
        }

        // Notify parent if this was the selected profile
        if (selectedProfileId === profile.id && onProfileSelect) {
            onProfileSelect(null);
        }
    };

    const handleSelectProfile = (profileId: string | null) => {
        let profile: AIBackendProfile | null = null;

        if (profileId) {
            profile = resolveProfileById(profileId, profiles);
        }

        if (onProfileSelect) {
            onProfileSelect(profile);
        }
        setLastUsedProfile(profileId);
    };

    function handleSaveProfile(profile: AIBackendProfile): boolean {
        // Profile validation - ensure name is not empty
        if (!profile.name || profile.name.trim() === '') {
            Modal.alert(t('common.error'), t('profiles.nameRequired'));
            return false;
        }

        // Check if this is a built-in profile being edited
        const isBuiltIn = DEFAULT_PROFILES.some(bp => bp.id === profile.id);
        const builtInNames = DEFAULT_PROFILES
            .map((bp) => {
                const key = getBuiltInProfileNameKey(bp.id);
                return key ? t(key).trim() : null;
            })
            .filter((name): name is string => Boolean(name));

        // For built-in profiles, create a new custom profile instead of modifying the built-in
        if (isBuiltIn) {
            const newProfile = convertBuiltInProfileToCustom(profile);
            const hasBuiltInNameConflict = builtInNames.includes(newProfile.name.trim());

            // Check for duplicate names (excluding the new profile)
            const isDuplicate = profiles.some(p =>
                p.name.trim() === newProfile.name.trim()
            );
            if (isDuplicate || hasBuiltInNameConflict) {
                Modal.alert(t('common.error'), t('profiles.duplicateName'));
                return false;
            }

            setProfiles([...profiles, newProfile]);
        } else {
            // Handle custom profile updates
            // Check for duplicate names (excluding current profile if editing)
            const isDuplicate = profiles.some(p =>
                p.id !== profile.id && p.name.trim() === profile.name.trim()
            );
            const hasBuiltInNameConflict = builtInNames.includes(profile.name.trim());
            if (isDuplicate || hasBuiltInNameConflict) {
                Modal.alert(t('common.error'), t('profiles.duplicateName'));
                return false;
            }

            const existingIndex = profiles.findIndex(p => p.id === profile.id);
            let updatedProfiles: AIBackendProfile[];

            if (existingIndex >= 0) {
                // Update existing profile
                updatedProfiles = [...profiles];
                updatedProfiles[existingIndex] = {
                    ...profile,
                    updatedAt: Date.now(),
                };
            } else {
                // Add new profile
                updatedProfiles = [...profiles, profile];
            }

            setProfiles(updatedProfiles);
        }

        closeEditor();
        return true;
    }

    if (!useProfiles) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup
                    title={t('settingsFeatures.profiles')}
                    footer={t('settingsFeatures.profilesDisabled')}
                >
                    <Item
                        title={t('settingsFeatures.profiles')}
                        subtitle={t('settingsFeatures.profilesDisabled')}
                        icon={<Ionicons name="person-outline" size={29} color="#AF52DE" />}
                        rightElement={
                            <Switch
                                value={useProfiles}
                                onValueChange={setUseProfiles}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <View style={{ flex: 1 }}>
            <ProfilesList
                customProfiles={profiles}
                favoriteProfileIds={favoriteProfileIds}
                onFavoriteProfileIdsChange={setFavoriteProfileIds}
                experimentsEnabled={experimentsEnabled}
                selectedProfileId={selectedProfileId ?? null}
                onPressProfile={(profile) => handleEditProfile(profile)}
                machineId={null}
                includeAddProfileRow
                onAddProfilePress={handleAddProfile}
                onEditProfile={(profile) => handleEditProfile(profile)}
                onDuplicateProfile={(profile) => handleDuplicateProfile(profile)}
                onDeleteProfile={(profile) => { void handleDeleteProfile(profile); }}
                onSecretBadgePress={(profile) => {
                    const required = getRequiredSecretEnvVarNames(profile);
                    if (required.length <= 1) {
                        openSecretModal(profile, required[0]);
                        return;
                    }
                    // When multiple required secrets exist, prompt for which env var to configure.
                    Modal.alert(
                        t('secrets.defineDefaultForProfileTitle'),
                        required.join('\n'),
                        [
                            { text: t('common.cancel'), style: 'cancel' },
                            ...required.map((env) => ({
                                text: env,
                                onPress: () => openSecretModal(profile, env),
                            })),
                        ],
                    );
                }}
                getSecretOverrideReady={(profile) => {
                    const satisfaction = getSecretSatisfaction({
                        profile,
                        secrets,
                        defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
                        // No machine selected on this screen; explicitly treat machine env as unavailable.
                        machineEnvReadyByName: null,
                    });
                    return satisfaction.isSatisfied && satisfaction.items.some((i) => i.required && i.satisfiedBy !== 'machineEnv');
                }}
                // No machine selected on this screen, so machine-env preflight is intentionally omitted.
            />

            {/* Profile Add/Edit Modal */}
            {showAddForm && editingProfile && (
                <Pressable
                    style={profileManagerStyles.modalOverlay}
                    onPress={requestCloseEditor}
                >
                    <Pressable style={profileManagerStyles.modalContent} onPress={() => { }}>
                        <ProfileEditForm
                            profile={editingProfile}
                            machineId={null}
                            onSave={handleSaveProfile}
                            onCancel={requestCloseEditor}
                            onDirtyChange={setIsEditingDirty}
                            saveRef={saveRef}
                        />
                    </Pressable>
                </Pressable>
            )}
        </View>
    );
});

// ProfileEditForm now imported from @/components/profiles/edit

const profileManagerStyles = StyleSheet.create((theme) => ({
    modalOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    modalContent: {
        width: '100%',
        maxWidth: 600,
        maxHeight: '90%',
        flex: 1,
        minHeight: 0,
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: theme.colors.groupped.background,
    },
}));

export default ProfileManager;
