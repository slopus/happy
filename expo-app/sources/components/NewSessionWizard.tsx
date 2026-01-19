import React, { useState, useMemo } from 'react';
import { View, Text, Pressable, ScrollView, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { PermissionModeSelector, PermissionMode, ModelMode } from '@/components/PermissionModeSelector';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllMachines, useSessions, useSetting, storage } from '@/sync/storage';
import { useRouter } from 'expo-router';
import { AIBackendProfile, validateProfileForAgent, getProfileEnvironmentVariables } from '@/sync/settings';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { profileSyncService } from '@/sync/profileSync';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 24,
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    stepIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    stepDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginHorizontal: 4,
    },
    stepDotActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    stepDotInactive: {
        backgroundColor: theme.colors.divider,
    },
    stepContent: {
        flex: 1,
        paddingHorizontal: 24,
        paddingTop: 24,
        paddingBottom: 0, // No bottom padding since footer is separate
    },
    stepTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    stepDescription: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 24,
        ...Typography.default(),
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 24,
        paddingVertical: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface, // Ensure footer has solid background
    },
    button: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 8,
        minWidth: 100,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    buttonTextPrimary: {
        color: '#FFFFFF',
    },
    buttonTextSecondary: {
        color: theme.colors.text,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        ...Typography.default(),
    },
    agentOption: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderRadius: 12,
        borderWidth: 2,
        marginBottom: 12,
    },
    agentOptionSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.input.background,
    },
    agentOptionUnselected: {
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
    },
    agentIcon: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: theme.colors.button.primary.background,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 16,
    },
    agentInfo: {
        flex: 1,
    },
    agentName: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    agentDescription: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginTop: 4,
        ...Typography.default(),
    },
}));

type WizardStep = 'profile' | 'profileConfig' | 'sessionType' | 'agent' | 'options' | 'machine' | 'path' | 'prompt';

// Profile selection item component with management actions
interface ProfileSelectionItemProps {
    profile: AIBackendProfile;
    isSelected: boolean;
    onSelect: () => void;
    onUseAsIs: () => void;
    onEdit: () => void;
    onDuplicate?: () => void;
    onDelete?: () => void;
    showManagementActions?: boolean;
}

function ProfileSelectionItem({ profile, isSelected, onSelect, onUseAsIs, onEdit, onDuplicate, onDelete, showManagementActions = false }: ProfileSelectionItemProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={{
            backgroundColor: isSelected ? theme.colors.input.background : 'transparent',
            borderRadius: 12,
            borderWidth: isSelected ? 2 : 1,
            borderColor: isSelected ? theme.colors.button.primary.background : theme.colors.divider,
            marginBottom: 12,
            padding: 4,
        }}>
            {/* Profile Header */}
            <Pressable onPress={onSelect} style={{ padding: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: theme.colors.button.primary.background,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: 12,
                    }}>
                        <Ionicons
                            name="person-outline"
                            size={20}
                            color="white"
                        />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.text,
                            marginBottom: 4,
                            ...Typography.default('semiBold'),
                        }}>
                            {profile.name}
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}>
                            {profile.description}
                        </Text>
                        {profile.isBuiltIn && (
                            <Text style={{
                                fontSize: 12,
                                color: theme.colors.textSecondary,
                                marginTop: 2,
                            }}>
                                Built-in profile
                            </Text>
                        )}
                    </View>
                    {isSelected && (
                        <Ionicons
                            name="checkmark-circle"
                            size={20}
                            color={theme.colors.button.primary.background}
                        />
                    )}
                </View>
            </Pressable>

            {/* Action Buttons - Only show when selected */}
            {isSelected && (
                <View style={{
                    flexDirection: 'column',
                    paddingHorizontal: 12,
                    paddingBottom: 12,
                    gap: 8,
                }}>
                    {/* Primary Actions */}
                    <View style={{
                        flexDirection: 'row',
                        gap: 8,
                    }}>
                        <Pressable
                            style={{
                                flex: 1,
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                                paddingVertical: 8,
                                paddingHorizontal: 12,
                                borderRadius: 8,
                                backgroundColor: theme.colors.button.primary.background,
                            }}
                            onPress={onUseAsIs}
                        >
                            <Ionicons name="checkmark" size={16} color="white" />
                            <Text style={{
                                color: 'white',
                                fontSize: 14,
                                fontWeight: '600',
                                marginLeft: 6,
                                ...Typography.default('semiBold'),
                            }}>
                                Use As-Is
                            </Text>
                        </Pressable>

                        <Pressable
                            style={{
                                flex: 1,
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                                paddingVertical: 8,
                                paddingHorizontal: 12,
                                borderRadius: 8,
                                backgroundColor: 'transparent',
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                            }}
                            onPress={onEdit}
                        >
                            <Ionicons name="create-outline" size={16} color={theme.colors.text} />
                            <Text style={{
                                color: theme.colors.text,
                                fontSize: 14,
                                fontWeight: '600',
                                marginLeft: 6,
                                ...Typography.default('semiBold'),
                            }}>
                                Edit
                            </Text>
                        </Pressable>
                    </View>

                    {/* Management Actions - Only show for custom profiles */}
                    {showManagementActions && !profile.isBuiltIn && (
                        <View style={{
                            flexDirection: 'row',
                            gap: 8,
                        }}>
                            <Pressable
                                style={{
                                    flex: 1,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    paddingVertical: 6,
                                    paddingHorizontal: 8,
                                    borderRadius: 6,
                                    backgroundColor: 'transparent',
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                }}
                                onPress={onDuplicate}
                            >
                                <Ionicons name="copy-outline" size={14} color={theme.colors.textSecondary} />
                                <Text style={{
                                    color: theme.colors.textSecondary,
                                    fontSize: 12,
                                    fontWeight: '600',
                                    marginLeft: 4,
                                    ...Typography.default('semiBold'),
                                }}>
                                    Duplicate
                                </Text>
                            </Pressable>

                            <Pressable
                                style={{
                                    flex: 1,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    paddingVertical: 6,
                                    paddingHorizontal: 8,
                                    borderRadius: 6,
                                    backgroundColor: 'transparent',
                                    borderWidth: 1,
                                    borderColor: theme.colors.textDestructive,
                                }}
                                onPress={onDelete}
                            >
                                <Ionicons name="trash-outline" size={14} color={theme.colors.textDestructive} />
                                <Text style={{
                                    color: theme.colors.textDestructive,
                                    fontSize: 12,
                                    fontWeight: '600',
                                    marginLeft: 4,
                                    ...Typography.default('semiBold'),
                                }}>
                                    Delete
                                </Text>
                            </Pressable>
                        </View>
                    )}
                </View>
            )}
        </View>
    );
}

