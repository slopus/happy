import React from 'react';
import { View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettingMutable } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal as HappyModal } from '@/modal/ModalManager';
import { layout } from '@/components/layout';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowDimensions } from 'react-native';
import { AIBackendProfile } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES } from '@/sync/profileUtils';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { randomUUID } from 'expo-crypto';

interface ProfileDisplay {
    id: string;
    name: string;
    isBuiltIn: boolean;
}

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

// Profile utilities now imported from @/sync/profileUtils

function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme } = useUnistyles();
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [lastUsedProfile, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [editingProfile, setEditingProfile] = React.useState<AIBackendProfile | null>(null);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const safeArea = useSafeAreaInsets();
    const screenWidth = useWindowDimensions().width;

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

    const handleDeleteProfile = (profile: AIBackendProfile) => {
        // Show confirmation dialog before deleting
        Alert.alert(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            [
                {
                    text: t('profiles.delete.cancel'),
                    style: 'cancel',
                },
                {
                    text: t('profiles.delete.confirm'),
                    style: 'destructive',
                    onPress: () => {
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
                    },
                },
            ],
            { cancelable: true }
        );
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
                updatedProfiles[existingIndex] = profile;
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
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{
                    paddingHorizontal: screenWidth > 700 ? 16 : 8,
                    paddingBottom: safeArea.bottom + 100,
                }}
            >
                <View style={[{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }]}>
                    <Text style={{
                        fontSize: 24,
                        fontWeight: 'bold',
                        color: theme.colors.text,
                        marginVertical: 16,
                        ...Typography.default('semiBold')
                    }}>
                        {t('profiles.title')}
                    </Text>

                    {/* None option - no profile */}
                    <Pressable
                        style={{
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 12,
                            padding: 16,
                            marginBottom: 12,
                            flexDirection: 'row',
                            alignItems: 'center',
                            borderWidth: selectedProfileId === null ? 2 : 0,
                            borderColor: theme.colors.text,
                        }}
                        onPress={() => handleSelectProfile(null)}
                    >
                        <View style={{
                            width: 24,
                            height: 24,
                            borderRadius: 12,
                            backgroundColor: theme.colors.button.secondary.tint,
                            justifyContent: 'center',
                            alignItems: 'center',
                            marginRight: 12,
                        }}>
                            <Ionicons name="remove" size={16} color="white" />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={{
                                fontSize: 16,
                                fontWeight: '600',
                                color: theme.colors.text,
                                ...Typography.default('semiBold')
                            }}>
                                {t('profiles.noProfile')}
                            </Text>
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                marginTop: 2,
                                ...Typography.default()
                            }}>
                                {t('profiles.noProfileDescription')}
                            </Text>
                        </View>
                        {selectedProfileId === null && (
                            <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} />
                        )}
                    </Pressable>

                    {/* Built-in profiles */}
                    {DEFAULT_PROFILES.map((profileDisplay) => {
                        const profile = getBuiltInProfile(profileDisplay.id);
                        if (!profile) return null;

                        return (
                            <Pressable
                                key={profile.id}
                                style={{
                                    backgroundColor: theme.colors.input.background,
                                    borderRadius: 12,
                                    padding: 16,
                                    marginBottom: 12,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderWidth: selectedProfileId === profile.id ? 2 : 0,
                                    borderColor: theme.colors.text,
                                }}
                                onPress={() => handleSelectProfile(profile.id)}
                            >
                                <View style={{
                                    width: 24,
                                    height: 24,
                                    borderRadius: 12,
                                    backgroundColor: theme.colors.button.primary.background,
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    marginRight: 12,
                                }}>
                                    <Ionicons name="star" size={16} color="white" />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={{
                                        fontSize: 16,
                                        fontWeight: '600',
                                        color: theme.colors.text,
                                        ...Typography.default('semiBold')
                                    }}>
                                        {profile.name}
                                    </Text>
                                    <Text style={{
                                        fontSize: 14,
                                        color: theme.colors.textSecondary,
                                        marginTop: 2,
                                        ...Typography.default()
                                    }}>
                                        {profile.anthropicConfig?.model || 'Default model'}
                                        {profile.anthropicConfig?.baseUrl && ` • ${profile.anthropicConfig.baseUrl}`}
                                    </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    {selectedProfileId === profile.id && (
                                        <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} style={{ marginRight: 12 }} />
                                    )}
                                    <Pressable
                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                        onPress={() => handleEditProfile(profile)}
                                    >
                                        <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                    </Pressable>
                                </View>
                            </Pressable>
                        );
                    })}

                    {/* Custom profiles */}
                    {profiles.map((profile) => (
                        <Pressable
                            key={profile.id}
                            style={{
                                backgroundColor: theme.colors.input.background,
                                borderRadius: 12,
                                padding: 16,
                                marginBottom: 12,
                                flexDirection: 'row',
                                alignItems: 'center',
                                borderWidth: selectedProfileId === profile.id ? 2 : 0,
                                borderColor: theme.colors.text,
                            }}
                            onPress={() => handleSelectProfile(profile.id)}
                        >
                            <View style={{
                                width: 24,
                                height: 24,
                                borderRadius: 12,
                                backgroundColor: theme.colors.button.secondary.tint,
                                justifyContent: 'center',
                                alignItems: 'center',
                                marginRight: 12,
                            }}>
                                <Ionicons name="person" size={16} color="white" />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={{
                                    fontSize: 16,
                                    fontWeight: '600',
                                    color: theme.colors.text,
                                    ...Typography.default('semiBold')
                                }}>
                                    {profile.name}
                                </Text>
                                <Text style={{
                                    fontSize: 14,
                                    color: theme.colors.textSecondary,
                                    marginTop: 2,
                                    ...Typography.default()
                                }}>
                                    {profile.anthropicConfig?.model || t('profiles.defaultModel')}
                                    {profile.tmuxConfig?.sessionName && ` • tmux: ${profile.tmuxConfig.sessionName}`}
                                    {profile.tmuxConfig?.tmpDir && ` • dir: ${profile.tmuxConfig.tmpDir}`}
                                </Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                {selectedProfileId === profile.id && (
                                    <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} style={{ marginRight: 12 }} />
                                )}
                                <Pressable
                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                    onPress={() => handleEditProfile(profile)}
                                >
                                    <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                </Pressable>
                                <Pressable
                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                    onPress={() => handleDeleteProfile(profile)}
                                    style={{ marginLeft: 16 }}
                                >
                                    <Ionicons name="trash-outline" size={20} color={theme.colors.deleteAction} />
                                </Pressable>
                            </View>
                        </Pressable>
                    ))}

                    {/* Add profile button */}
                    <Pressable
                        style={{
                            backgroundColor: theme.colors.surface,
                            borderRadius: 12,
                            padding: 16,
                            marginBottom: 12,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                        onPress={handleAddProfile}
                    >
                        <Ionicons name="add-circle-outline" size={20} color={theme.colors.button.secondary.tint} />
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.button.secondary.tint,
                            marginLeft: 8,
                            ...Typography.default('semiBold')
                        }}>
                            {t('profiles.addProfile')}
                        </Text>
                    </Pressable>
                </View>
            </ScrollView>

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
}

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
        maxWidth: Math.min(layout.maxWidth, 600),
        maxHeight: '90%',
    },
}));

export default ProfileManager;