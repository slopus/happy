import React from 'react';
import { View, Text, Platform, Pressable, useWindowDimensions, ScrollView, TextInput } from 'react-native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, storage, useSetting } from '@/sync/storage';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { machineSpawnNewSession } from '@/sync/ops';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { createWorktree } from '@/utils/createWorktree';
import { getTempData, type NewSessionData } from '@/utils/tempDataStore';
import { linkTaskToSession } from '@/-zen/model/taskSessionLink';
import { PermissionMode, ModelMode } from '@/components/PermissionModeSelector';
import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';
import { StyleSheet } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';

// Wizard steps
type WizardStep = 'welcome' | 'ai-backend' | 'session-details' | 'creating';

// Simple temporary state for passing selections back from picker screens
let onMachineSelected: (machineId: string) => void = () => { };
let onPathSelected: (path: string) => void = () => { };

export const callbacks = {
    onMachineSelected: (machineId: string) => {
        onMachineSelected(machineId);
    },
    onPathSelected: (path: string) => {
        onPathSelected(path);
    }
}

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
        case 'openai':
            return {
                id: 'openai',
                name: 'OpenAI (GPT-5)',
                openaiConfig: {
                    baseUrl: 'https://api.openai.com/v1',
                    model: 'gpt-5-codex-high',
                },
                environmentVariables: [
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'OPENAI_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                    { name: 'CODEX_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
                ],
                compatibility: { claude: false, codex: true },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'azure-openai':
            return {
                id: 'azure-openai',
                name: 'Azure OpenAI',
                azureOpenAIConfig: {
                    apiVersion: '2024-02-15-preview',
                    deploymentName: 'gpt-5-codex',
                },
                environmentVariables: [
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                ],
                compatibility: { claude: false, codex: true },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'together':
            return {
                id: 'together',
                name: 'Together AI',
                openaiConfig: {
                    baseUrl: 'https://api.together.xyz/v1',
                    model: 'meta-llama/Llama-3.1-405B-Instruct-Turbo',
                },
                environmentVariables: [
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                ],
                compatibility: { claude: false, codex: true },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        default:
            return null;
    }
};

// Default built-in profiles
const DEFAULT_PROFILES = [
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
    },
    {
        id: 'openai',
        name: 'OpenAI (GPT-5)',
        isBuiltIn: true,
    },
    {
        id: 'azure-openai',
        name: 'Azure OpenAI',
        isBuiltIn: true,
    },
    {
        id: 'together',
        name: 'Together AI',
        isBuiltIn: true,
    }
];

// Optimized profile lookup utility
const useProfileMap = (profiles: AIBackendProfile[]) => {
    return React.useMemo(() =>
        new Map(profiles.map(p => [p.id, p])),
        [profiles]
    );
};

// Environment variable transformation helper
const transformProfileToEnvironmentVars = (profile: AIBackendProfile, agentType: 'claude' | 'codex' = 'claude') => {
    const envVars = getProfileEnvironmentVariables(profile);

    // Filter environment variables based on agent type
    const filtered: Record<string, string | undefined> = {};

    // Universal variables
    const universalVars = [
        'TMUX_SESSION_NAME', 'TMUX_TMPDIR', 'TMUX_UPDATE_ENVIRONMENT',
        'API_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
    ];

    // Agent-specific variables
    const claudeVars = [
        'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'
    ];

    const codexVars = [
        'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_TIMEOUT_MS',
        'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_VERSION',
        'AZURE_OPENAI_DEPLOYMENT_NAME', 'TOGETHER_API_KEY', 'CODEX_SMALL_FAST_MODEL'
    ];

    // Copy universal variables
    Object.entries(envVars).forEach(([key, value]) => {
        if (universalVars.includes(key)) {
            filtered[key] = value;
        }
    });

    // Copy agent-specific variables
    const agentVars = agentType === 'claude' ? claudeVars : codexVars;
    Object.entries(envVars).forEach(([key, value]) => {
        if (agentVars.includes(key)) {
            filtered[key] = value;
        }
    });

    return filtered;
};

