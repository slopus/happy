import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AIBackendProfile } from '@/sync/settings';

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
}

export function ProfileEditForm({
    profile,
    onSave,
    onCancel
}: ProfileEditFormProps) {
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
            <ScrollView style={{
                width: '100%',
                maxWidth: 400,
            }} contentContainerStyle={{
                padding: 20,
            }}>
                <View style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: 16,
                    padding: 20,
                    width: '100%',
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
            </ScrollView>
        </View>
    );
}