// Manual configuration item component
interface ManualConfigurationItemProps {
    isSelected: boolean;
    onSelect: () => void;
    onUseCliVars: () => void;
    onConfigureManually: () => void;
}

function ManualConfigurationItem({ isSelected, onSelect, onUseCliVars, onConfigureManually }: ManualConfigurationItemProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={{
            backgroundColor: isSelected ? theme.colors.input.background : 'transparent',
            borderRadius: 12,
            borderWidth: isSelected ? 2 : 1,
            borderColor: isSelected ? theme.colors.button.primary.background : theme.colors.divider,
            marginBottom: 12,
            padding: 4,
        }}>
            {/* Profile Header */}
            <Pressable onPress={onSelect} style={{ padding: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: theme.colors.textSecondary,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: 12,
                    }}>
                        <Ionicons
                            name="settings"
                            size={20}
                            color="white"
                        />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.text,
                            marginBottom: 4,
                            ...Typography.default('semiBold'),
                        }}>
                            Manual Configuration
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}>
                            Use CLI environment variables or configure manually
                        </Text>
                    </View>
                    {isSelected && (
                        <Ionicons
                            name="checkmark-circle"
                            size={20}
                            color={theme.colors.button.primary.background}
                        />
                    )}
                </View>
            </Pressable>

            {/* Action Buttons - Only show when selected */}
            {isSelected && (
                <View style={{
                    flexDirection: 'row',
                    paddingHorizontal: 12,
                    paddingBottom: 12,
                    gap: 8,
                }}>
                    <Pressable
                        style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            paddingVertical: 8,
                            paddingHorizontal: 12,
                            borderRadius: 8,
                            backgroundColor: theme.colors.button.primary.background,
                        }}
                        onPress={onUseCliVars}
                    >
                        <Ionicons name="terminal-outline" size={16} color="white" />
                        <Text style={{
                            color: 'white',
                            fontSize: 14,
                            fontWeight: '600',
                            marginLeft: 6,
                            ...Typography.default('semiBold'),
                        }}>
                            Use CLI Vars
                        </Text>
                    </Pressable>

                    <Pressable
                        style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            paddingVertical: 8,
                            paddingHorizontal: 12,
                            borderRadius: 8,
                            backgroundColor: 'transparent',
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                        }}
                        onPress={onConfigureManually}
                    >
                        <Ionicons name="create-outline" size={16} color={theme.colors.text} />
                        <Text style={{
                            color: theme.colors.text,
                            fontSize: 14,
                            fontWeight: '600',
                            marginLeft: 6,
                            ...Typography.default('semiBold'),
                        }}>
                            Configure
                        </Text>
                    </Pressable>
                </View>
            )}
        </View>
    );
}

interface NewSessionWizardProps {
    onComplete: (config: {
        sessionType: 'simple' | 'worktree';
        profileId: string | null;
        agentType: 'claude' | 'codex';
        permissionMode: PermissionMode;
        modelMode: ModelMode;
        machineId: string;
        path: string;
        prompt: string;
        environmentVariables?: Record<string, string>;
    }) => void;
    onCancel: () => void;
    initialPrompt?: string;
}

