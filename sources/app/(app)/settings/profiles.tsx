import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal as HappyModal } from '@/modal/ModalManager';
import { layout } from '@/components/layout';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowDimensions } from 'react-native';
import { AIBackendProfile } from '@/sync/settings';

interface ProfileDisplay {
    id: string;
    name: string;
    isBuiltIn: boolean;
}

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

// Default built-in profiles
const DEFAULT_PROFILES: ProfileDisplay[] = [
    {
        id: 'anthropic',
        name: 'Anthropic (Default)',
        isBuiltIn: true,
    },
    {
        id: 'deepseek',
        name: 'DeepSeek (Reasoner)',
        isBuiltIn: true,
    },
    {
        id: 'zai',
        name: 'Z.AI (GLM-4.6)',
        isBuiltIn: true,
    }
];

// Built-in profile configurations
const getBuiltInProfile = (id: string): AIBackendProfile | null => {
    switch (id) {
        case 'anthropic':
            return {
                id: 'anthropic',
                name: 'Anthropic (Default)',
                anthropicConfig: {},
                environmentVariables: [],
                compatibility: { claude: true, codex: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'deepseek':
            return {
                id: 'deepseek',
                name: 'DeepSeek (Reasoner)',
                anthropicConfig: {
                    baseUrl: 'https://api.deepseek.com/anthropic',
                    model: 'deepseek-reasoner',
                },
                environmentVariables: [
                    { name: 'DEEPSEEK_API_TIMEOUT_MS', value: '600000' },
                    { name: 'DEEPSEEK_SMALL_FAST_MODEL', value: 'deepseek-chat' },
                    { name: 'DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                    { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: 'deepseek-chat' },
                    { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
                ],
                compatibility: { claude: true, codex: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'zai':
            return {
                id: 'zai',
                name: 'Z.AI (GLM-4.6)',
                anthropicConfig: {
                    baseUrl: 'https://api.z.ai/api/anthropic',
                    model: 'glm-4.6',
                },
                environmentVariables: [],
                compatibility: { claude: true, codex: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        default:
            return null;
    }
};

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
            id: Date.now().toString(),
            name: '',
            anthropicConfig: {},
            environmentVariables: [],
            compatibility: { claude: true, codex: true },
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
        // Auto-delete profile (confirmed by design decision)
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
                id: Date.now().toString(), // Generate new ID for custom profile
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
                                    <Ionicons name="trash-outline" size={20} color="#FF6B6B" />
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
    profile: AIBackendProfile;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
}) {
    const { theme } = useUnistyles();
    const [name, setName] = React.useState(profile.name || '');
    const [baseUrl, setBaseUrl] = React.useState(profile.anthropicConfig?.baseUrl || '');
    const [authToken, setAuthToken] = React.useState(profile.anthropicConfig?.authToken || '');
    const [model, setModel] = React.useState(profile.anthropicConfig?.model || '');
    const [tmuxSession, setTmuxSession] = React.useState(profile.tmuxConfig?.sessionName || '');
    const [tmuxTmpDir, setTmuxTmpDir] = React.useState(profile.tmuxConfig?.tmpDir || '');
    const [tmuxUpdateEnvironment, setTmuxUpdateEnvironment] = React.useState(profile.tmuxConfig?.updateEnvironment || false);

    // Convert environmentVariables array to record for editing
    const [customEnvVars, setCustomEnvVars] = React.useState<Record<string, string>>(
        profile.environmentVariables?.reduce((acc, envVar) => {
            acc[envVar.name] = envVar.value;
            return acc;
        }, {} as Record<string, string>) || {}
    );

    const [newEnvKey, setNewEnvKey] = React.useState('');
    const [newEnvValue, setNewEnvValue] = React.useState('');
    const [showAddEnvVar, setShowAddEnvVar] = React.useState(false);

    const handleAddEnvVar = () => {
        if (newEnvKey.trim() && newEnvValue.trim()) {
            setCustomEnvVars(prev => ({
                ...prev,
                [newEnvKey.trim()]: newEnvValue.trim()
            }));
            setNewEnvKey('');
            setNewEnvValue('');
            setShowAddEnvVar(false);
        }
    };

    const handleRemoveEnvVar = (key: string) => {
        setCustomEnvVars(prev => {
            const newVars = { ...prev };
            delete newVars[key];
            return newVars;
        });
    };

    const handleSave = () => {
        if (!name.trim()) {
            // Profile name validation - prevent saving empty profiles
            return;
        }

        // Convert customEnvVars record back to environmentVariables array
        const environmentVariables = Object.entries(customEnvVars).map(([name, value]) => ({
            name,
            value,
        }));

        onSave({
            ...profile,
            name: name.trim(),
            anthropicConfig: {
                baseUrl: baseUrl.trim() || undefined,
                authToken: authToken.trim() || undefined,
                model: model.trim() || undefined,
            },
            tmuxConfig: {
                sessionName: tmuxSession.trim() || undefined,
                tmpDir: tmuxTmpDir.trim() || undefined,
                updateEnvironment: tmuxUpdateEnvironment,
            },
            environmentVariables,
            updatedAt: Date.now(),
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
                backgroundColor: theme.colors.surface,
                borderRadius: 16,
                padding: 20,
                width: '100%',
                maxWidth: 400,
            }}>
                <Text style={{
                    fontSize: 20,
                    fontWeight: 'bold',
                    color: theme.colors.text,
                    marginBottom: 20,
                    textAlign: 'center',
                    ...Typography.default('semiBold')
                }}>
                    {profile.name ? t('profiles.editProfile') : t('profiles.addProfile')}
                </Text>

                {/* Profile Name */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.text,
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
                        color: theme.colors.text,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.textSecondary,
                    }}
                    placeholder={t('profiles.enterName')}
                    value={name}
                    onChangeText={setName}
                />

                {/* Base URL */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.text,
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
                        color: theme.colors.text,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.textSecondary,
                    }}
                    placeholder="https://api.anthropic.com"
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                />

                {/* Auth Token */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.text,
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
                        color: theme.colors.text,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.textSecondary,
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
                    color: theme.colors.text,
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
                        color: theme.colors.text,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.textSecondary,
                    }}
                    placeholder="claude-3-5-sonnet-20241022"
                    value={model}
                    onChangeText={setModel}
                />

                {/* Tmux Session Name */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.text,
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
                        color: theme.colors.text,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.textSecondary,
                    }}
                    placeholder={t('profiles.enterTmuxSession')}
                    value={tmuxSession}
                    onChangeText={setTmuxSession}
                />

                {/* Tmux Temp Directory */}
                <Text style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.text,
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
                        color: theme.colors.text,
                        marginBottom: 16,
                        borderWidth: 1,
                        borderColor: theme.colors.textSecondary,
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
                            borderColor: tmuxUpdateEnvironment ? theme.colors.button.primary.background : theme.colors.textSecondary,
                            backgroundColor: tmuxUpdateEnvironment ? theme.colors.button.primary.background : 'transparent',
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
                            color: theme.colors.text,
                            ...Typography.default()
                        }}>
                            {t('profiles.tmuxUpdateEnvironment')}
                        </Text>
                    </Pressable>
                </View>

                {/* Custom Environment Variables */}
                <View style={{ marginBottom: 24 }}>
                    <View style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 12,
                    }}>
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.text,
                            ...Typography.default('semiBold')
                        }}>
                            Custom Environment Variables
                        </Text>
                        <Pressable
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                padding: 4,
                            }}
                            onPress={() => setShowAddEnvVar(true)}
                        >
                            <Ionicons name="add-circle" size={20} color={theme.colors.button.primary.background} />
                        </Pressable>
                    </View>

                    {/* Display existing custom environment variables */}
                    {Object.entries(customEnvVars).map(([key, value]) => (
                        <View key={key} style={{
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 8,
                            padding: 12,
                            marginBottom: 8,
                            flexDirection: 'row',
                            alignItems: 'center',
                        }}>
                            <View style={{ flex: 1 }}>
                                <Text style={{
                                    fontSize: 14,
                                    fontWeight: '600',
                                    color: theme.colors.text,
                                    ...Typography.default('semiBold')
                                }}>
                                    {key}
                                </Text>
                                <Text style={{
                                    fontSize: 12,
                                    color: theme.colors.textSecondary,
                                    marginTop: 2,
                                    ...Typography.default()
                                }}>
                                    {value}
                                </Text>
                            </View>
                            <Pressable
                                style={{
                                    padding: 4,
                                    marginLeft: 8,
                                }}
                                onPress={() => handleRemoveEnvVar(key)}
                            >
                                <Ionicons name="remove-circle" size={20} color="#FF6B6B" />
                            </Pressable>
                        </View>
                    ))}

                    {/* Add new environment variable form */}
                    {showAddEnvVar && (
                        <View style={{
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 8,
                            padding: 12,
                            marginBottom: 8,
                            borderWidth: 2,
                            borderColor: theme.colors.button.primary.background,
                        }}>
                            <TextInput
                                style={{
                                    backgroundColor: theme.colors.surface,
                                    borderRadius: 6,
                                    padding: 8,
                                    fontSize: 14,
                                    color: theme.colors.text,
                                    marginBottom: 8,
                                    borderWidth: 1,
                                    borderColor: theme.colors.textSecondary,
                                }}
                                placeholder="Variable name (e.g., API_TIMEOUT)"
                                value={newEnvKey}
                                onChangeText={setNewEnvKey}
                                autoCapitalize="none"
                            />
                            <TextInput
                                style={{
                                    backgroundColor: theme.colors.surface,
                                    borderRadius: 6,
                                    padding: 8,
                                    fontSize: 14,
                                    color: theme.colors.text,
                                    marginBottom: 12,
                                    borderWidth: 1,
                                    borderColor: theme.colors.textSecondary,
                                }}
                                placeholder="Variable value (e.g., 60000)"
                                value={newEnvValue}
                                onChangeText={setNewEnvValue}
                                autoCapitalize="none"
                            />
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                                <Pressable
                                    style={{
                                        flex: 1,
                                        backgroundColor: theme.colors.surface,
                                        borderRadius: 6,
                                        padding: 8,
                                        alignItems: 'center',
                                        borderWidth: 1,
                                        borderColor: theme.colors.textSecondary,
                                    }}
                                    onPress={() => {
                                        setShowAddEnvVar(false);
                                        setNewEnvKey('');
                                        setNewEnvValue('');
                                    }}
                                >
                                    <Text style={{
                                        fontSize: 14,
                                        color: theme.colors.textSecondary,
                                        ...Typography.default()
                                    }}>
                                        Cancel
                                    </Text>
                                </Pressable>
                                <Pressable
                                    style={{
                                        flex: 1,
                                        backgroundColor: theme.colors.button.primary.background,
                                        borderRadius: 6,
                                        padding: 8,
                                        alignItems: 'center',
                                    }}
                                    onPress={handleAddEnvVar}
                                >
                                    <Text style={{
                                        fontSize: 14,
                                        color: 'white',
                                        fontWeight: '600',
                                        ...Typography.default('semiBold')
                                    }}>
                                        Add
                                    </Text>
                                </Pressable>
                            </View>
                        </View>
                    )}
                </View>

                {/* Action buttons */}
                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <Pressable
                        style={{
                            flex: 1,
                            backgroundColor: theme.colors.surface,
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
                            backgroundColor: theme.colors.button.primary.background,
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