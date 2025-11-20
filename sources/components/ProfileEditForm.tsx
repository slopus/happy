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
import { machineBash } from '@/sync/ops';

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

    // State to store actual environment variable values from the remote machine
    const [actualEnvVars, setActualEnvVars] = React.useState<Record<string, string | null>>({});

    // Helper function to get environment variable value by name
    const getEnvVarValue = React.useCallback((name: string): string | undefined => {
        return profile.environmentVariables?.find(ev => ev.name === name)?.value;
    }, [profile.environmentVariables]);

    // Extract base URL from either anthropicConfig or environmentVariables
    const extractedBaseUrl = React.useMemo(() => {
        return profile.anthropicConfig?.baseUrl || getEnvVarValue('ANTHROPIC_BASE_URL') || '';
    }, [profile.anthropicConfig?.baseUrl, getEnvVarValue]);

    // Extract model from either anthropicConfig or environmentVariables
    const extractedModel = React.useMemo(() => {
        return profile.anthropicConfig?.model || getEnvVarValue('ANTHROPIC_MODEL') || '';
    }, [profile.anthropicConfig?.model, getEnvVarValue]);

    // Extract model euphemism mappings (opus, sonnet, haiku)
    const modelMappings = React.useMemo(() => {
        return {
            opus: getEnvVarValue('ANTHROPIC_DEFAULT_OPUS_MODEL'),
            sonnet: getEnvVarValue('ANTHROPIC_DEFAULT_SONNET_MODEL'),
            haiku: getEnvVarValue('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
            smallFast: getEnvVarValue('ANTHROPIC_SMALL_FAST_MODEL'),
        };
    }, [getEnvVarValue]);

    // Get documentation for built-in profiles
    const profileDocs = React.useMemo(() => {
        if (!profile.isBuiltIn) return null;
        return getBuiltInProfileDocumentation(profile.id);
    }, [profile.isBuiltIn, profile.id]);

    // Helper to evaluate environment variable substitutions like ${VAR}
    const evaluateEnvVar = React.useCallback((value: string): string | null => {
        const match = value.match(/^\$\{(.+)\}$/);
        if (match) {
            const varName = match[1];
            return actualEnvVars[varName] !== undefined ? actualEnvVars[varName] : null;
        }
        return value; // Not a substitution, return as-is
    }, [actualEnvVars]);

    // Fetch actual environment variable values from the remote machine
    React.useEffect(() => {
        if (!machineId || !profileDocs) return;

        const fetchEnvVars = async () => {
            const results: Record<string, string | null> = {};

            for (const envVar of profileDocs.environmentVariables) {
                // Skip secret variables - never retrieve actual values
                if (envVar.isSecret) {
                    results[envVar.name] = null;
                    continue;
                }

                try {
                    // Use machineBash to echo the environment variable
                    const result = await machineBash(machineId, `echo "$${envVar.name}"`, '/');
                    if (result.success && result.exitCode === 0) {
                        const value = result.stdout.trim();
                        // Empty string means variable not set
                        results[envVar.name] = value || null;
                    } else {
                        results[envVar.name] = null;
                    }
                } catch (error) {
                    console.error(`Failed to fetch ${envVar.name}:`, error);
                    results[envVar.name] = null;
                }
            }

            setActualEnvVars(results);
        };

        fetchEnvVars();
    }, [machineId, profileDocs]);

    const [name, setName] = React.useState(profile.name || '');
    const [baseUrl, setBaseUrl] = React.useState(extractedBaseUrl);
    const [authToken, setAuthToken] = React.useState(profile.anthropicConfig?.authToken || '');
    const [useAuthToken, setUseAuthToken] = React.useState(!!profile.anthropicConfig?.authToken);
    const [model, setModel] = React.useState(extractedModel);
    const [useModel, setUseModel] = React.useState(!!extractedModel);
    const [useTmux, setUseTmux] = React.useState(!!profile.tmuxConfig?.sessionName);
    const [tmuxSession, setTmuxSession] = React.useState(profile.tmuxConfig?.sessionName || '');
    const [tmuxTmpDir, setTmuxTmpDir] = React.useState(profile.tmuxConfig?.tmpDir || '');
    const [useStartupScript, setUseStartupScript] = React.useState(!!profile.startupBashScript);
    const [startupScript, setStartupScript] = React.useState(profile.startupBashScript || '');
    const [useCustomEnvVars, setUseCustomEnvVars] = React.useState(
        profile.environmentVariables && profile.environmentVariables.length > 0
    );
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

        // Convert customEnvVars record back to environmentVariables array (only if enabled)
        const environmentVariables = useCustomEnvVars
            ? Object.entries(customEnvVars).map(([name, value]) => ({
                name,
                value,
            }))
            : [];

        onSave({
            ...profile,
            name: name.trim(),
            anthropicConfig: {
                baseUrl: baseUrl.trim() || undefined,
                authToken: useAuthToken ? (authToken.trim() || undefined) : undefined,
                model: useModel ? (model.trim() || undefined) : undefined,
            },
            tmuxConfig: useTmux ? {
                sessionName: tmuxSession.trim() || '', // Empty string = use current/most recent tmux session
                tmpDir: tmuxTmpDir.trim() || undefined,
                updateEnvironment: undefined, // Preserve schema compatibility, not used by daemon
            } : {
                sessionName: undefined,
                tmpDir: undefined,
                updateEnvironment: undefined,
            },
            environmentVariables,
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

                            {profileDocs.environmentVariables.length > 0 && (
                                <>
                                    <Text style={{
                                        fontSize: 13,
                                        fontWeight: '600',
                                        color: theme.colors.text,
                                        marginBottom: 8,
                                        ...Typography.default('semiBold')
                                    }}>
                                        Required Environment Variables (add to ~/.zshrc or ~/.bashrc on remote machine):
                                    </Text>

                                    {profileDocs.environmentVariables.map((envVar, index) => (
                                        <View key={envVar.name} style={{
                                            backgroundColor: theme.colors.surfacePressed,
                                            borderRadius: 10, // Matches new session panel items
                                            padding: 10,
                                            marginBottom: 8,
                                        }}>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                                                <Text style={{
                                                    fontSize: 12,
                                                    fontWeight: '600',
                                                    color: envVar.isSecret ? theme.colors.textDestructive : theme.colors.button.primary.tint,
                                                    ...Typography.default('semiBold')
                                                }}>
                                                    {envVar.name}
                                                </Text>
                                                {envVar.isSecret && (
                                                    <Ionicons name="lock-closed" size={12} color={theme.colors.textDestructive} style={{ marginLeft: 4 }} />
                                                )}
                                            </View>
                                            <Text style={{
                                                fontSize: 11,
                                                color: theme.colors.textSecondary,
                                                marginBottom: 4,
                                                ...Typography.default()
                                            }}>
                                                {envVar.description}
                                            </Text>
                                            {/* Expected value */}
                                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: machineId && !envVar.isSecret ? 4 : 0 }}>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: theme.colors.textSecondary,
                                                    marginRight: 4,
                                                    ...Typography.default()
                                                }}>
                                                    Expected:
                                                </Text>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: theme.colors.text,
                                                    ...Typography.default()
                                                }}>
                                                    {envVar.isSecret ? '***hidden***' : envVar.expectedValue}
                                                </Text>
                                            </View>

                                            {/* Actual value - only show if we have a machine and it's not a secret */}
                                            {machineId && !envVar.isSecret && (
                                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: theme.colors.textSecondary,
                                                        marginRight: 4,
                                                        ...Typography.default()
                                                    }}>
                                                        Actual:
                                                    </Text>
                                                    {actualEnvVars[envVar.name] === undefined ? (
                                                        <Text style={{
                                                            fontSize: 11,
                                                            color: theme.colors.textSecondary,
                                                            fontStyle: 'italic',
                                                            ...Typography.default()
                                                        }}>
                                                            Loading...
                                                        </Text>
                                                    ) : actualEnvVars[envVar.name] === null ? (
                                                        <>
                                                            <Ionicons name="alert-circle" size={12} color={theme.colors.warning} style={{ marginRight: 4 }} />
                                                            <Text style={{
                                                                fontSize: 11,
                                                                color: theme.colors.warning,
                                                                ...Typography.default()
                                                            }}>
                                                                Not set
                                                            </Text>
                                                        </>
                                                    ) : actualEnvVars[envVar.name] === envVar.expectedValue ? (
                                                        <>
                                                            <Ionicons name="checkmark-circle" size={12} color={theme.colors.success} style={{ marginRight: 4 }} />
                                                            <Text style={{
                                                                fontSize: 11,
                                                                color: theme.colors.success,
                                                                ...Typography.default()
                                                            }}>
                                                                {actualEnvVars[envVar.name]}
                                                            </Text>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Ionicons name="close-circle" size={12} color={theme.colors.textDestructive} style={{ marginRight: 4 }} />
                                                            <Text style={{
                                                                fontSize: 11,
                                                                color: theme.colors.textDestructive,
                                                                ...Typography.default()
                                                            }}>
                                                                {actualEnvVars[envVar.name]} (mismatch)
                                                            </Text>
                                                        </>
                                                    )}
                                                </View>
                                            )}
                                        </View>
                                    ))}

                                    <Text style={{
                                        fontSize: 12,
                                        fontWeight: '600',
                                        color: theme.colors.text,
                                        marginTop: 8,
                                        marginBottom: 6,
                                        ...Typography.default('semiBold')
                                    }}>
                                        Shell Configuration Example:
                                    </Text>
                                    <View style={{
                                        backgroundColor: theme.colors.surfacePressed,
                                        borderRadius: 10, // Matches new session panel items
                                        padding: 10,
                                    }}>
                                        <Text style={{
                                            fontSize: 11,
                                            color: theme.colors.text,
                                            lineHeight: 16,
                                            ...Typography.default()
                                        }}>
                                            {profileDocs.shellConfigExample}
                                        </Text>
                                    </View>
                                </>
                            )}
                        </View>
                    )}

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
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default()
                    }}>
                        {profile.isBuiltIn && extractedBaseUrl
                            ? `Read-only - This built-in profile uses: ${extractedBaseUrl}\nSee setup instructions above for expected values.`
                            : 'Leave empty for default. Can be overridden by ANTHROPIC_BASE_URL from daemon environment or custom env vars below.'
                        }
                    </Text>
                    <TextInput
                        style={{
                            backgroundColor: profile.isBuiltIn ? theme.colors.surface : theme.colors.input.background,
                            borderRadius: 10, // Matches new session panel input fields
                            padding: 12,
                            fontSize: 16,
                            color: profile.isBuiltIn ? theme.colors.textSecondary : theme.colors.text,
                            marginBottom: 16,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                            opacity: profile.isBuiltIn ? 0.7 : 1,
                        }}
                        placeholder={profile.isBuiltIn ? "Defined by profile" : "https://api.anthropic.com"}
                        value={baseUrl}
                        onChangeText={setBaseUrl}
                        editable={!profile.isBuiltIn}
                    />

                    {/* Auth Token */}
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
                            onPress={() => setUseAuthToken(!useAuthToken)}
                        >
                            <View style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                borderWidth: 2,
                                borderColor: useAuthToken ? theme.colors.button.primary.background : theme.colors.textSecondary,
                                backgroundColor: useAuthToken ? theme.colors.button.primary.background : 'transparent',
                                justifyContent: 'center',
                                alignItems: 'center',
                                marginRight: 8,
                            }}>
                                {useAuthToken && (
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
                            {t('profiles.authToken')} ({t('common.optional')})
                        </Text>
                    </View>
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default()
                    }}>
                        {useAuthToken ? 'Uses this field. Uncheck to use ANTHROPIC_AUTH_TOKEN from daemon environment instead.' : 'Uses ANTHROPIC_AUTH_TOKEN from daemon environment (set when daemon launched)'}
                    </Text>
                    <TextInput
                        style={{
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 10, // Matches new session panel input fields
                            padding: 12,
                            fontSize: 16,
                            color: useAuthToken ? theme.colors.text : theme.colors.textSecondary,
                            marginBottom: 16,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                            opacity: useAuthToken ? 1 : 0.5,
                        }}
                        placeholder={useAuthToken ? t('profiles.enterToken') : 'Disabled - using shell environment'}
                        value={authToken}
                        onChangeText={setAuthToken}
                        secureTextEntry
                        editable={useAuthToken}
                    />

                    {/* Model */}
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
                            onPress={() => setUseModel(!useModel)}
                        >
                            <View style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                borderWidth: 2,
                                borderColor: useModel ? theme.colors.button.primary.background : theme.colors.textSecondary,
                                backgroundColor: useModel ? theme.colors.button.primary.background : 'transparent',
                                justifyContent: 'center',
                                alignItems: 'center',
                                marginRight: 8,
                            }}>
                                {useModel && (
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
                            {t('profiles.model')} ({t('common.optional')})
                        </Text>
                    </View>
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default()
                    }}>
                        {profile.isBuiltIn && extractedModel
                            ? `Read-only - This built-in profile uses: ${extractedModel}\nSee setup instructions above for expected values and model mappings.`
                            : useModel
                                ? 'Uses this field. Uncheck to use system default model (depends on account type and usage tier - typically latest Sonnet).'
                                : 'Uses system default model from Claude CLI (depends on account type and usage tier - typically latest Sonnet)'
                        }
                    </Text>
                    <TextInput
                        style={{
                            backgroundColor: (profile.isBuiltIn || !useModel) ? theme.colors.surface : theme.colors.input.background,
                            borderRadius: 10, // Matches new session panel input fields
                            padding: 12,
                            fontSize: 16,
                            color: (profile.isBuiltIn || !useModel) ? theme.colors.textSecondary : theme.colors.text,
                            marginBottom: modelMappings.opus || modelMappings.sonnet || modelMappings.haiku || modelMappings.smallFast ? 8 : 16,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                            opacity: (profile.isBuiltIn || !useModel) ? 0.5 : 1,
                        }}
                        placeholder={profile.isBuiltIn ? "Defined by profile" : useModel ? "claude-sonnet-4-5-20250929" : "Disabled - using system default"}
                        value={model}
                        onChangeText={setModel}
                        editable={!profile.isBuiltIn && useModel}
                    />

                    {/* Model Mappings (Opus/Sonnet/Haiku) - Only show if any exist */}
                    {(modelMappings.opus || modelMappings.sonnet || modelMappings.haiku || modelMappings.smallFast) && (
                        <View style={{
                            backgroundColor: theme.colors.surface,
                            borderRadius: 8,
                            padding: 12,
                            marginBottom: 16,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                        }}>
                            <Text style={{
                                fontSize: 13,
                                fontWeight: '600',
                                color: theme.colors.text,
                                marginBottom: 8,
                                ...Typography.default('semiBold')
                            }}>
                                Model Mappings (set by daemon environment variables)
                            </Text>
                            {modelMappings.opus && (
                                <View style={{ flexDirection: 'row', marginBottom: 4 }}>
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.textSecondary,
                                        fontWeight: '600',
                                        width: 100,
                                        ...Typography.default('semiBold')
                                    }}>
                                        Opus:
                                    </Text>
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.text,
                                        flex: 1,
                                        ...Typography.default()
                                    }}>
                                        {modelMappings.opus}
                                    </Text>
                                </View>
                            )}
                            {modelMappings.sonnet && (
                                <View style={{ flexDirection: 'row', marginBottom: 4 }}>
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.textSecondary,
                                        fontWeight: '600',
                                        width: 100,
                                        ...Typography.default('semiBold')
                                    }}>
                                        Sonnet:
                                    </Text>
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.text,
                                        flex: 1,
                                        ...Typography.default()
                                    }}>
                                        {modelMappings.sonnet}
                                    </Text>
                                </View>
                            )}
                            {modelMappings.haiku && (
                                <View style={{ flexDirection: 'row', marginBottom: 4 }}>
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.textSecondary,
                                        fontWeight: '600',
                                        width: 100,
                                        ...Typography.default('semiBold')
                                    }}>
                                        Haiku:
                                    </Text>
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.text,
                                        flex: 1,
                                        ...Typography.default()
                                    }}>
                                        {modelMappings.haiku}
                                    </Text>
                                </View>
                            )}
                            {modelMappings.smallFast && (
                                <View style={{ flexDirection: 'row' }}>
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.textSecondary,
                                        fontWeight: '600',
                                        width: 100,
                                        ...Typography.default('semiBold')
                                    }}>
                                        Small/Fast:
                                    </Text>
                                    <Text style={{
                                        fontSize: 12,
                                        color: theme.colors.text,
                                        flex: 1,
                                        ...Typography.default()
                                    }}>
                                        {modelMappings.smallFast}
                                    </Text>
                                </View>
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

                    {/* Custom Environment Variables */}
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
                                onPress={() => setUseCustomEnvVars(!useCustomEnvVars)}
                            >
                                <View style={{
                                    width: 20,
                                    height: 20,
                                    borderRadius: 4,
                                    borderWidth: 2,
                                    borderColor: useCustomEnvVars ? theme.colors.button.primary.background : theme.colors.textSecondary,
                                    backgroundColor: useCustomEnvVars ? theme.colors.button.primary.background : 'transparent',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    marginRight: 8,
                                }}>
                                    {useCustomEnvVars && (
                                        <Ionicons name="checkmark" size={12} color={theme.colors.button.primary.tint} />
                                    )}
                                </View>
                            </Pressable>
                            <Text style={{
                                fontSize: 13,
                                fontWeight: '500',
                                color: theme.colors.textSecondary,
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                Custom Environment Variables
                            </Text>
                        </View>
                        <Text style={{
                            fontSize: 12,
                            color: theme.colors.textSecondary,
                            marginBottom: 12,
                            ...Typography.default()
                        }}>
                            {useCustomEnvVars
                                ? 'Set when spawning each session. Use ${VAR} for daemon env (e.g., ANTHROPIC_AUTH_TOKEN=${Z_AI_AUTH_TOKEN}). Each session can use a different backend (Session 1: Z.AI, Session 2: DeepSeek, etc).'
                                : 'Variables disabled - uses daemon environment as-is (all sessions use same backend)'}
                        </Text>
                        <View style={{
                            flexDirection: 'row',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: 12,
                            opacity: useCustomEnvVars ? 1 : 0.5,
                        }}>
                            <Text style={{
                                fontSize: 14,
                                fontWeight: '600',
                                color: theme.colors.text,
                                ...Typography.default('semiBold')
                            }}>
                                Variables
                            </Text>
                            {useCustomEnvVars && (
                                <Pressable
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        backgroundColor: theme.colors.button.primary.background,
                                        borderRadius: 8,
                                        paddingHorizontal: 12,
                                        paddingVertical: 6,
                                        gap: 6,
                                    }}
                                    onPress={() => setShowAddEnvVar(true)}
                                >
                                    <Ionicons name="add" size={16} color={theme.colors.button.primary.tint} />
                                    <Text style={{
                                        fontSize: 13,
                                        fontWeight: '600',
                                        color: theme.colors.button.primary.tint,
                                        ...Typography.default('semiBold')
                                    }}>
                                        Add Variable
                                    </Text>
                                </Pressable>
                            )}
                        </View>

                        {/* Display existing custom environment variables */}
                        {Object.entries(customEnvVars).map(([key, value]) => {
                            const evaluatedValue = machineId ? evaluateEnvVar(value) : null;
                            const isTokenOrSecret = key.includes('TOKEN') || key.includes('KEY') || key.includes('SECRET');

                            return (
                                <View key={key} style={{
                                    backgroundColor: theme.colors.input.background,
                                    borderRadius: 10, // Matches new session panel items
                                    padding: 12,
                                    marginBottom: 8,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    opacity: useCustomEnvVars ? 1 : 0.5,
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
                                            Mapping: {value}
                                        </Text>
                                        {machineId && !isTokenOrSecret && (
                                            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: theme.colors.textSecondary,
                                                    marginRight: 4,
                                                    ...Typography.default()
                                                }}>
                                                    Evaluates to:
                                                </Text>
                                                {evaluatedValue === undefined ? (
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: theme.colors.textSecondary,
                                                        fontStyle: 'italic',
                                                        ...Typography.default()
                                                    }}>
                                                        Loading...
                                                    </Text>
                                                ) : evaluatedValue === null ? (
                                                    <>
                                                        <Ionicons name="alert-circle" size={11} color={theme.colors.warning} style={{ marginRight: 2 }} />
                                                        <Text style={{
                                                            fontSize: 11,
                                                            color: theme.colors.warning,
                                                            ...Typography.default()
                                                        }}>
                                                            Not set on remote
                                                        </Text>
                                                    </>
                                                ) : (
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: theme.colors.success,
                                                        ...Typography.default()
                                                    }}>
                                                        {evaluatedValue}
                                                    </Text>
                                                )}
                                            </View>
                                        )}
                                        {isTokenOrSecret && (
                                            <Text style={{
                                                fontSize: 11,
                                                color: theme.colors.textSecondary,
                                                marginTop: 4,
                                                fontStyle: 'italic',
                                                ...Typography.default()
                                            }}>
                                                🔒 Secret value - not retrieved for security
                                            </Text>
                                        )}
                                    </View>
                                    <Pressable
                                        style={{
                                            padding: 4,
                                            marginLeft: 8,
                                        }}
                                        onPress={() => useCustomEnvVars && handleRemoveEnvVar(key)}
                                        disabled={!useCustomEnvVars}
                                    >
                                        <Ionicons name="remove-circle" size={20} color="#FF6B6B" />
                                    </Pressable>
                                </View>
                            );
                        })}

                        {/* Add new environment variable form */}
                        {showAddEnvVar && (
                            <View style={{
                                backgroundColor: theme.colors.input.background,
                                borderRadius: 10, // Matches new session panel items
                                padding: 12,
                                marginBottom: 8,
                                borderWidth: 2,
                                borderColor: theme.colors.button.primary.background,
                            }}>
                                <TextInput
                                    style={{
                                        backgroundColor: theme.colors.surface,
                                        borderRadius: 10, // Matches new session panel input fields
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
                                        borderRadius: 10, // Matches new session panel input fields
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
        borderRadius: 16, // Matches new session panel main container
        padding: 20,
        width: '100%',
    },
}));