export function NewSessionWizard({ onComplete, onCancel, initialPrompt = '' }: NewSessionWizardProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const machines = useAllMachines();
    const sessions = useSessions();
    const experimentsEnabled = useSetting('experiments');
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');
    const lastUsedModelMode = useSetting('lastUsedModelMode');
    const profiles = useSetting('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');

    // Wizard state
    const [currentStep, setCurrentStep] = useState<WizardStep>('profile');
    const [sessionType, setSessionType] = useState<'simple' | 'worktree'>('simple');
    const [agentType, setAgentType] = useState<'claude' | 'codex'>(() => {
        if (lastUsedAgent === 'claude' || lastUsedAgent === 'codex') {
            return lastUsedAgent;
        }
        return 'claude';
    });
    const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
    const [modelMode, setModelMode] = useState<ModelMode>('default');
    const [selectedProfileId, setSelectedProfileId] = useState<string | null>(() => {
        return lastUsedProfile;
    });

    // Built-in profiles
    const builtInProfiles: AIBackendProfile[] = useMemo(() => [
        {
            id: 'anthropic',
            name: 'Anthropic (Default)',
            description: 'Default Claude configuration',
            anthropicConfig: {},
            environmentVariables: [],
            compatibility: { claude: true, codex: false, gemini: false },
            isBuiltIn: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        },
        {
            id: 'deepseek',
            name: 'DeepSeek (Reasoner)',
            description: 'DeepSeek reasoning model with proxy to Anthropic API',
            anthropicConfig: {
                baseUrl: 'https://api.deepseek.com/anthropic',
                model: 'deepseek-reasoner',
            },
            environmentVariables: [
                { name: 'API_TIMEOUT_MS', value: '600000' },
                { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: 'deepseek-chat' },
                { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
            ],
            compatibility: { claude: true, codex: false, gemini: false },
            isBuiltIn: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        },
        {
            id: 'openai',
            name: 'OpenAI (GPT-4/Codex)',
            description: 'OpenAI GPT-4 and Codex models',
            openaiConfig: {
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4-turbo',
            },
            environmentVariables: [],
            compatibility: { claude: false, codex: true, gemini: false },
            isBuiltIn: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        },
        {
            id: 'azure-openai-codex',
            name: 'Azure OpenAI (Codex)',
            description: 'Microsoft Azure OpenAI for Codex agents',
            azureOpenAIConfig: {
                endpoint: 'https://your-resource.openai.azure.com/',
                apiVersion: '2024-02-15-preview',
                deploymentName: 'gpt-4-turbo',
            },
            environmentVariables: [],
            compatibility: { claude: false, codex: true, gemini: false },
            isBuiltIn: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        },
        {
            id: 'azure-openai',
            name: 'Azure OpenAI',
            description: 'Microsoft Azure OpenAI configuration',
            azureOpenAIConfig: {
                apiVersion: '2024-02-15-preview',
            },
            environmentVariables: [
                { name: 'AZURE_OPENAI_API_VERSION', value: '2024-02-15-preview' },
            ],
            compatibility: { claude: false, codex: true, gemini: false },
            isBuiltIn: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        },
        {
            id: 'zai',
            name: 'Z.ai (GLM-4.6)',
            description: 'Z.ai GLM-4.6 model with proxy to Anthropic API',
            anthropicConfig: {
                baseUrl: 'https://api.z.ai/api/anthropic',
                model: 'glm-4.6',
            },
            environmentVariables: [],
            compatibility: { claude: true, codex: false, gemini: false },
            isBuiltIn: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        },
        {
            id: 'microsoft',
            name: 'Microsoft Azure',
            description: 'Microsoft Azure AI services',
            openaiConfig: {
                baseUrl: 'https://api.openai.azure.com',
                model: 'gpt-4-turbo',
            },
            environmentVariables: [],
            compatibility: { claude: false, codex: true, gemini: false },
            isBuiltIn: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        },
    ], []);

    // Combined profiles
    const allProfiles = useMemo(() => {
        return [...builtInProfiles, ...profiles];
    }, [profiles, builtInProfiles]);

    const [selectedMachineId, setSelectedMachineId] = useState<string>(() => {
        if (machines.length > 0) {
            // Check if we have a recently used machine that's currently available
            if (recentMachinePaths.length > 0) {
                for (const recent of recentMachinePaths) {
                    if (machines.find(m => m.id === recent.machineId)) {
                        return recent.machineId;
                    }
                }
            }
            return machines[0].id;
        }
        return '';
    });
    const [selectedPath, setSelectedPath] = useState<string>(() => {
        if (machines.length > 0 && selectedMachineId) {
            const machine = machines.find(m => m.id === selectedMachineId);
            return machine?.metadata?.homeDir || '/home';
        }
        return '/home';
    });
    const [prompt, setPrompt] = useState<string>(initialPrompt);
    const [customPath, setCustomPath] = useState<string>('');
    const [showCustomPathInput, setShowCustomPathInput] = useState<boolean>(false);

    // Profile configuration state
    const [profileApiKeys, setProfileApiKeys] = useState<Record<string, Record<string, string>>>({});
    const [profileConfigs, setProfileConfigs] = useState<Record<string, Record<string, string>>>({});

    // Dynamic steps based on whether profile needs configuration
    const steps: WizardStep[] = React.useMemo(() => {
        const baseSteps: WizardStep[] = experimentsEnabled
            ? ['profile', 'sessionType', 'agent', 'options', 'machine', 'path', 'prompt']
            : ['profile', 'agent', 'options', 'machine', 'path', 'prompt'];

        // Insert profileConfig step after profile if needed
        if (profileNeedsConfiguration(selectedProfileId)) {
            const profileIndex = baseSteps.indexOf('profile');
            const beforeProfile = baseSteps.slice(0, profileIndex + 1) as WizardStep[];
            const afterProfile = baseSteps.slice(profileIndex + 1) as WizardStep[];
            return [
                ...beforeProfile,
                'profileConfig',
                ...afterProfile
            ] as WizardStep[];
        }

        return baseSteps;
    }, [experimentsEnabled, selectedProfileId]);

    // Helper function to check if profile needs API keys
    const profileNeedsConfiguration = (profileId: string | null): boolean => {
        if (!profileId) return false; // Manual configuration doesn't need API keys
        const profile = allProfiles.find(p => p.id === profileId);
        if (!profile) return false;

        // Check if profile is one that requires API keys
        const profilesNeedingKeys = ['openai', 'azure-openai', 'azure-openai-codex', 'zai', 'microsoft', 'deepseek'];
        return profilesNeedingKeys.includes(profile.id);
    };

    // Get required fields for profile configuration
    const getProfileRequiredFields = (profileId: string | null): Array<{key: string, label: string, placeholder: string, isPassword?: boolean}> => {
        if (!profileId) return [];
        const profile = allProfiles.find(p => p.id === profileId);
        if (!profile) return [];

        switch (profile.id) {
            case 'deepseek':
                return [
                    { key: 'ANTHROPIC_AUTH_TOKEN', label: 'DeepSeek API Key', placeholder: 'DEEPSEEK_API_KEY', isPassword: true }
                ];
            case 'openai':
                return [
                    { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', placeholder: 'sk-...', isPassword: true }
                ];
            case 'azure-openai':
                return [
                    { key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI API Key', placeholder: 'Enter your Azure OpenAI API key', isPassword: true },
                    { key: 'AZURE_OPENAI_ENDPOINT', label: 'Azure Endpoint', placeholder: 'https://your-resource.openai.azure.com/' },
                    { key: 'AZURE_OPENAI_DEPLOYMENT_NAME', label: 'Deployment Name', placeholder: 'gpt-4-turbo' }
                ];
            case 'zai':
                return [
                    { key: 'ANTHROPIC_AUTH_TOKEN', label: 'Z.ai API Key', placeholder: 'Z_AI_API_KEY', isPassword: true }
                ];
            case 'microsoft':
                return [
                    { key: 'AZURE_OPENAI_API_KEY', label: 'Azure API Key', placeholder: 'Enter your Azure API key', isPassword: true },
                    { key: 'AZURE_OPENAI_ENDPOINT', label: 'Azure Endpoint', placeholder: 'https://your-resource.openai.azure.com/' },
                    { key: 'AZURE_OPENAI_DEPLOYMENT_NAME', label: 'Deployment Name', placeholder: 'gpt-4-turbo' }
                ];
            case 'azure-openai-codex':
                return [
                    { key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI API Key', placeholder: 'Enter your Azure OpenAI API key', isPassword: true },
                    { key: 'AZURE_OPENAI_ENDPOINT', label: 'Azure Endpoint', placeholder: 'https://your-resource.openai.azure.com/' },
                    { key: 'AZURE_OPENAI_DEPLOYMENT_NAME', label: 'Deployment Name', placeholder: 'gpt-4-turbo' }
                ];
            default:
                return [];
        }
    };

    // Auto-load profile settings and sync with CLI
    React.useEffect(() => {
        if (selectedProfileId) {
            const selectedProfile = allProfiles.find(p => p.id === selectedProfileId);
            if (selectedProfile) {
                // Auto-select agent type based on profile compatibility
                if (selectedProfile.compatibility.claude && !selectedProfile.compatibility.codex) {
                    setAgentType('claude');
                } else if (selectedProfile.compatibility.codex && !selectedProfile.compatibility.claude) {
                    setAgentType('codex');
                }

                // Sync active profile to CLI
                profileSyncService.setActiveProfile(selectedProfileId).catch(error => {
                    console.error('[Wizard] Failed to sync active profile to CLI:', error);
                });
            }
        }
    }, [selectedProfileId, allProfiles]);

    // Sync profiles with CLI on component mount and when profiles change
    React.useEffect(() => {
        const syncProfiles = async () => {
            try {
                await profileSyncService.bidirectionalSync(allProfiles);
            } catch (error) {
                console.error('[Wizard] Failed to sync profiles with CLI:', error);
                // Continue without sync - profiles work locally
            }
        };

        // Sync on mount
        syncProfiles();

        // Set up sync listener for profile changes
        const handleSyncEvent = (event: any) => {
            if (event.status === 'error') {
                console.warn('[Wizard] Profile sync error:', event.error);
            }
        };

        profileSyncService.addEventListener(handleSyncEvent);

        return () => {
            profileSyncService.removeEventListener(handleSyncEvent);
        };
    }, [allProfiles]);

    // Get recent paths for the selected machine
    const recentPaths = useMemo(() => {
        if (!selectedMachineId) return [];

        const paths: string[] = [];
        const pathSet = new Set<string>();

        // First, add paths from recentMachinePaths (these are the most recent)
        recentMachinePaths.forEach(entry => {
            if (entry.machineId === selectedMachineId && !pathSet.has(entry.path)) {
                paths.push(entry.path);
                pathSet.add(entry.path);
            }
        });

        // Then add paths from sessions if we need more
        if (sessions) {
            const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];

            sessions.forEach(item => {
                if (typeof item === 'string') return; // Skip section headers

                const session = item as any;
                if (session.metadata?.machineId === selectedMachineId && session.metadata?.path) {
                    const path = session.metadata.path;
                    if (!pathSet.has(path)) {
                        pathSet.add(path);
                        pathsWithTimestamps.push({
                            path,
                            timestamp: session.updatedAt || session.createdAt
                        });
                    }
                }
            });

            // Sort session paths by most recent first and add them
            pathsWithTimestamps
                .sort((a, b) => b.timestamp - a.timestamp)
                .forEach(item => paths.push(item.path));
        }

        return paths;
    }, [sessions, selectedMachineId, recentMachinePaths]);

    const currentStepIndex = steps.indexOf(currentStep);
    const isFirstStep = currentStepIndex === 0;
    const isLastStep = currentStepIndex === steps.length - 1;

    // Handler for "Use Profile As-Is" - quick session creation
    const handleUseProfileAsIs = (profile: AIBackendProfile) => {
        setSelectedProfileId(profile.id);

        // Auto-select agent type based on profile compatibility
        if (profile.compatibility.claude && !profile.compatibility.codex) {
            setAgentType('claude');
        } else if (profile.compatibility.codex && !profile.compatibility.claude) {
            setAgentType('codex');
        }

        // Get environment variables from profile (no user configuration)
        const environmentVariables = getProfileEnvironmentVariables(profile);

        // Complete wizard immediately with profile settings
        onComplete({
            sessionType,
            profileId: profile.id,
            agentType: agentType || (profile.compatibility.claude ? 'claude' : 'codex'),
            permissionMode,
            modelMode,
            machineId: selectedMachineId,
            path: showCustomPathInput && customPath.trim() ? customPath.trim() : selectedPath,
            prompt,
            environmentVariables,
        });
    };

    // Handler for "Edit Profile" - load profile and go to configuration step
    const handleEditProfile = (profile: AIBackendProfile) => {
        setSelectedProfileId(profile.id);

        // Auto-select agent type based on profile compatibility
        if (profile.compatibility.claude && !profile.compatibility.codex) {
            setAgentType('claude');
        } else if (profile.compatibility.codex && !profile.compatibility.claude) {
            setAgentType('codex');
        }

        // If profile needs configuration, go to profileConfig step
        if (profileNeedsConfiguration(profile.id)) {
            setCurrentStep('profileConfig');
        } else {
            // If no configuration needed, proceed to next step in the normal flow
            const profileIndex = steps.indexOf('profile');
            setCurrentStep(steps[profileIndex + 1]);
        }
    };

    // Handler for "Create New Profile"
    const handleCreateProfile = () => {
        Modal.prompt(
            'Create New Profile',
            'Enter a name for your new profile:',
            {
                defaultValue: 'My Custom Profile',
                confirmText: 'Create',
                cancelText: 'Cancel'
            }
        ).then((profileName) => {
            if (profileName && profileName.trim()) {
                const newProfile: AIBackendProfile = {
                    id: crypto.randomUUID(),
                    name: profileName.trim(),
                    description: 'Custom AI profile',
                    anthropicConfig: {},
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true, gemini: true },
                    isBuiltIn: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    version: '1.0.0',
                };

                // Get current profiles from settings
                const currentProfiles = storage.getState().settings.profiles || [];
                const updatedProfiles = [...currentProfiles, newProfile];

                // Persist through settings system
                sync.applySettings({ profiles: updatedProfiles });

                // Sync with CLI
                profileSyncService.syncGuiToCli(updatedProfiles).catch(error => {
                    console.error('[Wizard] Failed to sync new profile with CLI:', error);
                });

                // Auto-select the newly created profile
                setSelectedProfileId(newProfile.id);
            }
        });
    };

    // Handler for "Duplicate Profile"
    const handleDuplicateProfile = (profile: AIBackendProfile) => {
        Modal.prompt(
            'Duplicate Profile',
            `Enter a name for the duplicate of "${profile.name}":`,
            {
                defaultValue: `${profile.name} (Copy)`,
                confirmText: 'Duplicate',
                cancelText: 'Cancel'
            }
        ).then((newName) => {
            if (newName && newName.trim()) {
                const duplicatedProfile: AIBackendProfile = {
                    ...profile,
                    id: crypto.randomUUID(),
                    name: newName.trim(),
                    description: profile.description ? `Copy of ${profile.description}` : 'Custom AI profile',
                    isBuiltIn: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };

                // Get current profiles from settings
                const currentProfiles = storage.getState().settings.profiles || [];
                const updatedProfiles = [...currentProfiles, duplicatedProfile];

                // Persist through settings system
                sync.applySettings({ profiles: updatedProfiles });

                // Sync with CLI
                profileSyncService.syncGuiToCli(updatedProfiles).catch(error => {
                    console.error('[Wizard] Failed to sync duplicated profile with CLI:', error);
                });
            }
        });
    };

    // Handler for "Delete Profile"
    const handleDeleteProfile = (profile: AIBackendProfile) => {
        Modal.confirm(
            'Delete Profile',
            `Are you sure you want to delete "${profile.name}"? This action cannot be undone.`,
            {
                confirmText: 'Delete',
                destructive: true
            }
        ).then((confirmed) => {
            if (confirmed) {
                // Get current profiles from settings
                const currentProfiles = storage.getState().settings.profiles || [];
                const updatedProfiles = currentProfiles.filter(p => p.id !== profile.id);

                // Persist through settings system
                sync.applySettings({ profiles: updatedProfiles });

                // Sync with CLI
                profileSyncService.syncGuiToCli(updatedProfiles).catch(error => {
                    console.error('[Wizard] Failed to sync profile deletion with CLI:', error);
                });

                // Clear selection if deleted profile was selected
                if (selectedProfileId === profile.id) {
                    setSelectedProfileId(null);
                }
            }
        });
    };

    // Handler for "Use CLI Environment Variables" - quick session creation with CLI vars
    const handleUseCliEnvironmentVariables = () => {
        setSelectedProfileId(null);

        // Complete wizard immediately with no profile (rely on CLI environment variables)
        onComplete({
            sessionType,
            profileId: null,
            agentType,
            permissionMode,
            modelMode,
            machineId: selectedMachineId,
            path: showCustomPathInput && customPath.trim() ? customPath.trim() : selectedPath,
            prompt,
            environmentVariables: undefined, // Let CLI handle environment variables
        });
    };

    // Handler for "Manual Configuration" - go through normal wizard flow
    const handleManualConfiguration = () => {
        setSelectedProfileId(null);

        // Proceed to next step in normal wizard flow
        const profileIndex = steps.indexOf('profile');
        setCurrentStep(steps[profileIndex + 1]);
    };

    const handleNext = () => {
        // Special handling for profileConfig step - skip if profile doesn't need configuration
        if (currentStep === 'profileConfig' && (!selectedProfileId || !profileNeedsConfiguration(selectedProfileId))) {
            setCurrentStep(steps[currentStepIndex + 1]);
            return;
        }

        if (isLastStep) {
            // Get environment variables from selected profile with proper precedence handling
            let environmentVariables: Record<string, string> | undefined;
            if (selectedProfileId) {
                const selectedProfile = allProfiles.find(p => p.id === selectedProfileId);
                if (selectedProfile) {
                    // Start with profile environment variables (base configuration)
                    environmentVariables = getProfileEnvironmentVariables(selectedProfile);

                    // Only add user-provided API keys if they're non-empty
                    // This preserves CLI environment variable precedence when wizard fields are empty
                    const userApiKeys = profileApiKeys[selectedProfileId];
                    if (userApiKeys) {
                        Object.entries(userApiKeys).forEach(([key, value]) => {
                            // Only override if user provided a non-empty value
                            if (value && value.trim().length > 0) {
                                environmentVariables![key] = value;
                            }
                        });
                    }

                    // Only add user configurations if they're non-empty
                    const userConfigs = profileConfigs[selectedProfileId];
                    if (userConfigs) {
                        Object.entries(userConfigs).forEach(([key, value]) => {
                            // Only override if user provided a non-empty value
                            if (value && value.trim().length > 0) {
                                environmentVariables![key] = value;
                            }
                        });
                    }
                }
            }

            onComplete({
                sessionType,
                profileId: selectedProfileId,
                agentType,
                permissionMode,
                modelMode,
                machineId: selectedMachineId,
                path: showCustomPathInput && customPath.trim() ? customPath.trim() : selectedPath,
                prompt,
                environmentVariables,
            });
        } else {
            setCurrentStep(steps[currentStepIndex + 1]);
        }
    };

    const handleBack = () => {
        if (isFirstStep) {
            onCancel();
        } else {
            setCurrentStep(steps[currentStepIndex - 1]);
        }
    };

    const canProceed = useMemo(() => {
        switch (currentStep) {
            case 'profile':
                return true; // Always valid (profile can be null for manual config)
            case 'profileConfig':
                if (!selectedProfileId) return false;
                const requiredFields = getProfileRequiredFields(selectedProfileId);
                // Profile configuration step is always shown when needed
                // Users can leave fields empty to preserve CLI environment variables
                return true;
            case 'sessionType':
                return true; // Always valid
            case 'agent':
                return true; // Always valid
            case 'options':
                return true; // Always valid
            case 'machine':
                return selectedMachineId.length > 0;
            case 'path':
                return (selectedPath.trim().length > 0) || (showCustomPathInput && customPath.trim().length > 0);
            case 'prompt':
                return prompt.trim().length > 0;
            default:
                return false;
        }
    }, [currentStep, selectedMachineId, selectedPath, prompt, showCustomPathInput, customPath, selectedProfileId, profileApiKeys, profileConfigs, getProfileRequiredFields]);

    const renderStepContent = () => {
        switch (currentStep) {
            case 'profile':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Choose AI Profile</Text>
                        <Text style={styles.stepDescription}>
                            Select a pre-configured AI profile or set up manually
                        </Text>

                        <ItemGroup title="Built-in Profiles">
                            {builtInProfiles.map((profile) => (
                                <ProfileSelectionItem
                                    key={profile.id}
                                    profile={profile}
                                    isSelected={selectedProfileId === profile.id}
                                    onSelect={() => setSelectedProfileId(profile.id)}
                                    onUseAsIs={() => handleUseProfileAsIs(profile)}
                                    onEdit={() => handleEditProfile(profile)}
                                />
                            ))}
                        </ItemGroup>

                        {profiles.length > 0 && (
                            <ItemGroup title="Custom Profiles">
                                {profiles.map((profile) => (
                                    <ProfileSelectionItem
                                        key={profile.id}
                                        profile={profile}
                                        isSelected={selectedProfileId === profile.id}
                                        onSelect={() => setSelectedProfileId(profile.id)}
                                        onUseAsIs={() => handleUseProfileAsIs(profile)}
                                        onEdit={() => handleEditProfile(profile)}
                                        onDuplicate={() => handleDuplicateProfile(profile)}
                                        onDelete={() => handleDeleteProfile(profile)}
                                        showManagementActions={true}
                                    />
                                ))}
                            </ItemGroup>
                        )}

                        {/* Create New Profile Button */}
                        <Pressable
                            style={{
                                backgroundColor: theme.colors.input.background,
                                borderRadius: 12,
                                borderWidth: 2,
                                borderColor: theme.colors.button.primary.background,
                                borderStyle: 'dashed',
                                padding: 16,
                                marginBottom: 12,
                            }}
                            onPress={handleCreateProfile}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                                <View style={{
                                    width: 40,
                                    height: 40,
                                    borderRadius: 20,
                                    backgroundColor: theme.colors.button.primary.background,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    marginRight: 12,
                                }}>
                                    <Ionicons name="add" size={20} color="white" />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={{
                                        fontSize: 16,
                                        fontWeight: '600',
                                        color: theme.colors.text,
                                        marginBottom: 4,
                                        ...Typography.default('semiBold'),
                                    }}>
                                        Create New Profile
                                    </Text>
                                    <Text style={{
                                        fontSize: 14,
                                        color: theme.colors.textSecondary,
                                        ...Typography.default(),
                                    }}>
                                        Set up a custom AI backend configuration
                                    </Text>
                                </View>
                            </View>
                        </Pressable>

                        <ItemGroup title="Manual Configuration">
                            <ManualConfigurationItem
                                isSelected={selectedProfileId === null}
                                onSelect={() => setSelectedProfileId(null)}
                                onUseCliVars={() => handleUseCliEnvironmentVariables()}
                                onConfigureManually={() => handleManualConfiguration()}
                            />
                        </ItemGroup>

                        <View style={{
                            backgroundColor: theme.colors.input.background,
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            marginTop: 16,
                        }}>
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                marginBottom: 4,
                            }}>
                                💡 **Profile Selection Options:**
                            </Text>
                            <Text style={{
                                fontSize: 12,
                                color: theme.colors.textSecondary,
                                marginTop: 4,
                            }}>
                                • **Use As-Is**: Quick session creation with current profile settings
                            </Text>
                            <Text style={{
                                fontSize: 12,
                                color: theme.colors.textSecondary,
                                marginTop: 4,
                            }}>
                                • **Edit**: Configure API keys and settings before session creation
                            </Text>
                            <Text style={{
                                fontSize: 12,
                                color: theme.colors.textSecondary,
                                marginTop: 4,
                            }}>
                                • **Manual**: Use CLI environment variables without profile configuration
                            </Text>
                        </View>
                    </View>
                );

            case 'profileConfig':
                if (!selectedProfileId || !profileNeedsConfiguration(selectedProfileId)) {
                    // Skip configuration if no profile selected or profile doesn't need configuration
                    setCurrentStep(steps[currentStepIndex + 1]);
                    return null;
                }

                return (
                    <View>
                        <Text style={styles.stepTitle}>Configure {allProfiles.find(p => p.id === selectedProfileId)?.name || 'Profile'}</Text>
                        <Text style={styles.stepDescription}>
                            Enter your API keys and configuration details
                        </Text>

                        <ItemGroup title="Required Configuration">
                            {getProfileRequiredFields(selectedProfileId).map((field) => (
                                <View key={field.key} style={{ marginBottom: 16 }}>
                                    <Text style={{
                                        fontSize: 16,
                                        fontWeight: '600',
                                        color: theme.colors.text,
                                        marginBottom: 8,
                                        ...Typography.default('semiBold'),
                                    }}>
                                        {field.label}
                                    </Text>
                                    <TextInput
                                        style={[
                                            styles.textInput,
                                            { fontFamily: 'monospace' } // Monospace font for API keys
                                        ]}
                                        placeholder={field.placeholder}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        value={(profileApiKeys[selectedProfileId!] as any)?.[field.key] || (profileConfigs[selectedProfileId!] as any)?.[field.key] || ''}
                                        onChangeText={(text) => {
                                            if (field.isPassword) {
                                                // API key
                                                setProfileApiKeys(prev => ({
                                                    ...prev,
                                                    [selectedProfileId!]: {
                                                        ...(prev[selectedProfileId!] as Record<string, string> || {}),
                                                        [field.key]: text
                                                    }
                                                }));
                                            } else {
                                                // Configuration field
                                                setProfileConfigs(prev => ({
                                                    ...prev,
                                                    [selectedProfileId!]: {
                                                        ...(prev[selectedProfileId!] as Record<string, string> || {}),
                                                        [field.key]: text
                                                    }
                                                }));
                                            }
                                        }}
                                        secureTextEntry={field.isPassword}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        returnKeyType="next"
                                    />
                                </View>
                            ))}
                        </ItemGroup>

                        <View style={{
                            backgroundColor: theme.colors.input.background,
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            marginTop: 16,
                        }}>
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                marginBottom: 4,
                            }}>
                                💡 Tip: Your API keys are only used for this session and are not stored permanently
                            </Text>
                            <Text style={{
                                fontSize: 12,
                                color: theme.colors.textSecondary,
                                marginTop: 4,
                            }}>
                                📝 Note: Leave fields empty to use CLI environment variables if they're already set
                            </Text>
                        </View>
                    </View>
                );

            case 'sessionType':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Choose AI Backend & Session Type</Text>
                        <Text style={styles.stepDescription}>
                            Select your AI provider and how you want to work with your code
                        </Text>

                        <ItemGroup title="AI Backend">
                            {[
                                {
                                    id: 'anthropic',
                                    name: 'Anthropic Claude',
                                    description: 'Advanced reasoning and coding assistant',
                                    icon: 'cube-outline',
                                    agentType: 'claude' as const
                                },
                                {
                                    id: 'openai',
                                    name: 'OpenAI GPT-5',
                                    description: 'Specialized coding assistant',
                                    icon: 'code-outline',
                                    agentType: 'codex' as const
                                },
                                {
                                    id: 'deepseek',
                                    name: 'DeepSeek Reasoner',
                                    description: 'Advanced reasoning model',
                                    icon: 'analytics-outline',
                                    agentType: 'claude' as const
                                },
                                {
                                    id: 'zai',
                                    name: 'Z.ai',
                                    description: 'AI assistant for development',
                                    icon: 'flash-outline',
                                    agentType: 'claude' as const
                                },
                                {
                                    id: 'microsoft',
                                    name: 'Microsoft Azure',
                                    description: 'Enterprise AI services',
                                    icon: 'cloud-outline',
                                    agentType: 'codex' as const
                                },
                            ].map((backend) => (
                                <Item
                                    key={backend.id}
                                    title={backend.name}
                                    subtitle={backend.description}
                                    leftElement={
                                        <Ionicons
                                            name={backend.icon as any}
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    }
                                    rightElement={agentType === backend.agentType ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={20}
                                            color={theme.colors.button.primary.background}
                                        />
                                    ) : null}
                                    onPress={() => setAgentType(backend.agentType)}
                                    showChevron={false}
                                    selected={agentType === backend.agentType}
                                    showDivider={true}
                                />
                            ))}
                        </ItemGroup>

                        <SessionTypeSelector
                            value={sessionType}
                            onChange={setSessionType}
                        />
                    </View>
                );

            case 'agent':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Choose AI Agent</Text>
                        <Text style={styles.stepDescription}>
                            Select which AI assistant you want to use
                        </Text>

                        {selectedProfileId && (
                            <View style={{
                                backgroundColor: theme.colors.input.background,
                                padding: 12,
                                borderRadius: 8,
                                marginBottom: 16,
                                borderWidth: 1,
                                borderColor: theme.colors.divider
                            }}>
                                <Text style={{
                                    fontSize: 14,
                                    color: theme.colors.textSecondary,
                                    marginBottom: 4
                                }}>
                                    Profile: {allProfiles.find(p => p.id === selectedProfileId)?.name || 'Unknown'}
                                </Text>
                                <Text style={{
                                    fontSize: 12,
                                    color: theme.colors.textSecondary
                                }}>
                                    {allProfiles.find(p => p.id === selectedProfileId)?.description}
                                </Text>
                            </View>
                        )}

                        <Pressable
                            style={[
                                styles.agentOption,
                                agentType === 'claude' ? styles.agentOptionSelected : styles.agentOptionUnselected,
                                selectedProfileId && !allProfiles.find(p => p.id === selectedProfileId)?.compatibility.claude && {
                                    opacity: 0.5,
                                    backgroundColor: theme.colors.surface
                                }
                            ]}
                            onPress={() => {
                                if (!selectedProfileId || allProfiles.find(p => p.id === selectedProfileId)?.compatibility.claude) {
                                    setAgentType('claude');
                                }
                            }}
                            disabled={!!(selectedProfileId && !allProfiles.find(p => p.id === selectedProfileId)?.compatibility.claude)}
                        >
                            <View style={styles.agentIcon}>
                                <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}>C</Text>
                            </View>
                            <View style={styles.agentInfo}>
                                <Text style={styles.agentName}>Claude</Text>
                                <Text style={styles.agentDescription}>
                                    Anthropic's AI assistant, great for coding and analysis
                                </Text>
                                {selectedProfileId && !allProfiles.find(p => p.id === selectedProfileId)?.compatibility.claude && (
                                    <Text style={{ fontSize: 12, color: theme.colors.textDestructive, marginTop: 4 }}>
                                        Not compatible with selected profile
                                    </Text>
                                )}
                            </View>
                            {agentType === 'claude' && (
                                <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} />
                            )}
                        </Pressable>

                        <Pressable
                            style={[
                                styles.agentOption,
                                agentType === 'codex' ? styles.agentOptionSelected : styles.agentOptionUnselected,
                                selectedProfileId && !allProfiles.find(p => p.id === selectedProfileId)?.compatibility.codex && {
                                    opacity: 0.5,
                                    backgroundColor: theme.colors.surface
                                }
                            ]}
                            onPress={() => {
                                if (!selectedProfileId || allProfiles.find(p => p.id === selectedProfileId)?.compatibility.codex) {
                                    setAgentType('codex');
                                }
                            }}
                            disabled={!!(selectedProfileId && !allProfiles.find(p => p.id === selectedProfileId)?.compatibility.codex)}
                        >
                            <View style={styles.agentIcon}>
                                <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}>X</Text>
                            </View>
                            <View style={styles.agentInfo}>
                                <Text style={styles.agentName}>Codex</Text>
                                <Text style={styles.agentDescription}>
                                    OpenAI's specialized coding assistant
                                </Text>
                                {selectedProfileId && !allProfiles.find(p => p.id === selectedProfileId)?.compatibility.codex && (
                                    <Text style={{ fontSize: 12, color: theme.colors.textDestructive, marginTop: 4 }}>
                                        Not compatible with selected profile
                                    </Text>
                                )}
                            </View>
                            {agentType === 'codex' && (
                                <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} />
                            )}
                        </Pressable>
                    </View>
                );

            case 'options':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Agent Options</Text>
                        <Text style={styles.stepDescription}>
                            Configure how the AI agent should behave
                        </Text>

                        {selectedProfileId && (
                            <View style={{
                                backgroundColor: theme.colors.input.background,
                                padding: 12,
                                borderRadius: 8,
                                marginBottom: 16,
                                borderWidth: 1,
                                borderColor: theme.colors.divider
                            }}>
                                <Text style={{
                                    fontSize: 14,
                                    color: theme.colors.textSecondary,
                                    marginBottom: 4
                                }}>
                                    Using profile: {allProfiles.find(p => p.id === selectedProfileId)?.name || 'Unknown'}
                                </Text>
                                <Text style={{
                                    fontSize: 12,
                                    color: theme.colors.textSecondary
                                }}>
                                    Environment variables will be applied automatically
                                </Text>
                            </View>
                        )}
                        <ItemGroup title="Permission Mode">
                            {([
                                { value: 'default', label: 'Default', description: 'Ask for permissions', icon: 'shield-outline' },
                                { value: 'acceptEdits', label: 'Accept Edits', description: 'Auto-approve edits', icon: 'checkmark-outline' },
                                { value: 'plan', label: 'Plan', description: 'Plan before executing', icon: 'list-outline' },
                                { value: 'bypassPermissions', label: 'Bypass Permissions', description: 'Skip all permissions', icon: 'flash-outline' },
                            ] as const).map((option, index, array) => (
                                <Item
                                    key={option.value}
                                    title={option.label}
                                    subtitle={option.description}
                                    leftElement={
                                        <Ionicons
                                            name={option.icon}
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    }
                                    rightElement={permissionMode === option.value ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={20}
                                            color={theme.colors.button.primary.background}
                                        />
                                    ) : null}
                                    onPress={() => setPermissionMode(option.value as PermissionMode)}
                                    showChevron={false}
                                    selected={permissionMode === option.value}
                                    showDivider={index < array.length - 1}
                                />
                            ))}
                        </ItemGroup>

                        <ItemGroup title="Model Mode">
                            {(agentType === 'claude' ? [
                                { value: 'default', label: 'Default', description: 'Balanced performance', icon: 'cube-outline' },
                                { value: 'adaptiveUsage', label: 'Adaptive Usage', description: 'Automatically choose model', icon: 'analytics-outline' },
                                { value: 'sonnet', label: 'Sonnet', description: 'Fast and efficient', icon: 'speedometer-outline' },
                                { value: 'opus', label: 'Opus', description: 'Most capable model', icon: 'diamond-outline' },
                            ] as const : [
                                { value: 'gpt-5-codex-high', label: 'GPT-5 Codex High', description: 'Best for complex coding', icon: 'diamond-outline' },
                                { value: 'gpt-5-codex-medium', label: 'GPT-5 Codex Medium', description: 'Balanced coding assistance', icon: 'cube-outline' },
                                { value: 'gpt-5-codex-low', label: 'GPT-5 Codex Low', description: 'Fast coding help', icon: 'speedometer-outline' },
                            ] as const).map((option, index, array) => (
                                <Item
                                    key={option.value}
                                    title={option.label}
                                    subtitle={option.description}
                                    leftElement={
                                        <Ionicons
                                            name={option.icon}
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    }
                                    rightElement={modelMode === option.value ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={20}
                                            color={theme.colors.button.primary.background}
                                        />
                                    ) : null}
                                    onPress={() => setModelMode(option.value as ModelMode)}
                                    showChevron={false}
                                    selected={modelMode === option.value}
                                    showDivider={index < array.length - 1}
                                />
                            ))}
                        </ItemGroup>
                    </View>
                );

            case 'machine':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Select Machine</Text>
                        <Text style={styles.stepDescription}>
                            Choose which machine to run your session on
                        </Text>

                        <ItemGroup title="Available Machines">
                            {machines.map((machine, index) => (
                                <Item
                                    key={machine.id}
                                    title={machine.metadata?.displayName || machine.metadata?.host || machine.id}
                                    subtitle={machine.metadata?.host || ''}
                                    leftElement={
                                        <Ionicons
                                            name="laptop-outline"
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    }
                                    rightElement={selectedMachineId === machine.id ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={20}
                                            color={theme.colors.button.primary.background}
                                        />
                                    ) : null}
                                    onPress={() => {
                                        setSelectedMachineId(machine.id);
                                        // Update path when machine changes
                                        const homeDir = machine.metadata?.homeDir || '/home';
                                        setSelectedPath(homeDir);
                                    }}
                                    showChevron={false}
                                    selected={selectedMachineId === machine.id}
                                    showDivider={index < machines.length - 1}
                                />
                            ))}
                        </ItemGroup>
                    </View>
                );

            case 'path':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Working Directory</Text>
                        <Text style={styles.stepDescription}>
                            Choose the directory to work in
                        </Text>

                        {/* Recent Paths */}
                        {recentPaths.length > 0 && (
                            <ItemGroup title="Recent Paths">
                                {recentPaths.map((path, index) => (
                                    <Item
                                        key={path}
                                        title={path}
                                        subtitle="Recently used"
                                        leftElement={
                                            <Ionicons
                                                name="time-outline"
                                                size={24}
                                                color={theme.colors.textSecondary}
                                            />
                                        }
                                        rightElement={selectedPath === path && !showCustomPathInput ? (
                                            <Ionicons
                                                name="checkmark-circle"
                                                size={20}
                                                color={theme.colors.button.primary.background}
                                            />
                                        ) : null}
                                        onPress={() => {
                                            setSelectedPath(path);
                                            setShowCustomPathInput(false);
                                        }}
                                        showChevron={false}
                                        selected={selectedPath === path && !showCustomPathInput}
                                        showDivider={index < recentPaths.length - 1}
                                    />
                                ))}
                            </ItemGroup>
                        )}

                        {/* Common Directories */}
                        <ItemGroup title="Common Directories">
                            {(() => {
                                const machine = machines.find(m => m.id === selectedMachineId);
                                const homeDir = machine?.metadata?.homeDir || '/home';
                                const pathOptions = [
                                    { value: homeDir, label: homeDir, description: 'Home directory' },
                                    { value: `${homeDir}/projects`, label: `${homeDir}/projects`, description: 'Projects folder' },
                                    { value: `${homeDir}/Documents`, label: `${homeDir}/Documents`, description: 'Documents folder' },
                                    { value: `${homeDir}/Desktop`, label: `${homeDir}/Desktop`, description: 'Desktop folder' },
                                ];
                                return pathOptions.map((option, index) => (
                                    <Item
                                        key={option.value}
                                        title={option.label}
                                        subtitle={option.description}
                                        leftElement={
                                            <Ionicons
                                                name="folder-outline"
                                                size={24}
                                                color={theme.colors.textSecondary}
                                            />
                                        }
                                        rightElement={selectedPath === option.value && !showCustomPathInput ? (
                                            <Ionicons
                                                name="checkmark-circle"
                                                size={20}
                                                color={theme.colors.button.primary.background}
                                            />
                                        ) : null}
                                        onPress={() => {
                                            setSelectedPath(option.value);
                                            setShowCustomPathInput(false);
                                        }}
                                        showChevron={false}
                                        selected={selectedPath === option.value && !showCustomPathInput}
                                        showDivider={index < pathOptions.length - 1}
                                    />
                                ));
                            })()}
                        </ItemGroup>

                        {/* Custom Path Option */}
                        <ItemGroup title="Custom Directory">
                            <Item
                                title="Enter custom path"
                                subtitle={showCustomPathInput && customPath ? customPath : "Specify a custom directory path"}
                                leftElement={
                                    <Ionicons
                                        name="create-outline"
                                        size={24}
                                        color={theme.colors.textSecondary}
                                    />
                                }
                                rightElement={showCustomPathInput ? (
                                    <Ionicons
                                        name="checkmark-circle"
                                        size={20}
                                        color={theme.colors.button.primary.background}
                                    />
                                ) : null}
                                onPress={() => setShowCustomPathInput(true)}
                                showChevron={false}
                                selected={showCustomPathInput}
                                showDivider={false}
                            />
                            {showCustomPathInput && (
                                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                                    <TextInput
                                        style={styles.textInput}
                                        placeholder="Enter directory path (e.g. /home/user/my-project)"
                                        placeholderTextColor={theme.colors.textSecondary}
                                        value={customPath}
                                        onChangeText={setCustomPath}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        returnKeyType="done"
                                    />
                                </View>
                            )}
                        </ItemGroup>
                    </View>
                );

            case 'prompt':
                return (
                    <View>
                        <Text style={styles.stepTitle}>Initial Message</Text>
                        <Text style={styles.stepDescription}>
                            Write your first message to the AI agent
                        </Text>

                        <TextInput
                            style={[styles.textInput, { height: 120, textAlignVertical: 'top' }]}
                            placeholder={t('session.inputPlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={prompt}
                            onChangeText={setPrompt}
                            multiline={true}
                            autoCapitalize="sentences"
                            autoCorrect={true}
                            returnKeyType="default"
                        />
                    </View>
                );

            default:
                return null;
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>New Session</Text>
                <Pressable onPress={onCancel}>
                    <Ionicons name="close" size={24} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={styles.stepIndicator}>
                {steps.map((step, index) => (
                    <View
                        key={step}
                        style={[
                            styles.stepDot,
                            index <= currentStepIndex ? styles.stepDotActive : styles.stepDotInactive
                        ]}
                    />
                ))}
            </View>

            <ScrollView
                style={styles.stepContent}
                contentContainerStyle={{ paddingBottom: 24 }}
                showsVerticalScrollIndicator={true}
            >
                {renderStepContent()}
            </ScrollView>

            <View style={styles.footer}>
                <Pressable
                    style={[styles.button, styles.buttonSecondary]}
                    onPress={handleBack}
                >
                    <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                        {isFirstStep ? 'Cancel' : 'Back'}
                    </Text>
                </Pressable>

                <Pressable
                    style={[
                        styles.button,
                        styles.buttonPrimary,
                        !canProceed && { opacity: 0.5 }
                    ]}
                    onPress={handleNext}
                    disabled={!canProceed}
                >
                    <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
                        {isLastStep ? 'Create Session' : 'Next'}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}