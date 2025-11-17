import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AIBackendProfile } from '@/sync/settings';
import { PermissionMode, ModelMode } from '@/components/PermissionModeSelector';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
    containerStyle?: ViewStyle;
}

export function ProfileEditForm({
    profile,
    onSave,
    onCancel,
    containerStyle
}: ProfileEditFormProps) {
    const { theme } = useUnistyles();
    const [name, setName] = React.useState(profile.name || '');
    const [baseUrl, setBaseUrl] = React.useState(profile.anthropicConfig?.baseUrl || '');
    const [authToken, setAuthToken] = React.useState(profile.anthropicConfig?.authToken || '');
    const [model, setModel] = React.useState(profile.anthropicConfig?.model || '');
    const [tmuxSession, setTmuxSession] = React.useState(profile.tmuxConfig?.sessionName || '');
    const [tmuxTmpDir, setTmuxTmpDir] = React.useState(profile.tmuxConfig?.tmpDir || '');
    const [tmuxUpdateEnvironment, setTmuxUpdateEnvironment] = React.useState(profile.tmuxConfig?.updateEnvironment || false);
    const [defaultSessionType, setDefaultSessionType] = React.useState<'simple' | 'worktree'>(profile.defaultSessionType || 'simple');
    const [defaultPermissionMode, setDefaultPermissionMode] = React.useState<PermissionMode>((profile.defaultPermissionMode as PermissionMode) || 'default');
    const [agentType, setAgentType] = React.useState<'claude' | 'codex'>(() => {
        if (profile.compatibility.claude && !profile.compatibility.codex) return 'claude';
        if (profile.compatibility.codex && !profile.compatibility.claude) return 'codex';
        return 'claude'; // Default to Claude if both or neither
    });

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
            defaultSessionType: defaultSessionType,
            defaultPermissionMode: defaultPermissionMode,
            updatedAt: Date.now(),
        });
    };

    return (
        <ScrollView
            style={[profileEditFormStyles.scrollView, containerStyle]}
            contentContainerStyle={profileEditFormStyles.scrollContent}
            keyboardShouldPersistTaps="handled"
        >
            <View style={profileEditFormStyles.formContainer}>
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

                    {/* Session Type */}
                    <Text style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: theme.colors.text,
                        marginBottom: 12,
                        ...Typography.default('semiBold')
                    }}>
                        Default Session Type
                    </Text>
                    <View style={{ marginBottom: 16 }}>
                        <SessionTypeSelector
                            value={defaultSessionType}
                            onChange={setDefaultSessionType}
                        />
                    </View>

                    {/* Permission Mode */}
                    <Text style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: theme.colors.text,
                        marginBottom: 12,
                        ...Typography.default('semiBold')
                    }}>
                        Default Permission Mode
                    </Text>
                    <ItemGroup title="">
                        {[
                            { value: 'default' as PermissionMode, label: 'Default', description: 'Ask for permissions', icon: 'shield-outline' },
                            { value: 'acceptEdits' as PermissionMode, label: 'Accept Edits', description: 'Auto-approve edits', icon: 'checkmark-outline' },
                            { value: 'plan' as PermissionMode, label: 'Plan', description: 'Plan before executing', icon: 'list-outline' },
                            { value: 'bypassPermissions' as PermissionMode, label: 'Bypass Permissions', description: 'Skip all permissions', icon: 'flash-outline' },
                        ].map((option, index, array) => (
                            <Item
                                key={option.value}
                                title={option.label}
                                subtitle={option.description}
                                leftElement={
                                    <Ionicons
                                        name={option.icon as any}
                                        size={24}
                                        color={defaultPermissionMode === option.value ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                                    />
                                }
                                rightElement={defaultPermissionMode === option.value ? (
                                    <Ionicons
                                        name="checkmark-circle"
                                        size={20}
                                        color={theme.colors.button.primary.tint}
                                    />
                                ) : null}
                                onPress={() => setDefaultPermissionMode(option.value)}
                                showChevron={false}
                                selected={defaultPermissionMode === option.value}
                                showDivider={index < array.length - 1}
                                style={defaultPermissionMode === option.value ? {
                                    borderWidth: 2,
                                    borderColor: theme.colors.button.primary.tint,
                                    borderRadius: 8,
                                } : undefined}
                            />
                        ))}
                    </ItemGroup>
                    <View style={{ marginBottom: 16 }} />

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
                    <Text style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: theme.colors.text,
                        marginBottom: 12,
                        ...Typography.default('semiBold')
                    }}>
                        Environment Refresh on Session Attach
                    </Text>
                    <ItemGroup title="">
                        {[
                            {
                                value: true,
                                label: 'Update Automatically',
                                description: 'Refresh SSH agent, DISPLAY for X11 forwarding',
                                icon: 'sync-outline'
                            },
                            {
                                value: false,
                                label: 'Keep Static',
                                description: 'Use original environment (more predictable)',
                                icon: 'lock-closed-outline'
                            },
                        ].map((option, index, array) => (
                            <Item
                                key={option.value.toString()}
                                title={option.label}
                                subtitle={option.description}
                                leftElement={
                                    <Ionicons
                                        name={option.icon as any}
                                        size={24}
                                        color={tmuxUpdateEnvironment === option.value ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                                    />
                                }
                                rightElement={tmuxUpdateEnvironment === option.value ? (
                                    <Ionicons
                                        name="checkmark-circle"
                                        size={20}
                                        color={theme.colors.button.primary.tint}
                                    />
                                ) : null}
                                onPress={() => setTmuxUpdateEnvironment(option.value)}
                                showChevron={false}
                                selected={tmuxUpdateEnvironment === option.value}
                                showDivider={index < array.length - 1}
                                style={tmuxUpdateEnvironment === option.value ? {
                                    borderWidth: 2,
                                    borderColor: theme.colors.button.primary.tint,
                                    borderRadius: 8,
                                } : undefined}
                            />
                        ))}
                    </ItemGroup>
                    <View style={{ marginBottom: 16 }} />

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
                                <Ionicons name="add-circle" size={20} color={theme.colors.button.primary.tint} />
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
                                color: theme.colors.button.primary.tint,
                                ...Typography.default('semiBold')
                            }}>
                                {t('common.save')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
        </ScrollView>
    );
}

const profileEditFormStyles = StyleSheet.create((theme, rt) => ({
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: 20,
    },
    formContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        padding: 20,
        width: '100%',
    },
}));
