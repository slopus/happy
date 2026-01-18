import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from 'expo-router';
import { useSettingMutable } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Modal } from '@/modal';
import { promptUnsavedChangesAlert } from '@/utils/promptUnsavedChangesAlert';
import { AIBackendProfile } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES } from '@/sync/profileUtils';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Switch } from '@/components/Switch';
import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/profileMutations';
import { useSetting } from '@/sync/storage';
import { ProfilesList } from '@/components/profiles/ProfilesList';
import { ApiKeyRequirementModal, type ApiKeyRequirementModalResult } from '@/components/ApiKeyRequirementModal';

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

// Profile utilities now imported from @/sync/profileUtils
const ProfileManager = React.memo(function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme } = useUnistyles();
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
    const [apiKeys, setApiKeys] = useSettingMutable('apiKeys');
    const [defaultApiKeyByProfileId, setDefaultApiKeyByProfileId] = useSettingMutable('defaultApiKeyByProfileId');

    const openApiKeyModal = React.useCallback((profile: AIBackendProfile) => {
        const handleResolve = (result: ApiKeyRequirementModalResult) => {
            if (result.action !== 'selectSaved') return;
            setDefaultApiKeyByProfileId({
                ...defaultApiKeyByProfileId,
                [profile.id]: result.apiKeyId,
            });
        };

        Modal.show({
            component: ApiKeyRequirementModal,
            props: {
                profile,
                machineId: null,
                apiKeys,
                defaultApiKeyId: defaultApiKeyByProfileId[profile.id] ?? null,
                onChangeApiKeys: setApiKeys,
                allowSessionOnly: false,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' } as ApiKeyRequirementModalResult),
            },
        });
    }, [apiKeys, defaultApiKeyByProfileId, setDefaultApiKeyByProfileId]);

    React.useEffect(() => {
        isEditingDirtyRef.current = isEditingDirty;
    }, [isEditingDirty]);

    const handleAddProfile = () => {
        setEditingProfile(createEmptyCustomProfile());
        setShowAddForm(true);
    };

    const handleEditProfile = (profile: AIBackendProfile) => {
        setEditingProfile({ ...profile });
        setShowAddForm(true);
    };

    const handleDuplicateProfile = (profile: AIBackendProfile) => {
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
            // Check if it's a built-in profile
            const builtInProfile = getBuiltInProfile(profileId);
            if (builtInProfile) {
                profile = builtInProfile;
            } else {
                // Check if it's a custom profile
                profile = profiles.find(p => p.id === profileId) || null;
            }
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
            .map((bp) => getBuiltInProfile(bp.id))
            .filter((p): p is AIBackendProfile => !!p)
            .map((p) => p.name.trim());

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
                onApiKeyBadgePress={openApiKeyModal}
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

// ProfileEditForm now imported from @/components/ProfileEditForm

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
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: theme.colors.groupped.background,
    },
}));

export default ProfileManager;