// Helper function to get the most recent path for a machine
const getRecentPathForMachine = (machineId: string | null, recentPaths: Array<{ machineId: string; path: string }>): string => {
    if (!machineId) return '/home/';

    const recentPath = recentPaths.find(rp => rp.machineId === machineId);
    if (recentPath) {
        return recentPath.path;
    }

    const machine = storage.getState().machines[machineId];
    const defaultPath = machine?.metadata?.homeDir || '/home/';

    const sessions = Object.values(storage.getState().sessions);
    const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];
    const pathSet = new Set<string>();

    sessions.forEach(session => {
        if (session.metadata?.machineId === machineId && session.metadata?.path) {
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

    pathsWithTimestamps.sort((a, b) => b.timestamp - a.timestamp);
    return pathsWithTimestamps[0]?.path || defaultPath;
};

const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
        paddingTop: Platform.OS === 'web' ? 0 : 40,
    },
    scrollContainer: {
        flexGrow: 1,
        justifyContent: 'flex-end',
    },
    contentContainer: {
        width: '100%',
        alignSelf: 'center',
        paddingTop: rt.insets.top,
        paddingBottom: rt.insets.bottom,
    },
    wizardCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        marginHorizontal: 16,
        padding: 20,
        marginBottom: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 4,
    },
    stepHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
    },
    stepNumber: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: theme.colors.button.primary.background,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 12,
    },
    stepNumberText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 16,
    },
    stepTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: theme.colors.text,
        flex: 1,
    },
    stepDescription: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 20,
        lineHeight: 20,
    },
    profileGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        marginBottom: 20,
    },
    profileCard: {
        width: '48%',
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        borderWidth: 2,
        borderColor: 'transparent',
    },
    profileCardSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.button.primary.background + '10',
    },
    profileCardIncompatible: {
        opacity: 0.5,
        backgroundColor: theme.colors.input.background + '50',
    },
    profileName: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 4,
    },
    profileDescription: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 8,
    },
    profileBadges: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    profileBadge: {
        backgroundColor: theme.colors.button.primary.background + '20',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        marginRight: 4,
        marginBottom: 4,
    },
    profileBadgeText: {
        fontSize: 10,
        color: theme.colors.button.primary.background,
        fontWeight: '500',
    },
    buttonContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 20,
    },
    button: {
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        minWidth: 100,
        alignItems: 'center',
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    buttonText: {
        color: 'white',
        fontWeight: '600',
        fontSize: 16,
    },
    buttonTextSecondary: {
        color: theme.colors.text,
    },
    inputContainer: {
        marginBottom: 16,
    },
    inputLabel: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    creatingContainer: {
        alignItems: 'center',
        paddingVertical: 40,
    },
    creatingTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginTop: 16,
        marginBottom: 8,
    },
    creatingDescription: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

