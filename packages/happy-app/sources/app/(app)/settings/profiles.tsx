import React from 'react';
import { View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AIBackendProfile } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES } from '@/sync/profileUtils';
import { randomUUID } from 'expo-crypto';

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [lastUsedProfile, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const safeArea = useSafeAreaInsets();

    const handleAddProfile = () => {
        const newProfile: AIBackendProfile = {
            id: randomUUID(),
            name: '',
            anthropicConfig: {},
            environmentVariables: [],
            compatibility: { claude: true, codex: true, gemini: true },
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        };
        router.push({
            pathname: '/settings/profile-edit',
            params: { profileData: encodeURIComponent(JSON.stringify(newProfile)) },
        });
    };

    const handleEditProfile = (profile: AIBackendProfile) => {
        router.push({
            pathname: '/settings/profile-edit',
            params: { profileData: encodeURIComponent(JSON.stringify(profile)) },
        });
    };

    const handleDeleteProfile = (profile: AIBackendProfile) => {
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

                        if (lastUsedProfile === profile.id) {
                            setLastUsedProfile(null);
                        }

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
            const builtInProfile = getBuiltInProfile(profileId);
            if (builtInProfile) {
                profile = builtInProfile;
            } else {
                profile = profiles.find(p => p.id === profileId) || null;
            }
        }

        if (onProfileSelect) {
            onProfileSelect(profile);
        }
        setLastUsedProfile(profileId);
    };

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <Stack.Screen
                options={{
                    headerTitle: t('settings.profiles'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{
                    paddingHorizontal: 16,
                    paddingBottom: safeArea.bottom + 100,
                }}
            >
                <View style={[{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%', paddingTop: 16 }]}>
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
                                    backgroundColor: '#000000',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    marginRight: 12,
                                }}>
                                    <Ionicons name="star" size={16} color="#FFFFFF" />
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
        </View>
    );
}

export default ProfileManager;
