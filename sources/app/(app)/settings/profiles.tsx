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
import { randomUUID } from 'expo-crypto';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Switch } from '@/components/Switch';

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

// Profile utilities now imported from @/sync/profileUtils
const ProfileManager = React.memo(function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme } = useUnistyles();
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [lastUsedProfile, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [editingProfile, setEditingProfile] = React.useState<AIBackendProfile | null>(null);
    const [showAddForm, setShowAddForm] = React.useState(false);

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

    const handleAddProfile = () => {
        setEditingProfile({
            id: randomUUID(),
            name: '',
            anthropicConfig: {},
            environmentVariables: [],
            compatibility: { claude: true, codex: true, gemini: true },
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        });
        setShowAddForm(true);
    };

    const handleEditProfile = (profile: AIBackendProfile) => {
        setEditingProfile({ ...profile });
        setShowAddForm(true);
    };

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

    const handleSaveProfile = (profile: AIBackendProfile) => {
        // Profile validation - ensure name is not empty
        if (!profile.name || profile.name.trim() === '') {
            return;
        }

        // Check if this is a built-in profile being edited
        const isBuiltIn = DEFAULT_PROFILES.some(bp => bp.id === profile.id);

        // For built-in profiles, create a new custom profile instead of modifying the built-in
        if (isBuiltIn) {
            const newProfile: AIBackendProfile = {
                ...profile,
                id: randomUUID(), // Generate new UUID for custom profile
                isBuiltIn: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            // Check for duplicate names (excluding the new profile)
            const isDuplicate = profiles.some(p =>
                p.name.trim() === newProfile.name.trim()
            );
            if (isDuplicate) {
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

        setShowAddForm(false);
        setEditingProfile(null);
    };

    return (
        <View style={{ flex: 1 }}>
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup footer={t('profiles.subtitle')}>
                    <Item
                        title={t('profiles.noProfile')}
                        subtitle={t('profiles.noProfileDescription')}
                        icon={<Ionicons name="radio-button-off-outline" size={29} color={theme.colors.textSecondary} />}
                        onPress={() => handleSelectProfile(null)}
                        showChevron={false}
                        selected={selectedProfileId === null}
                        rightElement={selectedProfileId === null
                            ? <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} />
                            : null}
                    />
                </ItemGroup>

                <ItemGroup>
                    {DEFAULT_PROFILES.map((profileDisplay) => {
                        const profile = getBuiltInProfile(profileDisplay.id);
                        if (!profile) return null;

                        const isSelected = selectedProfileId === profile.id;
                        return (
                            <Item
                                key={profile.id}
                                title={profile.name}
                                subtitle={t('profiles.defaultModel')}
                                icon={<Ionicons name="star" size={29} color={theme.colors.button.primary.background} />}
                                onPress={() => handleSelectProfile(profile.id)}
                                showChevron={false}
                                selected={isSelected}
                                rightElement={
                                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                        {isSelected && (
                                            <Ionicons
                                                name="checkmark-circle"
                                                size={20}
                                                color={theme.colors.text}
                                                style={{ marginRight: 12 }}
                                            />
                                        )}
                                        <Pressable
                                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                            onPress={() => handleEditProfile(profile)}
                                        >
                                            <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                        </Pressable>
                                    </View>
                                }
                            />
                        );
                    })}

                    {profiles.map((profile) => {
                        const isSelected = selectedProfileId === profile.id;
                        const subtitleParts: string[] = [t('profiles.defaultModel')];
                        if (profile.tmuxConfig?.sessionName) subtitleParts.push(`tmux: ${profile.tmuxConfig.sessionName}`);
                        if (profile.tmuxConfig?.tmpDir) subtitleParts.push(`dir: ${profile.tmuxConfig.tmpDir}`);

                        return (
                            <Item
                                key={profile.id}
                                title={profile.name}
                                subtitle={subtitleParts.join(' • ')}
                                icon={<Ionicons name="person" size={29} color={theme.colors.textSecondary} />}
                                onPress={() => handleSelectProfile(profile.id)}
                                showChevron={false}
                                selected={isSelected}
                                rightElement={
                                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                        {isSelected && (
                                            <Ionicons
                                                name="checkmark-circle"
                                                size={20}
                                                color={theme.colors.text}
                                                style={{ marginRight: 12 }}
                                            />
                                        )}
                                        <Pressable
                                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                            onPress={() => handleEditProfile(profile)}
                                        >
                                            <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                        </Pressable>
                                        <Pressable
                                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                            onPress={() => void handleDeleteProfile(profile)}
                                            style={{ marginLeft: 16 }}
                                        >
                                            <Ionicons name="trash-outline" size={20} color={theme.colors.deleteAction} />
                                        </Pressable>
                                    </View>
                                }
                            />
                        );
                    })}

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
                <View style={profileManagerStyles.modalOverlay}>
                    <View style={profileManagerStyles.modalContent}>
                        <ProfileEditForm
                            profile={editingProfile}
                            machineId={null}
                            onSave={handleSaveProfile}
                            onCancel={() => {
                                setShowAddForm(false);
                                setEditingProfile(null);
                            }}
                        />
                    </View>
                </View>
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
