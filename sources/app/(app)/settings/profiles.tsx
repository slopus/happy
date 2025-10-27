import React from 'react';
import { View, Text, Pressable, ScrollView, Alert, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowDimensions } from 'react-native';

interface Profile {
    id: string;
    name: string;
    anthropicBaseUrl?: string | null;
    anthropicAuthToken?: string | null;
    anthropicModel?: string | null;
    tmuxSessionName?: string | null;
    tmuxTmpDir?: string | null;
    tmuxUpdateEnvironment?: boolean | null;
}

interface ProfileManagerProps {
    onProfileSelect?: (profile: Profile | null) => void;
    selectedProfileId?: string | null;
}

function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme } = useUnistyles();
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [lastUsedProfile, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [editingProfile, setEditingProfile] = React.useState<Profile | null>(null);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const safeArea = useSafeAreaInsets();
    const screenWidth = useWindowDimensions().width;

    const handleAddProfile = () => {
        setEditingProfile({
            id: Date.now().toString(),
            name: '',
            anthropicBaseUrl: '',
            anthropicAuthToken: '',
            anthropicModel: '',
            tmuxSessionName: '',
            tmuxTmpDir: '',
            tmuxUpdateEnvironment: false,
        });
        setShowAddForm(true);
    };

    const handleEditProfile = (profile: Profile) => {
        setEditingProfile({ ...profile });
        setShowAddForm(true);
    };

    const handleDeleteProfile = (profile: Profile) => {
        Alert.alert(
            t('common.delete'),
            t('profiles.deleteConfirm', { name: profile.name }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
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
                    }
                }
            ]
        );
    };

    const handleSelectProfile = (profile: Profile | null) => {
        if (onProfileSelect) {
            onProfileSelect(profile);
        }
        setLastUsedProfile(profile?.id || null);
    };

    const handleSaveProfile = (profile: Profile) => {
        const existingIndex = profiles.findIndex(p => p.id === profile.id);
        let updatedProfiles: Profile[];

        if (existingIndex >= 0) {
            // Update existing profile
            updatedProfiles = [...profiles];
            updatedProfiles[existingIndex] = profile;
        } else {
            // Add new profile
            updatedProfiles = [...profiles, profile];
        }

        setProfiles(updatedProfiles);
        setShowAddForm(false);
        setEditingProfile(null);
    };

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
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
                        color: theme.colors.typography,
                        marginVertical: 16,
                        ...Typography.default('bold')
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
                            borderColor: theme.colors.primary,
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
                                color: theme.colors.typography,
                                ...Typography.default('semiBold')
                            }}>
                                {t('profiles.noProfile')}
                            </Text>
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.typographySecondary,
                                marginTop: 2,
                                ...Typography.default()
                            }}>
                                {t('profiles.noProfileDescription')}
                            </Text>
                        </View>
                        {selectedProfileId === null && (
                            <Ionicons name="checkmark-circle" size={20} color={theme.colors.primary} />
                        )}
                    </Pressable>

                    {/* Profile list */}
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
                                borderColor: theme.colors.primary,
                            }}
                            onPress={() => handleSelectProfile(profile)}
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
                                    color: theme.colors.typography,
                                    ...Typography.default('semiBold')
                                }}>
                                    {profile.name}
                                </Text>
                                <Text style={{
                                    fontSize: 14,
                                    color: theme.colors.typographySecondary,
                                    marginTop: 2,
                                    ...Typography.default()
                                }}>
                                    {profile.anthropicModel || t('profiles.defaultModel')}
                                    {profile.tmuxSessionName && ` • tmux: ${profile.tmuxSessionName}`}
                                    {profile.tmuxTmpDir && ` • dir: ${profile.tmuxTmpDir}`}
                                </Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                {selectedProfileId === profile.id && (
                                    <Ionicons name="checkmark-circle" size={20} color={theme.colors.primary} style={{ marginRight: 12 }} />
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
                                    <Ionicons name="trash-outline" size={20} color="#FF6B6B" />
                                </Pressable>
                            </View>
                        </Pressable>
                    ))}

                    {/* Add profile button */}
                    <Pressable
                        style={{
                            backgroundColor: theme.colors.button.secondary.background,
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
                <ProfileEditForm
                    profile={editingProfile}
                    onSave={handleSaveProfile}
                    onCancel={() => {
                        setShowAddForm(false);
                        setEditingProfile(null);
                    }}
                />
            )}
        </View>
    );
}

