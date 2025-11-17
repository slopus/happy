import React from 'react';
import { View, Text, Platform, Pressable, useWindowDimensions, ScrollView, TextInput } from 'react-native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, storage, useSetting, useSettingMutable } from '@/sync/storage';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
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
import { PermissionMode, ModelMode, PermissionModeSelector } from '@/components/PermissionModeSelector';
import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES } from '@/sync/profileUtils';
import { AgentInput } from '@/components/AgentInput';
import { StyleSheet } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';

// Simple temporary state for passing selections back from picker screens
let onMachineSelected: (machineId: string) => void = () => { };
let onPathSelected: (path: string) => void = () => { };
let onProfileSaved: (profile: AIBackendProfile) => void = () => { };

export const callbacks = {
    onMachineSelected: (machineId: string) => {
        onMachineSelected(machineId);
    },
    onPathSelected: (path: string) => {
        onPathSelected(path);
    },
    onProfileSaved: (profile: AIBackendProfile) => {
        onProfileSaved(profile);
    }
}

// Optimized profile lookup utility
const useProfileMap = (profiles: AIBackendProfile[]) => {
    return React.useMemo(() =>
        new Map(profiles.map(p => [p.id, p])),
        [profiles]
    );
};

// Environment variable transformation helper
// Returns ALL profile environment variables - daemon will use them as-is
const transformProfileToEnvironmentVars = (profile: AIBackendProfile, agentType: 'claude' | 'codex' = 'claude') => {
    // getProfileEnvironmentVariables already returns ALL env vars from profile
    // including custom environmentVariables array and provider-specific configs
    return getProfileEnvironmentVariables(profile);
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
    },
    contentContainer: {
        width: '100%',
        alignSelf: 'center',
        paddingTop: rt.insets.top,
        paddingBottom: rt.insets.bottom,
    },
    wizardContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        marginHorizontal: 16,
        padding: 20,
        marginBottom: 16,
    },
    sectionHeader: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 12,
        marginTop: 16,
    },
    sectionDescription: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 16,
        lineHeight: 20,
    },
    profileListItem: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    profileListItemSelected: {
        borderWidth: 2,
        borderColor: theme.colors.text,
    },
    profileIcon: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: theme.colors.button.primary.background,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 12,
    },
    profileListName: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold')
    },
    profileListDetails: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default()
    },
    addProfileButton: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    addProfileButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.button.secondary.tint,
        marginLeft: 8,
        ...Typography.default('semiBold')
    },
    selectorButton: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    selectorButtonText: {
        color: theme.colors.text,
        fontSize: 14,
        flex: 1,
    },
    advancedHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
    },
    advancedHeaderText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
    },
    permissionGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        marginBottom: 16,
    },
    permissionButton: {
        width: '48%',
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        alignItems: 'center',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    permissionButtonSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.button.primary.background + '10',
    },
    permissionButtonText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
        marginTop: 8,
        textAlign: 'center',
        ...Typography.default('semiBold')
    },
    permissionButtonTextSelected: {
        color: theme.colors.button.primary.background,
    },
    permissionButtonDesc: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 4,
        textAlign: 'center',
        ...Typography.default()
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
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');

    // Combined profiles (built-in + custom)
    const allProfiles = React.useMemo(() => {
        const builtInProfiles = DEFAULT_PROFILES.map(bp => getBuiltInProfile(bp.id)!);
        return [...builtInProfiles, ...profiles];
    }, [profiles]);

    const profileMap = useProfileMap(allProfiles);
    const machines = useAllMachines();

    // Wizard state
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(() => {
        if (lastUsedProfile && profileMap.has(lastUsedProfile)) {
            return lastUsedProfile;
        }
        return 'anthropic'; // Default to Anthropic
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
    const [showAdvanced, setShowAdvanced] = React.useState(false);

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

    // Validation
    const canCreate = React.useMemo(() => {
        return (
            selectedProfileId !== null &&
            selectedMachineId !== null &&
            selectedPath.trim() !== ''
        );
    }, [selectedProfileId, selectedMachineId, selectedPath]);

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
            // Set session type from profile's default
            if (profile.defaultSessionType) {
                setSessionType(profile.defaultSessionType);
            }
            // Set permission mode from profile's default
            if (profile.defaultPermissionMode) {
                setPermissionMode(profile.defaultPermissionMode as PermissionMode);
            }
        }
    }, [profileMap]);

    const handleAddProfile = React.useCallback(() => {
        const newProfile: AIBackendProfile = {
            id: randomUUID(),
            name: '',
            anthropicConfig: {},
            environmentVariables: [],
            compatibility: { claude: true, codex: true },
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        };
        const profileData = encodeURIComponent(JSON.stringify(newProfile));
        router.push(`/new/pick/profile-edit?profileData=${profileData}`);
    }, [router]);

    const handleEditProfile = React.useCallback((profile: AIBackendProfile) => {
        const profileData = encodeURIComponent(JSON.stringify(profile));
        router.push(`/new/pick/profile-edit?profileData=${profileData}`);
    }, [router]);

    const handleDuplicateProfile = React.useCallback((profile: AIBackendProfile) => {
        const duplicatedProfile: AIBackendProfile = {
            ...profile,
            id: randomUUID(),
            name: `${profile.name} (Copy)`,
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const profileData = encodeURIComponent(JSON.stringify(duplicatedProfile));
        router.push(`/new/pick/profile-edit?profileData=${profileData}`);
    }, [router]);

    const handleDeleteProfile = React.useCallback((profile: AIBackendProfile) => {
        Modal.alert(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            [
                { text: t('profiles.delete.cancel'), style: 'cancel' },
                {
                    text: t('profiles.delete.confirm'),
                    style: 'destructive',
                    onPress: () => {
                        const updatedProfiles = profiles.filter(p => p.id !== profile.id);
                        setProfiles(updatedProfiles); // Use mutable setter for persistence
                        if (selectedProfileId === profile.id) {
                            setSelectedProfileId('anthropic'); // Default to Anthropic
                        }
                    }
                }
            ]
        );
    }, [profiles, selectedProfileId, setProfiles]);

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

    React.useEffect(() => {
        let handler = (savedProfile: AIBackendProfile) => {
            // Handle saved profile from profile-edit screen

            // Check if this is a built-in profile being edited
            const isBuiltIn = DEFAULT_PROFILES.some(bp => bp.id === savedProfile.id);
            let profileToSave = savedProfile;

            // For built-in profiles, create a new custom profile instead of modifying the built-in
            if (isBuiltIn) {
                profileToSave = {
                    ...savedProfile,
                    id: randomUUID(), // Generate new UUID for custom profile
                    isBuiltIn: false,
                };
            }

            const existingIndex = profiles.findIndex(p => p.id === profileToSave.id);
            let updatedProfiles: AIBackendProfile[];

            if (existingIndex >= 0) {
                // Update existing profile
                updatedProfiles = [...profiles];
                updatedProfiles[existingIndex] = profileToSave;
            } else {
                // Add new profile
                updatedProfiles = [...profiles, profileToSave];
            }

            setProfiles(updatedProfiles); // Use mutable setter for persistence
            setSelectedProfileId(profileToSave.id);
        };
        onProfileSaved = handler;
        return () => {
            onProfileSaved = () => { };
        };
    }, [profiles, setProfiles]);

    const handleMachineClick = React.useCallback(() => {
        router.push('/new/pick/machine');
    }, [router]);

    const handlePathClick = React.useCallback(() => {
        if (selectedMachineId) {
            router.push(`/new/pick/path?machineId=${selectedMachineId}&selectedPath=${encodeURIComponent(selectedPath)}`);
        }
    }, [selectedMachineId, selectedPath, router]);

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

        setIsCreating(true);

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

                // Send initial message if provided
                if (sessionPrompt.trim()) {
                    await sync.sendMessage(result.sessionId, sessionPrompt);
                }

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
        }
    }, [selectedMachineId, selectedPath, sessionPrompt, sessionType, experimentsEnabled, agentType, selectedProfileId, permissionMode, modelMode, recentMachinePaths, profileMap, router]);

    const screenWidth = useWindowDimensions().width;

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
                        <View style={styles.wizardContainer}>
                            {/* Section 1: Profile Management */}
                            <Text style={styles.sectionHeader}>1. Choose AI Profile</Text>
                            <Text style={styles.sectionDescription}>
                                Select, create, or edit AI profiles with custom environment variables.
                            </Text>

                            {/* Built-in profiles */}
                            {DEFAULT_PROFILES.map((profileDisplay) => {
                                const profile = getBuiltInProfile(profileDisplay.id);
                                if (!profile || !validateProfileForAgent(profile, agentType)) return null;

                                return (
                                    <Pressable
                                        key={profile.id}
                                        style={[
                                            styles.profileListItem,
                                            selectedProfileId === profile.id && styles.profileListItemSelected,
                                        ]}
                                        onPress={() => selectProfile(profile.id)}
                                    >
                                        <View style={styles.profileIcon}>
                                            <Ionicons name="star" size={16} color={theme.colors.button.primary.tint} />
                                        </View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.profileListName}>{profile.name}</Text>
                                            <Text style={styles.profileListDetails}>
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
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    handleEditProfile(profile);
                                                }}
                                            >
                                                <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                            </Pressable>
                                        </View>
                                    </Pressable>
                                );
                            })}

                            {/* Custom profiles */}
                            {profiles.map((profile) => {
                                if (!validateProfileForAgent(profile, agentType)) return null;

                                return (
                                    <Pressable
                                        key={profile.id}
                                        style={[
                                            styles.profileListItem,
                                            selectedProfileId === profile.id && styles.profileListItemSelected,
                                        ]}
                                        onPress={() => selectProfile(profile.id)}
                                    >
                                        <View style={[styles.profileIcon, { backgroundColor: theme.colors.button.secondary.tint }]}>
                                            <Ionicons name="person" size={16} color={theme.colors.button.primary.tint} />
                                        </View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.profileListName}>{profile.name}</Text>
                                            <Text style={styles.profileListDetails}>
                                                {profile.anthropicConfig?.model || profile.openaiConfig?.model || 'Default model'}
                                            </Text>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                            {selectedProfileId === profile.id && (
                                                <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} style={{ marginRight: 12 }} />
                                            )}
                                            <Pressable
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    handleEditProfile(profile);
                                                }}
                                            >
                                                <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                            </Pressable>
                                            <Pressable
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                style={{ marginLeft: 16 }}
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    handleDuplicateProfile(profile);
                                                }}
                                            >
                                                <Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
                                            </Pressable>
                                            <Pressable
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                style={{ marginLeft: 16 }}
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    handleDeleteProfile(profile);
                                                }}
                                            >
                                                <Ionicons name="trash-outline" size={20} color="#FF6B6B" />
                                            </Pressable>
                                        </View>
                                    </Pressable>
                                );
                            })}

                            {/* Profile Action Buttons */}
                            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                                <Pressable
                                    style={[styles.addProfileButton, { flex: 1 }]}
                                    onPress={handleAddProfile}
                                >
                                    <Ionicons name="add-circle-outline" size={20} color={theme.colors.button.secondary.tint} />
                                    <Text style={styles.addProfileButtonText}>
                                        Add
                                    </Text>
                                </Pressable>
                                {selectedProfile && !selectedProfile.isBuiltIn && (
                                    <>
                                        <Pressable
                                            style={[styles.addProfileButton, { flex: 1 }]}
                                            onPress={() => selectedProfile && handleDuplicateProfile(selectedProfile)}
                                        >
                                            <Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
                                            <Text style={styles.addProfileButtonText}>
                                                Duplicate
                                            </Text>
                                        </Pressable>
                                        <Pressable
                                            style={[styles.addProfileButton, { flex: 1 }]}
                                            onPress={() => selectedProfile && handleDeleteProfile(selectedProfile)}
                                        >
                                            <Ionicons name="trash-outline" size={20} color="#FF6B6B" />
                                            <Text style={[styles.addProfileButtonText, { color: '#FF6B6B' }]}>
                                                Delete
                                            </Text>
                                        </Pressable>
                                    </>
                                )}
                            </View>

                            {/* Section 2: Machine Selection */}
                            <Text style={styles.sectionHeader}>2. Select Machine</Text>
                            <Pressable
                                style={styles.selectorButton}
                                onPress={handleMachineClick}
                            >
                                <Text style={styles.selectorButtonText}>
                                    {selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host || 'Select a machine...'}
                                </Text>
                                <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
                            </Pressable>

                            {/* Section 3: Working Directory */}
                            <Text style={styles.sectionHeader}>3. Working Directory</Text>
                            <Pressable
                                style={styles.selectorButton}
                                onPress={handlePathClick}
                                disabled={!selectedMachineId}
                            >
                                <Text style={styles.selectorButtonText}>
                                    {selectedPath || 'Select a path...'}
                                </Text>
                                <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
                            </Pressable>

                            {/* Section 4: Permission Mode */}
                            <Text style={styles.sectionHeader}>4. Permission Mode</Text>
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
                                                color={permissionMode === option.value ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                                            />
                                        }
                                        rightElement={permissionMode === option.value ? (
                                            <Ionicons
                                                name="checkmark-circle"
                                                size={20}
                                                color={theme.colors.button.primary.tint}
                                            />
                                        ) : null}
                                        onPress={() => setPermissionMode(option.value)}
                                        showChevron={false}
                                        selected={permissionMode === option.value}
                                        showDivider={index < array.length - 1}
                                        style={permissionMode === option.value ? {
                                            borderWidth: 2,
                                            borderColor: theme.colors.button.primary.tint,
                                            borderRadius: 8,
                                        } : undefined}
                                    />
                                ))}
                            </ItemGroup>

                            {/* Section 5: Advanced Options (Collapsible) */}
                            {experimentsEnabled && (
                                <>
                                    <Pressable
                                        style={styles.advancedHeader}
                                        onPress={() => setShowAdvanced(!showAdvanced)}
                                    >
                                        <Text style={styles.advancedHeaderText}>Advanced Options</Text>
                                        <Ionicons
                                            name={showAdvanced ? "chevron-up" : "chevron-down"}
                                            size={20}
                                            color={theme.colors.text}
                                        />
                                    </Pressable>

                                    {showAdvanced && (
                                        <View style={{ marginBottom: 12 }}>
                                            <SessionTypeSelector
                                                value={sessionType}
                                                onChange={setSessionType}
                                            />
                                        </View>
                                    )}
                                </>
                            )}
                        </View>

                        {/* Section 5: AgentInput at bottom */}
                        <View style={{ marginHorizontal: 16, marginBottom: 16 }}>
                            <AgentInput
                                value={sessionPrompt}
                                onChangeText={setSessionPrompt}
                                onSend={handleCreateSession}
                                isSendDisabled={!canCreate}
                                isSending={isCreating}
                                placeholder="What would you like to work on?"
                                autocompletePrefixes={[]}
                                autocompleteSuggestions={async () => []}
                                agentType={agentType}
                                permissionMode={permissionMode}
                                modelMode={modelMode}
                                machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                                currentPath={selectedPath}
                            />
                        </View>
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

export default React.memo(NewSessionWizard);
