import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettingMutable } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Modal } from '@/modal';
import { AIBackendProfile } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES } from '@/sync/profileUtils';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { ItemRowActions } from '@/components/ItemRowActions';
import { buildProfileActions } from '@/components/profileActions';
import { Switch } from '@/components/Switch';
import { ProfileCompatibilityIcon } from '@/components/newSession/ProfileCompatibilityIcon';
import { buildProfileGroups, toggleFavoriteProfileId } from '@/sync/profileGrouping';
import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/profileMutations';
import { useSetting } from '@/sync/storage';

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

// Profile utilities now imported from @/sync/profileUtils
const ProfileManager = React.memo(function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme, rt } = useUnistyles();
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [lastUsedProfile, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [editingProfile, setEditingProfile] = React.useState<AIBackendProfile | null>(null);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const [isEditingDirty, setIsEditingDirty] = React.useState(false);
    const isEditingDirtyRef = React.useRef(false);
    const experimentsEnabled = useSetting('experiments');

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
            const discard = await Modal.confirm(
                t('common.discardChanges'),
                t('common.unsavedChangesWarning'),
                { destructive: true, confirmText: t('common.discard'), cancelText: t('common.keepEditing') },
            );
            if (discard) {
                isEditingDirtyRef.current = false;
                closeEditor();
            }
        })();
    }, [closeEditor]);

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

    const {
        favoriteProfiles: favoriteProfileItems,
        customProfiles: nonFavoriteCustomProfiles,
        builtInProfiles: nonFavoriteBuiltInProfiles,
        favoriteIds: favoriteProfileIdSet,
    } = React.useMemo(() => {
        return buildProfileGroups({ customProfiles: profiles, favoriteProfileIds });
    }, [favoriteProfileIds, profiles]);

    const toggleFavoriteProfile = (profileId: string) => {
        setFavoriteProfileIds(toggleFavoriteProfileId(favoriteProfileIds, profileId));
    };

    const getProfileBackendSubtitle = React.useCallback((profile: Pick<AIBackendProfile, 'compatibility'>) => {
        const parts: string[] = [];
        if (profile.compatibility?.claude) parts.push(t('agentInput.agent.claude'));
        if (profile.compatibility?.codex) parts.push(t('agentInput.agent.codex'));
        if (experimentsEnabled && profile.compatibility?.gemini) parts.push(t('agentInput.agent.gemini'));
        return parts.length > 0 ? parts.join(' • ') : '';
    }, [experimentsEnabled]);

    const handleSaveProfile = (profile: AIBackendProfile) => {
        // Profile validation - ensure name is not empty
        if (!profile.name || profile.name.trim() === '') {
            Modal.alert(t('common.error'), t('profiles.nameRequired'));
            return;
        }

        // Check if this is a built-in profile being edited
        const isBuiltIn = DEFAULT_PROFILES.some(bp => bp.id === profile.id);

        // For built-in profiles, create a new custom profile instead of modifying the built-in
        if (isBuiltIn) {
            const newProfile = convertBuiltInProfileToCustom(profile);

            // Check for duplicate names (excluding the new profile)
            const isDuplicate = profiles.some(p =>
                p.name.trim() === newProfile.name.trim()
            );
            if (isDuplicate) {
                Modal.alert(t('common.error'), t('profiles.duplicateName'));
                return;
            }

            setProfiles([...profiles, newProfile]);
        } else {
            // Handle custom profile updates
            // Check for duplicate names (excluding current profile if editing)
            const isDuplicate = profiles.some(p =>
                p.id !== profile.id && p.name.trim() === profile.name.trim()
            );
            if (isDuplicate) {
                Modal.alert(t('common.error'), t('profiles.duplicateName'));
                return;
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
    };

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
            <ItemList style={{ paddingTop: 0 }}>
                {favoriteProfileItems.length > 0 && (
                    <ItemGroup title={t('profiles.groups.favorites')}>
	                        {favoriteProfileItems.map((profile) => {
	                            const isSelected = selectedProfileId === profile.id;
	                            const isFavorite = favoriteProfileIdSet.has(profile.id);
		                            const actions = buildProfileActions({
		                                profile,
		                                isFavorite,
		                                favoriteActionColor: selectedIndicatorColor,
		                                nonFavoriteActionColor: theme.colors.textSecondary,
		                                onToggleFavorite: () => toggleFavoriteProfile(profile.id),
		                                onEdit: () => handleEditProfile(profile),
		                                onDuplicate: () => handleDuplicateProfile(profile),
		                                onDelete: () => { void handleDeleteProfile(profile); },
		                            });
	                            return (
	                                <Item
                                    key={profile.id}
                                    title={profile.name}
                                    subtitle={getProfileBackendSubtitle(profile)}
                                    leftElement={<ProfileCompatibilityIcon profile={profile} />}
	                                    onPress={() => handleSelectProfile(profile.id)}
	                                    showChevron={false}
		                                    selected={isSelected}
		                                    rightElement={(
		                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                                            <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
	                                            <Ionicons
	                                                name="checkmark-circle"
	                                                size={24}
	                                                color={selectedIndicatorColor}
	                                                style={{ opacity: isSelected ? 1 : 0 }}
	                                            />
                                            </View>
	                                            <ItemRowActions
	                                                title={profile.name}
	                                                actions={actions}
	                                                compactActionIds={['edit']}
	                                                iconSize={20}
	                                            />
	                                        </View>
	                                    )}
	                                />
	                            );
	                        })}
                    </ItemGroup>
                )}

                {nonFavoriteCustomProfiles.length > 0 && (
                    <ItemGroup title={t('profiles.groups.custom')}>
	                        {nonFavoriteCustomProfiles.map((profile) => {
	                            const isSelected = selectedProfileId === profile.id;
	                            const isFavorite = favoriteProfileIdSet.has(profile.id);
	                            const actions = buildProfileActions({
	                                profile,
	                                isFavorite,
	                                favoriteActionColor: selectedIndicatorColor,
	                                nonFavoriteActionColor: theme.colors.textSecondary,
	                                onToggleFavorite: () => toggleFavoriteProfile(profile.id),
	                                onEdit: () => handleEditProfile(profile),
	                                onDuplicate: () => handleDuplicateProfile(profile),
	                                onDelete: () => { void handleDeleteProfile(profile); },
	                            });
	                            return (
	                                <Item
                                    key={profile.id}
                                    title={profile.name}
                                    subtitle={getProfileBackendSubtitle(profile)}
                                    leftElement={<ProfileCompatibilityIcon profile={profile} />}
	                                onPress={() => handleSelectProfile(profile.id)}
	                                showChevron={false}
		                                selected={isSelected}
		                                rightElement={(
		                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                                            <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
	                                            <Ionicons
	                                                name="checkmark-circle"
	                                                size={24}
	                                                color={selectedIndicatorColor}
	                                                style={{ opacity: isSelected ? 1 : 0 }}
	                                            />
                                            </View>
	                                        <ItemRowActions
	                                            title={profile.name}
	                                            actions={actions}
	                                            compactActionIds={['edit']}
	                                            iconSize={20}
	                                        />
	                                        </View>
	                                    )}
	                                />
                            );
                        })}
                    </ItemGroup>
                )}

                <ItemGroup title={t('profiles.groups.builtIn')} footer={t('profiles.subtitle')}>
	                    {nonFavoriteBuiltInProfiles.map((profile) => {
	                        const isSelected = selectedProfileId === profile.id;
	                        const isFavorite = favoriteProfileIdSet.has(profile.id);
	                        const actions = buildProfileActions({
	                            profile,
	                            isFavorite,
	                            favoriteActionColor: selectedIndicatorColor,
	                            nonFavoriteActionColor: theme.colors.textSecondary,
	                            onToggleFavorite: () => toggleFavoriteProfile(profile.id),
	                            onEdit: () => handleEditProfile(profile),
	                            onDuplicate: () => handleDuplicateProfile(profile),
	                        });
	                        return (
	                            <Item
                                key={profile.id}
                                title={profile.name}
                                subtitle={getProfileBackendSubtitle(profile)}
                                leftElement={<ProfileCompatibilityIcon profile={profile} />}
	                                onPress={() => handleSelectProfile(profile.id)}
	                                showChevron={false}
		                                selected={isSelected}
		                                rightElement={(
		                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                                        <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
	                                            <Ionicons
	                                                name="checkmark-circle"
	                                                size={24}
	                                                color={selectedIndicatorColor}
	                                                style={{ opacity: isSelected ? 1 : 0 }}
	                                            />
                                        </View>
	                                        <ItemRowActions
	                                            title={profile.name}
	                                            actions={actions}
	                                            compactActionIds={['edit']}
	                                            iconSize={20}
	                                        />
	                                    </View>
	                                )}
	                            />
	                        );
	                    })}
                </ItemGroup>

                <ItemGroup>
                    <Item
                        title={t('profiles.addProfile')}
                        icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={handleAddProfile}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>

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