function NewSessionWizard() {
    const { theme, rt } = useUnistyles();
    const router = useRouter();
    const { prompt, dataId } = useLocalSearchParams<{ prompt?: string; dataId?: string }>();

    // Try to get data from temporary store first
    const tempSessionData = React.useMemo(() => {
        if (dataId) {
            return getTempData<NewSessionData>(dataId);
        }
        return null;
    }, [dataId]);

    // Settings and state
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');
    const lastUsedModelMode = useSetting('lastUsedModelMode');
    const experimentsEnabled = useSetting('experiments');
    const profiles = useSetting('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');

    // Combined profiles (built-in + custom)
    const allProfiles = React.useMemo(() => {
        const builtInProfiles = DEFAULT_PROFILES.map(bp => getBuiltInProfile(bp.id)!);
        return [...builtInProfiles, ...profiles];
    }, [profiles]);

    const profileMap = useProfileMap(allProfiles);
    const machines = useAllMachines();

    // Wizard state
    const [currentStep, setCurrentStep] = React.useState<WizardStep>('welcome');
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(() => {
        if (lastUsedProfile && profileMap.has(lastUsedProfile)) {
            return lastUsedProfile;
        }
        return null;
    });
    const [agentType, setAgentType] = React.useState<'claude' | 'codex'>(() => {
        if (tempSessionData?.agentType) {
            return tempSessionData.agentType;
        }
        if (lastUsedAgent === 'claude' || lastUsedAgent === 'codex') {
            return lastUsedAgent;
        }
        return 'claude';
    });
    const [sessionType, setSessionType] = React.useState<'simple' | 'worktree'>('simple');
    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(() => {
        const validClaudeModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        const validCodexModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

        if (lastUsedPermissionMode) {
            if (agentType === 'codex' && validCodexModes.includes(lastUsedPermissionMode as PermissionMode)) {
                return lastUsedPermissionMode as PermissionMode;
            } else if (agentType === 'claude' && validClaudeModes.includes(lastUsedPermissionMode as PermissionMode)) {
                return lastUsedPermissionMode as PermissionMode;
            }
        }
        return 'default';
    });
    const [modelMode, setModelMode] = React.useState<ModelMode>(() => {
        const validClaudeModes: ModelMode[] = ['default', 'adaptiveUsage', 'sonnet', 'opus'];
        const validCodexModes: ModelMode[] = ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'default', 'gpt-5-minimal', 'gpt-5-low', 'gpt-5-medium', 'gpt-5-high'];

        if (lastUsedModelMode) {
            if (agentType === 'codex' && validCodexModes.includes(lastUsedModelMode as ModelMode)) {
                return lastUsedModelMode as ModelMode;
            } else if (agentType === 'claude' && validClaudeModes.includes(lastUsedModelMode as ModelMode)) {
                return lastUsedModelMode as ModelMode;
            }
        }
        return agentType === 'codex' ? 'gpt-5-codex-high' : 'default';
    });

    // Session details state
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => {
        if (machines.length > 0) {
            if (recentMachinePaths.length > 0) {
                for (const recent of recentMachinePaths) {
                    if (machines.find(m => m.id === recent.machineId)) {
                        return recent.machineId;
                    }
                }
            }
            return machines[0].id;
        }
        return null;
    });
    const [selectedPath, setSelectedPath] = React.useState<string>(() => {
        return getRecentPathForMachine(selectedMachineId, recentMachinePaths);
    });
    const [sessionPrompt, setSessionPrompt] = React.useState(() => {
        return tempSessionData?.prompt || prompt || '';
    });
    const [isCreating, setIsCreating] = React.useState(false);

    // New profile creation state
    const [newProfileName, setNewProfileName] = React.useState('');
    const [newProfileDescription, setNewProfileDescription] = React.useState('');

    // Computed values
    const compatibleProfiles = React.useMemo(() => {
        return allProfiles.filter(profile => validateProfileForAgent(profile, agentType));
    }, [allProfiles, agentType]);

    const selectedProfile = React.useMemo(() => {
        if (!selectedProfileId || !profileMap.has(selectedProfileId)) {
            return null;
        }
        return profileMap.get(selectedProfileId)!;
    }, [selectedProfileId, profileMap]);

    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId);
    }, [selectedMachineId, machines]);

    // Navigation functions
    const goToNextStep = React.useCallback(() => {
        switch (currentStep) {
            case 'welcome':
                if (selectedProfileId) {
                    setCurrentStep('session-details');
                } else {
                    setCurrentStep('ai-backend');
                }
                break;
            case 'ai-backend':
                // Skip tmux-config step - configure tmux in profile settings instead
                setCurrentStep('session-details');
                break;
            case 'session-details':
                handleCreateSession();
                break;
        }
    }, [currentStep, selectedProfileId]);

    const goToPreviousStep = React.useCallback(() => {
        switch (currentStep) {
            case 'ai-backend':
                setCurrentStep('welcome');
                break;
            case 'session-details':
                if (selectedProfileId) {
                    setCurrentStep('welcome');
                } else {
                    setCurrentStep('ai-backend');
                }
                break;
        }
    }, [currentStep, selectedProfileId]);

    const selectProfile = React.useCallback((profileId: string) => {
        setSelectedProfileId(profileId);
        const profile = profileMap.get(profileId);
        if (profile) {
            // Auto-select agent based on profile compatibility
            if (profile.compatibility.claude && !profile.compatibility.codex) {
                setAgentType('claude');
            } else if (profile.compatibility.codex && !profile.compatibility.claude) {
                setAgentType('codex');
            }
        }
    }, [profileMap]);

    const createNewProfile = React.useCallback(() => {
        if (!newProfileName.trim()) {
            Modal.alert('Error', 'Please enter a profile name');
            return;
        }

        const newProfile: AIBackendProfile = {
            id: randomUUID(),
            name: newProfileName.trim(),
            description: newProfileDescription.trim() || undefined,
            compatibility: {
                claude: agentType === 'claude',
                codex: agentType === 'codex',
            },
            environmentVariables: [],
            isBuiltIn: false,
            version: '1.0.0',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        // Add the new profile to settings
        const updatedProfiles = [...profiles, newProfile];
        sync.applySettings({ profiles: updatedProfiles });

        setSelectedProfileId(newProfile.id);
        setNewProfileName('');
        setNewProfileDescription('');
        setCurrentStep('session-details');
    }, [newProfileName, newProfileDescription, agentType, profiles]);

    // Handle machine and path selection callbacks
    React.useEffect(() => {
        let handler = (machineId: string) => {
            let machine = storage.getState().machines[machineId];
            if (machine) {
                setSelectedMachineId(machineId);
                const bestPath = getRecentPathForMachine(machineId, recentMachinePaths);
                setSelectedPath(bestPath);
            }
        };
        onMachineSelected = handler;
        return () => {
            onMachineSelected = () => { };
        };
    }, [recentMachinePaths]);

    React.useEffect(() => {
        let handler = (path: string) => {
            setSelectedPath(path);
        };
        onPathSelected = handler;
        return () => {
            onPathSelected = () => { };
        };
    }, []);

    const handleMachineClick = React.useCallback(() => {
        router.push('/new/pick/machine');
    }, []);

    const handlePathClick = React.useCallback(() => {
        if (selectedMachineId) {
            router.push(`/new/pick/path?machineId=${selectedMachineId}`);
        }
    }, [selectedMachineId, router]);

    // Session creation
    const handleCreateSession = React.useCallback(async () => {
        if (!selectedMachineId) {
            Modal.alert(t('common.error'), t('newSession.noMachineSelected'));
            return;
        }
        if (!selectedPath) {
            Modal.alert(t('common.error'), t('newSession.noPathSelected'));
            return;
        }
        if (!sessionPrompt.trim()) {
            Modal.alert('Error', 'Please enter a prompt for the session');
            return;
        }

        setIsCreating(true);
        setCurrentStep('creating');

        try {
            let actualPath = selectedPath;

            // Handle worktree creation
            if (sessionType === 'worktree' && experimentsEnabled) {
                const worktreeResult = await createWorktree(selectedMachineId, selectedPath);

                if (!worktreeResult.success) {
                    if (worktreeResult.error === 'Not a Git repository') {
                        Modal.alert(t('common.error'), t('newSession.worktree.notGitRepo'));
                    } else {
                        Modal.alert(t('common.error'), t('newSession.worktree.failed', { error: worktreeResult.error || 'Unknown error' }));
                    }
                    setIsCreating(false);
                    setCurrentStep('session-details');
                    return;
                }

                actualPath = worktreeResult.worktreePath;
            }

            // Save settings
            const updatedPaths = [{ machineId: selectedMachineId, path: selectedPath }, ...recentMachinePaths.filter(rp => rp.machineId !== selectedMachineId)].slice(0, 10);
            sync.applySettings({
                recentMachinePaths: updatedPaths,
                lastUsedAgent: agentType,
                lastUsedProfile: selectedProfileId,
                lastUsedPermissionMode: permissionMode,
                lastUsedModelMode: modelMode,
            });

            // Get environment variables from selected profile
            let environmentVariables = undefined;
            if (selectedProfileId) {
                const selectedProfile = profileMap.get(selectedProfileId);
                if (selectedProfile) {
                    environmentVariables = transformProfileToEnvironmentVars(selectedProfile, agentType);
                }
            }

            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: actualPath,
                approvedNewDirectoryCreation: true,
                agent: agentType,
                environmentVariables
            });

            if ('sessionId' in result && result.sessionId) {
                await sync.refreshSessions();

                storage.getState().updateSessionPermissionMode(result.sessionId, permissionMode);
                storage.getState().updateSessionModelMode(result.sessionId, modelMode);

                await sync.sendMessage(result.sessionId, sessionPrompt);

                router.replace(`/session/${result.sessionId}`, {
                    dangerouslySingular() {
                        return 'session'
                    },
                });
            } else {
                throw new Error('Session spawning failed - no session ID returned.');
            }
        } catch (error) {
            console.error('Failed to start session', error);
            let errorMessage = 'Failed to start session. Make sure the daemon is running on the target machine.';
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = 'Session startup timed out. The machine may be slow or the daemon may not be responding.';
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = 'Not connected to server. Check your internet connection.';
                }
            }
            Modal.alert(t('common.error'), errorMessage);
            setIsCreating(false);
            setCurrentStep('session-details');
        }
    }, [selectedMachineId, selectedPath, sessionPrompt, sessionType, experimentsEnabled, agentType, selectedProfileId, permissionMode, modelMode, recentMachinePaths, router]);

    const screenWidth = useWindowDimensions().width;

    // Render wizard step content
    const renderStepContent = () => {
        switch (currentStep) {
            case 'welcome':
                return (
                    <View style={styles.wizardCard}>
                        <View style={styles.stepHeader}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>1</Text>
                            </View>
                            <Text style={styles.stepTitle}>Choose Profile</Text>
                        </View>
                        <Text style={styles.stepDescription}>
                            Select an existing AI profile to quickly get started with pre-configured settings, or create a new custom profile.
                        </Text>

                        <ScrollView style={{ maxHeight: 300 }}>
                            <View style={styles.profileGrid}>
                                {compatibleProfiles.map((profile) => (
                                    <Pressable
                                        key={profile.id}
                                        style={[
                                            styles.profileCard,
                                            selectedProfileId === profile.id && styles.profileCardSelected,
                                        ]}
                                        onPress={() => selectProfile(profile.id)}
                                    >
                                        <Text style={styles.profileName}>{profile.name}</Text>
                                        {profile.description && (
                                            <Text style={styles.profileDescription} numberOfLines={2}>
                                                {profile.description}
                                            </Text>
                                        )}
                                        <View style={styles.profileBadges}>
                                            {profile.compatibility.claude && (
                                                <View style={styles.profileBadge}>
                                                    <Text style={styles.profileBadgeText}>Claude</Text>
                                                </View>
                                            )}
                                            {profile.compatibility.codex && (
                                                <View style={styles.profileBadge}>
                                                    <Text style={styles.profileBadgeText}>Codex</Text>
                                                </View>
                                            )}
                                            {profile.isBuiltIn && (
                                                <View style={styles.profileBadge}>
                                                    <Text style={styles.profileBadgeText}>Built-in</Text>
                                                </View>
                                            )}
                                        </View>
                                    </Pressable>
                                ))}
                            </View>
                        </ScrollView>

                        <View style={styles.buttonContainer}>
                            <Pressable
                                style={[styles.button, styles.buttonSecondary]}
                                onPress={() => setCurrentStep('ai-backend')}
                            >
                                <Text style={styles.buttonTextSecondary}>Create New</Text>
                            </Pressable>
                            <Pressable
                                style={[
                                    styles.button,
                                    styles.buttonPrimary,
                                    !selectedProfileId && styles.buttonDisabled
                                ]}
                                onPress={goToNextStep}
                                disabled={!selectedProfileId}
                            >
                                <Text style={styles.buttonText}>Next</Text>
                            </Pressable>
                        </View>
                    </View>
                );

            case 'ai-backend':
                return (
                    <View style={styles.wizardCard}>
                        <View style={styles.stepHeader}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>2</Text>
                            </View>
                            <Text style={styles.stepTitle}>AI Backend</Text>
                        </View>
                        <Text style={styles.stepDescription}>
                            Choose the AI backend and configure its settings for your new profile.
                        </Text>

                        <View style={styles.inputContainer}>
                            <Text style={styles.inputLabel}>Profile Name</Text>
                            <TextInput
                                style={styles.textInput}
                                value={newProfileName}
                                onChangeText={setNewProfileName}
                                placeholder="Enter a name for this profile"
                                placeholderTextColor={theme.colors.textSecondary}
                            />
                        </View>

                        <View style={styles.inputContainer}>
                            <Text style={styles.inputLabel}>Description (Optional)</Text>
                            <TextInput
                                style={[styles.textInput, { height: 80 }]}
                                value={newProfileDescription}
                                onChangeText={setNewProfileDescription}
                                placeholder="Describe what this profile is for"
                                placeholderTextColor={theme.colors.textSecondary}
                                multiline
                                numberOfLines={3}
                                textAlignVertical="top"
                            />
                        </View>

                        <View style={styles.buttonContainer}>
                            <Pressable
                                style={[styles.button, styles.buttonSecondary]}
                                onPress={goToPreviousStep}
                            >
                                <Text style={styles.buttonTextSecondary}>Back</Text>
                            </Pressable>
                            <Pressable
                                style={[
                                    styles.button,
                                    styles.buttonPrimary,
                                    !newProfileName.trim() && styles.buttonDisabled
                                ]}
                                onPress={goToNextStep}
                                disabled={!newProfileName.trim()}
                            >
                                <Text style={styles.buttonText}>Next</Text>
                            </Pressable>
                        </View>
                    </View>
                );

            case 'session-details':
                return (
                    <View style={styles.wizardCard}>
                        <View style={styles.stepHeader}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>{selectedProfileId ? '2' : '3'}</Text>
                            </View>
                            <Text style={styles.stepTitle}>Session Details</Text>
                        </View>
                        <Text style={styles.stepDescription}>
                            Set up the final details for your AI session.
                        </Text>

                        <View style={styles.inputContainer}>
                            <Text style={styles.inputLabel}>What would you like to work on?</Text>
                            <TextInput
                                style={[styles.textInput, { height: 100 }]}
                                value={sessionPrompt}
                                onChangeText={setSessionPrompt}
                                placeholder="Describe your task or question..."
                                placeholderTextColor={theme.colors.textSecondary}
                                multiline
                                numberOfLines={4}
                                textAlignVertical="top"
                            />
                        </View>

                        <Pressable
                            style={[styles.button, styles.buttonSecondary, { marginBottom: 12 }]}
                            onPress={handleMachineClick}
                        >
                            <Text style={styles.buttonTextSecondary}>
                                Machine: {selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host || 'None selected'}
                            </Text>
                        </Pressable>

                        <Pressable
                            style={[styles.button, styles.buttonSecondary, { marginBottom: 12 }]}
                            onPress={handlePathClick}
                        >
                            <Text style={styles.buttonTextSecondary}>
                                Path: {selectedPath}
                            </Text>
                        </Pressable>

                        {experimentsEnabled && (
                            <View style={{ marginBottom: 12 }}>
                                <SessionTypeSelector
                                    value={sessionType}
                                    onChange={setSessionType}
                                />
                            </View>
                        )}

                        <View style={styles.buttonContainer}>
                            <Pressable
                                style={[styles.button, styles.buttonSecondary]}
                                onPress={goToPreviousStep}
                            >
                                <Text style={styles.buttonTextSecondary}>Back</Text>
                            </Pressable>
                            <Pressable
                                style={[
                                    styles.button,
                                    styles.buttonPrimary,
                                    (!sessionPrompt.trim() || !selectedMachineId || !selectedPath) && styles.buttonDisabled
                                ]}
                                onPress={goToNextStep}
                                disabled={!sessionPrompt.trim() || !selectedMachineId || !selectedPath}
                            >
                                <Text style={styles.buttonText}>Create Session</Text>
                            </Pressable>
                        </View>
                    </View>
                );

            case 'creating':
                return (
                    <View style={styles.wizardCard}>
                        <View style={styles.creatingContainer}>
                            <View style={{
                                width: 48,
                                height: 48,
                                borderRadius: 24,
                                backgroundColor: theme.colors.button.primary.background + '20',
                                justifyContent: 'center',
                                alignItems: 'center',
                                marginBottom: 16,
                            }}>
                                <Ionicons name="flash" size={24} color={theme.colors.button.primary.background} />
                            </View>
                            <Text style={styles.creatingTitle}>Creating Session</Text>
                            <Text style={styles.creatingDescription}>
                                Setting up your AI session with the selected configuration...
                            </Text>
                        </View>
                    </View>
                );

            default:
                return null;
        }
    };

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + useHeaderHeight() : 0}
            style={styles.container}
        >
            <ScrollView
                style={styles.scrollContainer}
                contentContainerStyle={styles.contentContainer}
                keyboardShouldPersistTaps="handled"
            >
                <View style={[
                    { paddingHorizontal: screenWidth > 700 ? 16 : 8 }
                ]}>
                    <View style={[
                        { maxWidth: layout.maxWidth, flex: 1, width: '100%', alignSelf: 'center' }
                    ]}>
                        {renderStepContent()}
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

export default React.memo(NewSessionWizard);