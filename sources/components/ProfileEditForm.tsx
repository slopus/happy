import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ViewStyle, Linking, Platform } from 'react-native';
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
import { getBuiltInProfileDocumentation } from '@/sync/profileUtils';
import { useEnvironmentVariables, extractEnvVarReferences } from '@/hooks/useEnvironmentVariables';
import { EnvironmentVariablesList } from '@/components/EnvironmentVariablesList';

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
    containerStyle?: ViewStyle;
}

export function ProfileEditForm({
    profile,
    machineId,
    onSave,
    onCancel,
    containerStyle
}: ProfileEditFormProps) {
    const { theme } = useUnistyles();

    // Get documentation for built-in profiles
    const profileDocs = React.useMemo(() => {
        if (!profile.isBuiltIn) return null;
        return getBuiltInProfileDocumentation(profile.id);
    }, [profile.isBuiltIn, profile.id]);

    // Local state for environment variables (unified for all config)
    const [environmentVariables, setEnvironmentVariables] = React.useState<Array<{ name: string; value: string }>>(
        profile.environmentVariables || []
    );

    // Extract ${VAR} references from environmentVariables for querying daemon
    const envVarNames = React.useMemo(() => {
        return extractEnvVarReferences(environmentVariables);
    }, [environmentVariables]);

    // Query daemon environment using hook
    const { variables: actualEnvVars } = useEnvironmentVariables(machineId, envVarNames);

    const [name, setName] = React.useState(profile.name || '');
    const [useTmux, setUseTmux] = React.useState(profile.tmuxConfig?.sessionName !== undefined);
    const [tmuxSession, setTmuxSession] = React.useState(profile.tmuxConfig?.sessionName || '');
    const [tmuxTmpDir, setTmuxTmpDir] = React.useState(profile.tmuxConfig?.tmpDir || '');
    const [useStartupScript, setUseStartupScript] = React.useState(!!profile.startupBashScript);
    const [startupScript, setStartupScript] = React.useState(profile.startupBashScript || '');
    const [defaultSessionType, setDefaultSessionType] = React.useState<'simple' | 'worktree'>(profile.defaultSessionType || 'simple');
    const [defaultPermissionMode, setDefaultPermissionMode] = React.useState<PermissionMode>((profile.defaultPermissionMode as PermissionMode) || 'default');
    const [agentType, setAgentType] = React.useState<'claude' | 'codex'>(() => {
        if (profile.compatibility.claude && !profile.compatibility.codex) return 'claude';
        if (profile.compatibility.codex && !profile.compatibility.claude) return 'codex';
        return 'claude'; // Default to Claude if both or neither
    });

    const handleSave = () => {
        if (!name.trim()) {
            // Profile name validation - prevent saving empty profiles
            return;
        }

        onSave({
            ...profile,
            name: name.trim(),
            // Clear all config objects - ALL configuration now in environmentVariables
            anthropicConfig: {},
            openaiConfig: {},
            azureOpenAIConfig: {},
            // Use environment variables from state (managed by EnvironmentVariablesList)
            environmentVariables,
            // Keep non-env-var configuration
            tmuxConfig: useTmux ? {
                sessionName: tmuxSession.trim() || '', // Empty string = use current/most recent tmux session
                tmpDir: tmuxTmpDir.trim() || undefined,
                updateEnvironment: undefined, // Preserve schema compatibility, not used by daemon
            } : {
                sessionName: undefined,
                tmpDir: undefined,
                updateEnvironment: undefined,
            },
            startupBashScript: useStartupScript ? (startupScript.trim() || undefined) : undefined,
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
                            borderRadius: 10, // Matches new session panel input fields
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

                    {/* Built-in Profile Documentation - Setup Instructions */}
                    {profile.isBuiltIn && profileDocs && (
                        <View style={{
                            backgroundColor: theme.colors.surface,
                            borderRadius: 12,
                            padding: 16,
                            marginBottom: 20,
                            borderWidth: 1,
                            borderColor: theme.colors.button.primary.background,
                        }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                                <Ionicons name="information-circle" size={20} color={theme.colors.button.primary.tint} style={{ marginRight: 8 }} />
                                <Text style={{
                                    fontSize: 15,
                                    fontWeight: '600',
                                    color: theme.colors.text,
                                    ...Typography.default('semiBold')
                                }}>
                                    Setup Instructions
                                </Text>
                            </View>

                            <Text style={{
                                fontSize: 13,
                                color: theme.colors.text,
                                marginBottom: 12,
                                lineHeight: 18,
                                ...Typography.default()
                            }}>
                                {profileDocs.description}
                            </Text>

                            {profileDocs.setupGuideUrl && (
                                <Pressable
                                    onPress={async () => {
                                        try {
                                            const url = profileDocs.setupGuideUrl!;
                                            // On web/Tauri desktop, use window.open
                                            if (Platform.OS === 'web') {
                                                window.open(url, '_blank');
                                            } else {
                                                // On native (iOS/Android), use Linking API
                                                await Linking.openURL(url);
                                            }
                                        } catch (error) {
                                            console.error('Failed to open URL:', error);
                                        }
                                    }}
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        backgroundColor: theme.colors.button.primary.background,
                                        borderRadius: 8,
                                        padding: 12,
                                        marginBottom: 16,
                                    }}
                                >
                                    <Ionicons name="book-outline" size={16} color={theme.colors.button.primary.tint} style={{ marginRight: 8 }} />
                                    <Text style={{
                                        fontSize: 13,
                                        color: theme.colors.button.primary.tint,
                                        fontWeight: '600',
                                        flex: 1,
                                        ...Typography.default('semiBold')
                                    }}>
                                        View Official Setup Guide
                                    </Text>
                                    <Ionicons name="open-outline" size={14} color={theme.colors.button.primary.tint} />
                                </Pressable>
                            )}
                        </View>
                    )}

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

                    {/* Tmux Enable/Disable */}
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginBottom: 8,
                    }}>
                        <Pressable
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                marginRight: 8,
                            }}
                            onPress={() => setUseTmux(!useTmux)}
                        >
                            <View style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                borderWidth: 2,
                                borderColor: useTmux ? theme.colors.button.primary.background : theme.colors.textSecondary,
                                backgroundColor: useTmux ? theme.colors.button.primary.background : 'transparent',
                                justifyContent: 'center',
                                alignItems: 'center',
                                marginRight: 8,
                            }}>
                                {useTmux && (
                                    <Ionicons name="checkmark" size={12} color={theme.colors.button.primary.tint} />
                                )}
                            </View>
                        </Pressable>
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: theme.colors.text,
                            ...Typography.default('semiBold')
                        }}>
                            Spawn Sessions in Tmux
                        </Text>
                    </View>
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 12,
                        ...Typography.default()
                    }}>
                        {useTmux ? 'Sessions spawn in new tmux windows. Configure session name and temp directory below.' : 'Sessions spawn in regular shell (no tmux integration)'}
                    </Text>

                    {/* Tmux Session Name */}
                    <Text style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: theme.colors.text,
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        Tmux Session Name ({t('common.optional')})
                    </Text>
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default()
                    }}>
                        Leave empty to use first existing tmux session (or create "happy" if none exist). Specify name (e.g., "my-work") for specific session.
                    </Text>
                    <TextInput
                        style={{
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 10, // Matches new session panel input fields
                            padding: 12,
                            fontSize: 16,
                            color: useTmux ? theme.colors.text : theme.colors.textSecondary,
                            marginBottom: 16,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                            opacity: useTmux ? 1 : 0.5,
                        }}
                        placeholder={useTmux ? 'Empty = first existing session' : "Disabled - tmux not enabled"}
                        value={tmuxSession}
                        onChangeText={setTmuxSession}
                        editable={useTmux}
                    />

                    {/* Tmux Temp Directory */}
                    <Text style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: theme.colors.text,
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        Tmux Temp Directory ({t('common.optional')})
                    </Text>
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default()
                    }}>
                        Temporary directory for tmux session files. Leave empty for system default.
                    </Text>
                    <TextInput
                        style={{
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 10, // Matches new session panel input fields
                            padding: 12,
                            fontSize: 16,
                            color: useTmux ? theme.colors.text : theme.colors.textSecondary,
                            marginBottom: 16,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                            opacity: useTmux ? 1 : 0.5,
                        }}
                        placeholder={useTmux ? "/tmp (optional)" : "Disabled - tmux not enabled"}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={tmuxTmpDir}
                        onChangeText={setTmuxTmpDir}
                        editable={useTmux}
                    />

                    {/* Startup Bash Script */}
                    <View style={{ marginBottom: 24 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            marginBottom: 8,
                        }}>
                            <Pressable
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    marginRight: 8,
                                }}
                                onPress={() => setUseStartupScript(!useStartupScript)}
                            >
                                <View style={{
                                    width: 20,
                                    height: 20,
                                    borderRadius: 4,
                                    borderWidth: 2,
                                    borderColor: useStartupScript ? theme.colors.button.primary.background : theme.colors.textSecondary,
                                    backgroundColor: useStartupScript ? theme.colors.button.primary.background : 'transparent',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    marginRight: 8,
                                }}>
                                    {useStartupScript && (
                                        <Ionicons name="checkmark" size={12} color={theme.colors.button.primary.tint} />
                                    )}
                                </View>
                            </Pressable>
                            <Text style={{
                                fontSize: 16,
                                fontWeight: '600',
                                color: theme.colors.text,
                                ...Typography.default('semiBold')
                            }}>
                                Startup Bash Script
                            </Text>
                        </View>
                        <Text style={{
                            fontSize: 12,
                            color: theme.colors.textSecondary,
                            marginBottom: 12,
                            ...Typography.default()
                        }}>
                            {useStartupScript
                                ? 'Executed before spawning each session. Use for dynamic setup, environment checks, or custom initialization.'
                                : 'No startup script - sessions spawn directly'}
                        </Text>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'flex-start',
                            gap: 8,
                            opacity: useStartupScript ? 1 : 0.5,
                        }}>
                            <TextInput
                                style={{
                                    flex: 1,
                                    backgroundColor: useStartupScript ? theme.colors.input.background : theme.colors.surface,
                                    borderRadius: 10, // Matches new session panel input fields
                                    padding: 12,
                                    fontSize: 14,
                                    color: useStartupScript ? theme.colors.text : theme.colors.textSecondary,
                                    borderWidth: 1,
                                    borderColor: theme.colors.textSecondary,
                                    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                                    minHeight: 100,
                                }}
                                placeholder={useStartupScript ? "#!/bin/bash\necho 'Initializing...'\n# Your script here" : "Disabled"}
                                value={startupScript}
                                onChangeText={setStartupScript}
                                editable={useStartupScript}
                                multiline
                                textAlignVertical="top"
                            />
                            {useStartupScript && startupScript.trim() && (
                                <Pressable
                                    style={{
                                        backgroundColor: theme.colors.button.primary.background,
                                        borderRadius: 6,
                                        padding: 10,
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                    }}
                                    onPress={() => {
                                        if (Platform.OS === 'web') {
                                            navigator.clipboard.writeText(startupScript);
                                        }
                                    }}
                                >
                                    <Ionicons name="copy-outline" size={18} color={theme.colors.button.primary.tint} />
                                </Pressable>
                            )}
                        </View>
                    </View>

                    {/* Environment Variables Section - Unified configuration */}
                    <EnvironmentVariablesList
                        environmentVariables={environmentVariables}
                        machineId={machineId}
                        profileDocs={profileDocs}
                        onChange={setEnvironmentVariables}
                    />

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
                        {profile.isBuiltIn ? (
                            // For built-in profiles, show "Save As" button (creates custom copy)
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
                                    {t('common.saveAs')}
                                </Text>
                            </Pressable>
                        ) : (
                            // For custom profiles, show regular "Save" button
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
                        )}
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
        borderRadius: 16, // Matches new session panel main container
        padding: 20,
        width: '100%',
    },
}));