function ProfileEditForm({
    profile,
    onSave,
    onCancel
}: {
    profile: Profile;
    onSave: (profile: Profile) => void;
    onCancel: () => void;
}) {
    const { theme } = useUnistyles();
    const [name, setName] = React.useState(profile.name);
    const [baseUrl, setBaseUrl] = React.useState(profile.anthropicBaseUrl || '');
    const [authToken, setAuthToken] = React.useState(profile.anthropicAuthToken || '');
    const [model, setModel] = React.useState(profile.anthropicModel || '');
    const [tmuxSession, setTmuxSession] = React.useState(profile.tmuxSessionName || '');
    const [tmuxTmpDir, setTmuxTmpDir] = React.useState(profile.tmuxTmpDir || '');
    const [tmuxUpdateEnvironment, setTmuxUpdateEnvironment] = React.useState(profile.tmuxUpdateEnvironment || false);

    const handleSave = () => {
        if (!name.trim()) {
            Modal.alert(t('common.error'), t('profiles.nameRequired'));
            return;
        }

        onSave({
            ...profile,
            name: name.trim(),
            anthropicBaseUrl: baseUrl.trim() || null,
            anthropicAuthToken: authToken.trim() || null,
            anthropicModel: model.trim() || null,
            tmuxSessionName: tmuxSession.trim() || null,
            tmuxTmpDir: tmuxTmpDir.trim() || null,
            tmuxUpdateEnvironment,
        });
    };

    return (
        <View style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
        }}>
            <View style={{
                backgroundColor: theme.colors.background,
                borderRadius: 16,
                padding: 20,
                width: '100%',
                maxWidth: 400,
            }}>
                <Text style={{
                    fontSize: 20,
                    fontWeight: 'bold',
                    color: theme.colors.typography,
                    marginBottom: 20,
                    textAlign: 'center',
                    ...Typography.default('bold')
                }}>
                    {profile.name ? t('profiles.editProfile') : t('profiles.addProfile')}
                </Text>

                {/* Profile Name */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.typography,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('profiles.profileName')}
                </Text>
                <TextInput
                    style={{
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 8,
                        padding: 12,
                        fontSize: 16,
                        color: theme.colors.typography,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                    }}
                    placeholder={t('profiles.enterName')}
                    value={name}
                    onChangeText={setName}
                />

                {/* Base URL */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.typography,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('profiles.baseURL')} ({t('common.optional')})
                </Text>
                <TextInput
                    style={{
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 8,
                        padding: 12,
                        fontSize: 16,
                        color: theme.colors.typography,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                    }}
                    placeholder="https://api.anthropic.com"
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                />

                {/* Auth Token */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.typography,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('profiles.authToken')} ({t('common.optional')})
                </Text>
                <TextInput
                    style={{
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 8,
                        padding: 12,
                        fontSize: 16,
                        color: theme.colors.typography,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                    }}
                    placeholder={t('profiles.enterToken')}
                    value={authToken}
                    onChangeText={setAuthToken}
                    secureTextEntry
                />

                {/* Model */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.typography,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('profiles.model')} ({t('common.optional')})
                </Text>
                <TextInput
                    style={{
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 8,
                        padding: 12,
                        fontSize: 16,
                        color: theme.colors.typography,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                    }}
                    placeholder="claude-3-5-sonnet-20241022"
                    value={model}
                    onChangeText={setModel}
                />

                {/* Tmux Session Name */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.typography,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('profiles.tmuxSession')} ({t('common.optional')})
                </Text>
                <TextInput
                    style={{
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 8,
                        padding: 12,
                        fontSize: 16,
                        color: theme.colors.typography,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                    }}
                    placeholder={t('profiles.enterTmuxSession')}
                    value={tmuxSession}
                    onChangeText={setTmuxSession}
                />

                {/* Tmux Temp Directory */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.typography,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('profiles.tmuxTempDir')} ({t('common.optional')})
                </Text>
                <TextInput
                    style={{
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 8,
                        padding: 12,
                        fontSize: 16,
                        color: theme.colors.typography,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                    }}
                    placeholder={t('profiles.enterTmuxTempDir')}
                    value={tmuxTmpDir}
                    onChangeText={setTmuxTmpDir}
                />

                {/* Tmux Update Environment */}
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 24,
                }}>
                    <Pressable
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                        }}
                        onPress={() => setTmuxUpdateEnvironment(!tmuxUpdateEnvironment)}
                    >
                        <View style={{
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            borderWidth: 2,
                            borderColor: tmuxUpdateEnvironment ? theme.colors.primary : theme.colors.border,
                            backgroundColor: tmuxUpdateEnvironment ? theme.colors.primary : 'transparent',
                            justifyContent: 'center',
                            alignItems: 'center',
                            marginRight: 8,
                        }}>
                            {tmuxUpdateEnvironment && (
                                <Ionicons name="checkmark" size={12} color="white" />
                            )}
                        </View>
                        <Text style={{
                            fontSize: 14,
                            color: theme.colors.typography,
                            ...Typography.default()
                        }}>
                            {t('profiles.tmuxUpdateEnvironment')}
                        </Text>
                    </Pressable>
                </View>

                {/* Action buttons */}
                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <Pressable
                        style={{
                            flex: 1,
                            backgroundColor: theme.colors.button.secondary.background,
                            borderRadius: 8,
                            padding: 12,
                            alignItems: 'center',
                        }}
                        onPress={onCancel}
                    >
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.button.secondary.tint,
                            ...Typography.default('semiBold')
                        }}>
                            {t('common.cancel')}
                        </Text>
                    </Pressable>
                    <Pressable
                        style={{
                            flex: 1,
                            backgroundColor: theme.colors.primary,
                            borderRadius: 8,
                            padding: 12,
                            alignItems: 'center',
                        }}
                        onPress={handleSave}
                    >
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: 'white',
                            ...Typography.default('semiBold')
                        }}>
                            {t('common.save')}
                        </Text>
                    </Pressable>
                </View>
            </View>
        </View>
    );
}

export default ProfileManager;