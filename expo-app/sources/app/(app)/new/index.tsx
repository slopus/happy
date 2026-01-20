import React from 'react';
import { View, Text, Platform, Pressable, useWindowDimensions, ScrollView, TextInput } from 'react-native';
import Constants from 'expo-constants';
import { Typography } from '@/constants/Typography';
import { useAllMachines, storage, useSetting, useSettingMutable, useSessions } from '@/sync/storage';
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
import { useCLIDetection } from '@/hooks/useCLIDetection';
import { useEnvironmentVariables, resolveEnvVarSubstitution, extractEnvVarReferences } from '@/hooks/useEnvironmentVariables';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { MultiTextInput } from '@/components/MultiTextInput';
import { isMachineOnline } from '@/utils/machineUtils';
import { StatusDot } from '@/components/StatusDot';
import { SearchableListSelector, SelectorConfig } from '@/components/SearchableListSelector';
import { clearNewSessionDraft, loadNewSessionDraft, saveNewSessionDraft } from '@/sync/persistence';

// Simple temporary state for passing selections back from picker screens
let onMachineSelected: (machineId: string) => void = () => { };
let onProfileSaved: (profile: AIBackendProfile) => void = () => { };

export const callbacks = {
    onMachineSelected: (machineId: string) => {
        onMachineSelected(machineId);
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
const transformProfileToEnvironmentVars = (profile: AIBackendProfile, agentType: 'claude' | 'codex' | 'gemini' = 'claude') => {
    // getProfileEnvironmentVariables already returns ALL env vars from profile
    // including custom environmentVariables array and provider-specific configs
    return getProfileEnvironmentVariables(profile);
};

// Helper function to get the most recent path for a machine
// Returns the path from the most recently CREATED session for this machine
const getRecentPathForMachine = (machineId: string | null, recentPaths: Array<{ machineId: string; path: string }>): string => {
    if (!machineId) return '';

    const machine = storage.getState().machines[machineId];
    const defaultPath = machine?.metadata?.homeDir || '';

    // Get all sessions for this machine, sorted by creation time (most recent first)
    const sessions = Object.values(storage.getState().sessions);
    const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];

    sessions.forEach(session => {
        if (session.metadata?.machineId === machineId && session.metadata?.path) {
            pathsWithTimestamps.push({
                path: session.metadata.path,
                timestamp: session.createdAt // Use createdAt, not updatedAt
            });
        }
    });

    // Sort by creation time (most recently created first)
    pathsWithTimestamps.sort((a, b) => b.timestamp - a.timestamp);

    // Return the most recently created session's path, or default
    return pathsWithTimestamps[0]?.path || defaultPath;
};

// Configuration constants
const RECENT_PATHS_DEFAULT_VISIBLE = 5;
const STATUS_ITEM_GAP = 11; // Spacing between status items (machine, CLI) - ~2 character spaces at 11px font

const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
        paddingTop: Platform.OS === 'web' ? 0 : 40,
    },
    scrollContainer: {
        flex: 1,
    },
    contentContainer: {
        width: '100%',
        alignSelf: 'center',
        paddingTop: rt.insets.top,
        paddingBottom: 16,
    },
    wizardContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        marginHorizontal: 16,
        padding: 16,
        marginBottom: 16,
    },
    sectionHeader: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
        marginTop: 12,
        ...Typography.default('semiBold')
    },
    sectionDescription: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 12,
        lineHeight: 18,
        ...Typography.default()
    },
    profileListItem: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        padding: 8,
        marginBottom: 8,
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
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.button.primary.background,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 10,
    },
    profileListName: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold')
    },
    profileListDetails: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default()
    },
    addProfileButton: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    addProfileButtonText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.button.secondary.tint,
        marginLeft: 8,
        ...Typography.default('semiBold')
    },
    selectorButton: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        padding: 10,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    selectorButtonText: {
        color: theme.colors.text,
        fontSize: 13,
        flex: 1,
        ...Typography.default()
    },
    advancedHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
    },
    advancedHeaderText: {
        fontSize: 13,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        ...Typography.default(),
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
    const safeArea = useSafeAreaInsets();
    const { prompt, dataId, machineId: machineIdParam, path: pathParam } = useLocalSearchParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string;
        path?: string;
    }>();

    // Try to get data from temporary store first
    const tempSessionData = React.useMemo(() => {
        if (dataId) {
            return getTempData<NewSessionData>(dataId);
        }
        return null;
    }, [dataId]);

    // Load persisted draft state (survives remounts/screen navigation)
    const persistedDraft = React.useRef(loadNewSessionDraft()).current;

    // Settings and state
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');

    // A/B Test Flag - determines which wizard UI to show
    // Control A (false): Simpler AgentInput-driven layout
    // Variant B (true): Enhanced profile-first wizard with sections
    const useEnhancedSessionWizard = useSetting('useEnhancedSessionWizard');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');
    const lastUsedModelMode = useSetting('lastUsedModelMode');
    const experimentsEnabled = useSetting('experiments');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [dismissedCLIWarnings, setDismissedCLIWarnings] = useSettingMutable('dismissedCLIWarnings');

    // Combined profiles (built-in + custom)
    const allProfiles = React.useMemo(() => {
        const builtInProfiles = DEFAULT_PROFILES.map(bp => getBuiltInProfile(bp.id)!);
        return [...builtInProfiles, ...profiles];
    }, [profiles]);

    const profileMap = useProfileMap(allProfiles);
    const machines = useAllMachines();
    const sessions = useSessions();

    // Wizard state
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(() => {
        if (lastUsedProfile && profileMap.has(lastUsedProfile)) {
            return lastUsedProfile;
        }
        return 'anthropic'; // Default to Anthropic
    });
    const [agentType, setAgentType] = React.useState<'claude' | 'codex' | 'gemini'>(() => {
        // Check if agent type was provided in temp data
        if (tempSessionData?.agentType) {
            // Only allow gemini if experiments are enabled
            if (tempSessionData.agentType === 'gemini' && !experimentsEnabled) {
                return 'claude';
            }
            return tempSessionData.agentType;
        }
        if (lastUsedAgent === 'claude' || lastUsedAgent === 'codex') {
            return lastUsedAgent;
        }
        // Only allow gemini if experiments are enabled
        if (lastUsedAgent === 'gemini' && experimentsEnabled) {
            return lastUsedAgent;
        }
        return 'claude';
    });

    // Agent cycling handler (for cycling through claude -> codex -> gemini)
    // Note: Does NOT persist immediately - persistence is handled by useEffect below
    const handleAgentClick = React.useCallback(() => {
        setAgentType(prev => {
            // Cycle: claude -> codex -> gemini (if experiments) -> claude
            if (prev === 'claude') return 'codex';
            if (prev === 'codex') return experimentsEnabled ? 'gemini' : 'claude';
            return 'claude';
        });
    }, [experimentsEnabled]);

    // Persist agent selection changes (separate from setState to avoid race condition)
    // This runs after agentType state is updated, ensuring the value is stable
    React.useEffect(() => {
        sync.applySettings({ lastUsedAgent: agentType });
    }, [agentType]);

    const [sessionType, setSessionType] = React.useState<'simple' | 'worktree'>('simple');
    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(() => {
        // Initialize with last used permission mode if valid, otherwise default to 'default'
        const validClaudeModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        const validCodexGeminiModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

        if (lastUsedPermissionMode) {
            if ((agentType === 'codex' || agentType === 'gemini') && validCodexGeminiModes.includes(lastUsedPermissionMode as PermissionMode)) {
                return lastUsedPermissionMode as PermissionMode;
            } else if (agentType === 'claude' && validClaudeModes.includes(lastUsedPermissionMode as PermissionMode)) {
                return lastUsedPermissionMode as PermissionMode;
            }
        }
        return 'default';
    });

    // NOTE: Permission mode reset on agentType change is handled by the validation useEffect below (lines ~670-681)
    // which intelligently resets only when the current mode is invalid for the new agent type.
    // A duplicate unconditional reset here was removed to prevent race conditions.

    const [modelMode, setModelMode] = React.useState<ModelMode>(() => {
        const validClaudeModes: ModelMode[] = ['default', 'adaptiveUsage', 'sonnet', 'opus'];
        const validCodexModes: ModelMode[] = ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-minimal', 'gpt-5-low', 'gpt-5-medium', 'gpt-5-high'];
        // Note: 'default' is NOT valid for Gemini - we want explicit model selection
        const validGeminiModes: ModelMode[] = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

        if (lastUsedModelMode) {
            if (agentType === 'codex' && validCodexModes.includes(lastUsedModelMode as ModelMode)) {
                return lastUsedModelMode as ModelMode;
            } else if (agentType === 'claude' && validClaudeModes.includes(lastUsedModelMode as ModelMode)) {
                return lastUsedModelMode as ModelMode;
            } else if (agentType === 'gemini' && validGeminiModes.includes(lastUsedModelMode as ModelMode)) {
                return lastUsedModelMode as ModelMode;
            }
        }
        return agentType === 'codex' ? 'gpt-5-codex-high' : agentType === 'gemini' ? 'gemini-2.5-pro' : 'default';
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

    const handlePermissionModeChange = React.useCallback((mode: PermissionMode) => {
        setPermissionMode(mode);
        // Save the new selection immediately
        sync.applySettings({ lastUsedPermissionMode: mode });
    }, []);

    //
    // Path selection
    //

    const [selectedPath, setSelectedPath] = React.useState<string>(() => {
        return getRecentPathForMachine(selectedMachineId, recentMachinePaths);
    });
    const [sessionPrompt, setSessionPrompt] = React.useState(() => {
        return tempSessionData?.prompt || prompt || persistedDraft?.input || '';
    });
    const [isCreating, setIsCreating] = React.useState(false);
    const [showAdvanced, setShowAdvanced] = React.useState(false);

    // Handle machineId route param from picker screens (main's navigation pattern)
    React.useEffect(() => {
        if (typeof machineIdParam !== 'string' || machines.length === 0) {
            return;
        }
        if (!machines.some(m => m.id === machineIdParam)) {
            return;
        }
        if (machineIdParam !== selectedMachineId) {
            setSelectedMachineId(machineIdParam);
            const bestPath = getRecentPathForMachine(machineIdParam, recentMachinePaths);
            setSelectedPath(bestPath);
        }
    }, [machineIdParam, machines, recentMachinePaths, selectedMachineId]);

    // Handle path route param from picker screens (main's navigation pattern)
    React.useEffect(() => {
        if (typeof pathParam !== 'string') {
            return;
        }
        const trimmedPath = pathParam.trim();
        if (trimmedPath && trimmedPath !== selectedPath) {
            setSelectedPath(trimmedPath);
        }
    }, [pathParam, selectedPath]);

    // Path selection state - initialize with formatted selected path

    // Refs for scrolling to sections
    const scrollViewRef = React.useRef<ScrollView>(null);
    const profileSectionRef = React.useRef<View>(null);
    const machineSectionRef = React.useRef<View>(null);
    const pathSectionRef = React.useRef<View>(null);
    const permissionSectionRef = React.useRef<View>(null);

    // CLI Detection - automatic, non-blocking detection of installed CLIs on selected machine
    const cliAvailability = useCLIDetection(selectedMachineId);

    // Auto-correct invalid agent selection after CLI detection completes
    // This handles the case where lastUsedAgent was 'codex' but codex is not installed
    React.useEffect(() => {
        // Only act when detection has completed (timestamp > 0)
        if (cliAvailability.timestamp === 0) return;

        // Check if currently selected agent is available
        const agentAvailable = cliAvailability[agentType];

        if (agentAvailable === false) {
            // Current agent not available - find first available
            const availableAgent: 'claude' | 'codex' | 'gemini' =
                cliAvailability.claude === true ? 'claude' :
                cliAvailability.codex === true ? 'codex' :
                (cliAvailability.gemini === true && experimentsEnabled) ? 'gemini' :
                'claude'; // Fallback to claude (will fail at spawn with clear error)

            console.warn(`[AgentSelection] ${agentType} not available, switching to ${availableAgent}`);
            setAgentType(availableAgent);
        }
    }, [cliAvailability.timestamp, cliAvailability.claude, cliAvailability.codex, cliAvailability.gemini, agentType, experimentsEnabled]);

    // Extract all ${VAR} references from profiles to query daemon environment
    const envVarRefs = React.useMemo(() => {
        const refs = new Set<string>();
        allProfiles.forEach(profile => {
            extractEnvVarReferences(profile.environmentVariables || [])
                .forEach(ref => refs.add(ref));
        });
        return Array.from(refs);
    }, [allProfiles]);

    // Query daemon environment for ${VAR} resolution
    const { variables: daemonEnv } = useEnvironmentVariables(selectedMachineId, envVarRefs);

    // Temporary banner dismissal (X button) - resets when component unmounts or machine changes
    const [hiddenBanners, setHiddenBanners] = React.useState<{ claude: boolean; codex: boolean; gemini: boolean }>({ claude: false, codex: false, gemini: false });

    // Helper to check if CLI warning has been dismissed (checks both global and per-machine)
    const isWarningDismissed = React.useCallback((cli: 'claude' | 'codex' | 'gemini'): boolean => {
        // Check global dismissal first
        if (dismissedCLIWarnings.global?.[cli] === true) return true;
        // Check per-machine dismissal
        if (!selectedMachineId) return false;
        return dismissedCLIWarnings.perMachine?.[selectedMachineId]?.[cli] === true;
    }, [selectedMachineId, dismissedCLIWarnings]);

    // Unified dismiss handler for all three button types (easy to use correctly, hard to use incorrectly)
    const handleCLIBannerDismiss = React.useCallback((cli: 'claude' | 'codex' | 'gemini', type: 'temporary' | 'machine' | 'global') => {
        if (type === 'temporary') {
            // X button: Hide for current session only (not persisted)
            setHiddenBanners(prev => ({ ...prev, [cli]: true }));
        } else if (type === 'global') {
            // [any machine] button: Permanent dismissal across all machines
            setDismissedCLIWarnings({
                ...dismissedCLIWarnings,
                global: {
                    ...dismissedCLIWarnings.global,
                    [cli]: true,
                },
            });
        } else {
            // [this machine] button: Permanent dismissal for current machine only
            if (!selectedMachineId) return;
            const machineWarnings = dismissedCLIWarnings.perMachine?.[selectedMachineId] || {};
            setDismissedCLIWarnings({
                ...dismissedCLIWarnings,
                perMachine: {
                    ...dismissedCLIWarnings.perMachine,
                    [selectedMachineId]: {
                        ...machineWarnings,
                        [cli]: true,
                    },
                },
            });
        }
    }, [selectedMachineId, dismissedCLIWarnings, setDismissedCLIWarnings]);

    // Helper to check if profile is available (compatible + CLI detected)
    const isProfileAvailable = React.useCallback((profile: AIBackendProfile): { available: boolean; reason?: string } => {
        // Check profile compatibility with selected agent type
        if (!validateProfileForAgent(profile, agentType)) {
            // Build list of agents this profile supports (excluding current)
            // Uses Object.entries to iterate over compatibility flags - scales automatically with new agents
            const supportedAgents = (Object.entries(profile.compatibility) as [string, boolean][])
                .filter(([agent, supported]) => supported && agent !== agentType)
                .map(([agent]) => agent.charAt(0).toUpperCase() + agent.slice(1)); // 'claude' -> 'Claude'
            const required = supportedAgents.join(' or ') || 'another agent';
            return {
                available: false,
                reason: `requires-agent:${required}`,
            };
        }

        // Check if required CLI is detected on machine (only if detection completed)
        // Determine required CLI: if profile supports exactly one CLI, that CLI is required
        // Uses Object.entries to iterate - scales automatically when new agents are added
        const supportedCLIs = (Object.entries(profile.compatibility) as [string, boolean][])
            .filter(([, supported]) => supported)
            .map(([agent]) => agent);
        const requiredCLI = supportedCLIs.length === 1 ? supportedCLIs[0] as 'claude' | 'codex' | 'gemini' : null;

        if (requiredCLI && cliAvailability[requiredCLI] === false) {
            return {
                available: false,
                reason: `cli-not-detected:${requiredCLI}`,
            };
        }

        // Optimistic: If detection hasn't completed (null) or profile supports both, assume available
        return { available: true };
    }, [agentType, cliAvailability]);

    // Computed values
    const compatibleProfiles = React.useMemo(() => {
        return allProfiles.filter(profile => validateProfileForAgent(profile, agentType));
    }, [allProfiles, agentType]);

    const selectedProfile = React.useMemo(() => {
        if (!selectedProfileId) {
            return null;
        }
        // Check custom profiles first
        if (profileMap.has(selectedProfileId)) {
            return profileMap.get(selectedProfileId)!;
        }
        // Check built-in profiles
        return getBuiltInProfile(selectedProfileId);
    }, [selectedProfileId, profileMap]);

    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId);
    }, [selectedMachineId, machines]);

    // Get recent paths for the selected machine
    // Recent machines computed from sessions (for inline machine selection)
    const recentMachines = React.useMemo(() => {
        const machineIds = new Set<string>();
        const machinesWithTimestamp: Array<{ machine: typeof machines[0]; timestamp: number }> = [];

        sessions?.forEach(item => {
            if (typeof item === 'string') return; // Skip section headers
            const session = item as any;
            if (session.metadata?.machineId && !machineIds.has(session.metadata.machineId)) {
                const machine = machines.find(m => m.id === session.metadata.machineId);
                if (machine) {
                    machineIds.add(machine.id);
                    machinesWithTimestamp.push({
                        machine,
                        timestamp: session.updatedAt || session.createdAt
                    });
                }
            }
        });

        return machinesWithTimestamp
            .sort((a, b) => b.timestamp - a.timestamp)
            .map(item => item.machine);
    }, [sessions, machines]);

    const recentPaths = React.useMemo(() => {
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
        // Check both custom profiles and built-in profiles
        const profile = profileMap.get(profileId) || getBuiltInProfile(profileId);
        if (profile) {
            // Auto-select agent based on profile's EXCLUSIVE compatibility
            // Only switch if profile supports exactly one CLI - scales automatically with new agents
            const supportedCLIs = (Object.entries(profile.compatibility) as [string, boolean][])
                .filter(([, supported]) => supported)
                .map(([agent]) => agent);

            if (supportedCLIs.length === 1) {
                const requiredAgent = supportedCLIs[0] as 'claude' | 'codex' | 'gemini';
                // Check if this agent is available and allowed
                const isAvailable = cliAvailability[requiredAgent] !== false;
                const isAllowed = requiredAgent !== 'gemini' || experimentsEnabled;

                if (isAvailable && isAllowed) {
                    setAgentType(requiredAgent);
                }
                // If the required CLI is unavailable or not allowed, keep current agent (profile will show as unavailable)
            }
            // If supportedCLIs.length > 1, profile supports multiple CLIs - don't force agent switch

            // Set session type from profile's default
            if (profile.defaultSessionType) {
                setSessionType(profile.defaultSessionType);
            }
            // Set permission mode from profile's default
            if (profile.defaultPermissionMode) {
                setPermissionMode(profile.defaultPermissionMode as PermissionMode);
            }
        }
    }, [profileMap, cliAvailability.claude, cliAvailability.codex, cliAvailability.gemini, experimentsEnabled]);

    // Reset permission mode to 'default' when agent type changes and current mode is invalid for new agent
    React.useEffect(() => {
        const validClaudeModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        const validCodexGeminiModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

        const isValidForCurrentAgent = (agentType === 'codex' || agentType === 'gemini')
            ? validCodexGeminiModes.includes(permissionMode)
            : validClaudeModes.includes(permissionMode);

        if (!isValidForCurrentAgent) {
            setPermissionMode('default');
        }
    }, [agentType, permissionMode]);

    // Reset model mode when agent type changes to appropriate default
    React.useEffect(() => {
        const validClaudeModes: ModelMode[] = ['default', 'adaptiveUsage', 'sonnet', 'opus'];
        const validCodexModes: ModelMode[] = ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-minimal', 'gpt-5-low', 'gpt-5-medium', 'gpt-5-high'];
        // Note: 'default' is NOT valid for Gemini - we want explicit model selection
        const validGeminiModes: ModelMode[] = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

        let isValidForCurrentAgent = false;
        if (agentType === 'codex') {
            isValidForCurrentAgent = validCodexModes.includes(modelMode);
        } else if (agentType === 'gemini') {
            isValidForCurrentAgent = validGeminiModes.includes(modelMode);
        } else {
            isValidForCurrentAgent = validClaudeModes.includes(modelMode);
        }

        if (!isValidForCurrentAgent) {
            // Set appropriate default for each agent type
            if (agentType === 'codex') {
                setModelMode('gpt-5-codex-high');
            } else if (agentType === 'gemini') {
                setModelMode('gemini-2.5-pro');
            } else {
                setModelMode('default');
            }
        }
    }, [agentType, modelMode]);

    // Scroll to section helpers - for AgentInput button clicks
    const scrollToSection = React.useCallback((ref: React.RefObject<View | Text | null>) => {
        if (!ref.current || !scrollViewRef.current) return;

        // Use requestAnimationFrame to ensure layout is painted before measuring
        requestAnimationFrame(() => {
            if (ref.current && scrollViewRef.current) {
                ref.current.measureLayout(
                    scrollViewRef.current as any,
                    (x, y) => {
                        scrollViewRef.current?.scrollTo({ y: y - 20, animated: true });
                    },
                    () => {
                        console.warn('measureLayout failed');
                    }
                );
            }
        });
    }, []);

    const handleAgentInputProfileClick = React.useCallback(() => {
        scrollToSection(profileSectionRef);
    }, [scrollToSection]);

    const handleAgentInputMachineClick = React.useCallback(() => {
        scrollToSection(machineSectionRef);
    }, [scrollToSection]);

    const handleAgentInputPathClick = React.useCallback(() => {
        scrollToSection(pathSectionRef);
    }, [scrollToSection]);

    const handleAgentInputPermissionChange = React.useCallback((mode: PermissionMode) => {
        setPermissionMode(mode);
        scrollToSection(permissionSectionRef);
    }, [scrollToSection]);

    const handleAgentInputAgentClick = React.useCallback(() => {
        scrollToSection(profileSectionRef); // Agent tied to profile section
    }, [scrollToSection]);

    const handleAddProfile = React.useCallback(() => {
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
        const profileData = encodeURIComponent(JSON.stringify(newProfile));
        router.push(`/new/pick/profile-edit?profileData=${profileData}`);
    }, [router]);

    const handleEditProfile = React.useCallback((profile: AIBackendProfile) => {
        const profileData = encodeURIComponent(JSON.stringify(profile));
        const machineId = selectedMachineId || '';
        router.push(`/new/pick/profile-edit?profileData=${profileData}&machineId=${machineId}`);
    }, [router, selectedMachineId]);

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

    // Helper to get meaningful subtitle text for profiles
    const getProfileSubtitle = React.useCallback((profile: AIBackendProfile): string => {
        const parts: string[] = [];
        const availability = isProfileAvailable(profile);

        // Add "Built-in" indicator first for built-in profiles
        if (profile.isBuiltIn) {
            parts.push('Built-in');
        }

        // Add CLI type second (before warnings/availability)
        if (profile.compatibility.claude && profile.compatibility.codex) {
            parts.push('Claude & Codex CLI');
        } else if (profile.compatibility.claude) {
            parts.push('Claude CLI');
        } else if (profile.compatibility.codex) {
            parts.push('Codex CLI');
        }

        // Add availability warning if unavailable
        if (!availability.available && availability.reason) {
            if (availability.reason.startsWith('requires-agent:')) {
                const required = availability.reason.split(':')[1];
                parts.push(`⚠️ This profile uses ${required} CLI only`);
            } else if (availability.reason.startsWith('cli-not-detected:')) {
                const cli = availability.reason.split(':')[1];
                const cliName = cli === 'claude' ? 'Claude' : 'Codex';
                parts.push(`⚠️ ${cliName} CLI not detected (this profile needs it)`);
            }
        }

        // Get model name - check both anthropicConfig and environmentVariables
        let modelName: string | undefined;
        if (profile.anthropicConfig?.model) {
            // User set in GUI - literal value, no evaluation needed
            modelName = profile.anthropicConfig.model;
        } else if (profile.openaiConfig?.model) {
            modelName = profile.openaiConfig.model;
        } else {
            // Check environmentVariables - may need ${VAR} evaluation
            const modelEnvVar = profile.environmentVariables?.find(ev => ev.name === 'ANTHROPIC_MODEL');
            if (modelEnvVar) {
                const resolved = resolveEnvVarSubstitution(modelEnvVar.value, daemonEnv);
                if (resolved) {
                    // Show as "VARIABLE: value" when evaluated from ${VAR}
                    const varName = modelEnvVar.value.match(/^\$\{(.+)\}$/)?.[1];
                    modelName = varName ? `${varName}: ${resolved}` : resolved;
                } else {
                    // Show raw ${VAR} if not resolved (machine not selected or var not set)
                    modelName = modelEnvVar.value;
                }
            }
        }

        if (modelName) {
            parts.push(modelName);
        }

        // Add base URL if exists in environmentVariables
        const baseUrlEnvVar = profile.environmentVariables?.find(ev => ev.name === 'ANTHROPIC_BASE_URL');
        if (baseUrlEnvVar) {
            const resolved = resolveEnvVarSubstitution(baseUrlEnvVar.value, daemonEnv);
            if (resolved) {
                // Extract hostname and show with variable name
                const varName = baseUrlEnvVar.value.match(/^\$\{([A-Z_][A-Z0-9_]*)/)?.[1];
                try {
                    const url = new URL(resolved);
                    const display = varName ? `${varName}: ${url.hostname}` : url.hostname;
                    parts.push(display);
                } catch {
                    // Not a valid URL, show as-is with variable name
                    parts.push(varName ? `${varName}: ${resolved}` : resolved);
                }
            } else {
                // Show raw ${VAR} if not resolved (machine not selected or var not set)
                parts.push(baseUrlEnvVar.value);
            }
        }

        return parts.join(', ');
    }, [agentType, isProfileAvailable, daemonEnv]);

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
            router.push({
                pathname: '/new/pick/path',
                params: {
                    machineId: selectedMachineId,
                    selectedPath,
                },
            });
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
                // Clear draft state on successful session creation
                clearNewSessionDraft();

                await sync.refreshSessions();

                // Set permission mode and model mode on the session
                storage.getState().updateSessionPermissionMode(result.sessionId, permissionMode);
                if (agentType === 'gemini' && modelMode && modelMode !== 'default') {
                    storage.getState().updateSessionModelMode(result.sessionId, modelMode as 'gemini-2.5-pro' | 'gemini-2.5-flash' | 'gemini-2.5-flash-lite');
                }

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

    // Machine online status for AgentInput (DRY - reused in info box too)
    const connectionStatus = React.useMemo(() => {
        if (!selectedMachine) return undefined;
        const isOnline = isMachineOnline(selectedMachine);

        // Include CLI status only when in wizard AND detection completed
        const includeCLI = selectedMachineId && cliAvailability.timestamp > 0;

        return {
            text: isOnline ? 'online' : 'offline',
            color: isOnline ? theme.colors.success : theme.colors.textDestructive,
            dotColor: isOnline ? theme.colors.success : theme.colors.textDestructive,
            isPulsing: isOnline,
            cliStatus: includeCLI ? {
                claude: cliAvailability.claude,
                codex: cliAvailability.codex,
                ...(experimentsEnabled && { gemini: cliAvailability.gemini }),
            } : undefined,
        };
    }, [selectedMachine, selectedMachineId, cliAvailability, experimentsEnabled, theme]);

    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        if (draftSaveTimerRef.current) {
            clearTimeout(draftSaveTimerRef.current);
        }
        draftSaveTimerRef.current = setTimeout(() => {
            saveNewSessionDraft({
                input: sessionPrompt,
                selectedMachineId,
                selectedPath,
                agentType,
                permissionMode,
                sessionType,
                updatedAt: Date.now(),
            });
        }, 250);
        return () => {
            if (draftSaveTimerRef.current) {
                clearTimeout(draftSaveTimerRef.current);
            }
        };
    }, [sessionPrompt, selectedMachineId, selectedPath, agentType, permissionMode, sessionType]);

    // ========================================================================
    // CONTROL A: Simpler AgentInput-driven layout (flag OFF)
    // Shows machine/path selection via chips that navigate to picker screens
    // ========================================================================
    if (!useEnhancedSessionWizard) {
        return (
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + useHeaderHeight() : 0}
                style={styles.container}
            >
                <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                    {/* Session type selector only if experiments enabled */}
                    {experimentsEnabled && (
                        <View style={{ paddingHorizontal: screenWidth > 700 ? 16 : 8, marginBottom: 16 }}>
                            <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                                <SessionTypeSelector
                                    value={sessionType}
                                    onChange={setSessionType}
                                />
                            </View>
                        </View>
                    )}

                    {/* AgentInput with inline chips - sticky at bottom */}
                    <View style={{ paddingHorizontal: screenWidth > 700 ? 16 : 8, paddingBottom: Math.max(16, safeArea.bottom) }}>
                        <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
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
                                onAgentClick={handleAgentClick}
                                permissionMode={permissionMode}
                                onPermissionModeChange={handlePermissionModeChange}
                                modelMode={modelMode}
                                onModelModeChange={setModelMode}
                                connectionStatus={connectionStatus}
                                machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                                onMachineClick={handleMachineClick}
                                currentPath={selectedPath}
                                onPathClick={handlePathClick}
                            />
                        </View>
                    </View>
                </View>
            </KeyboardAvoidingView>
        );
    }

    // ========================================================================
    // VARIANT B: Enhanced profile-first wizard (flag ON)
    // Full wizard with numbered sections, profile management, CLI detection
    // ========================================================================
    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + useHeaderHeight() : 0}
            style={styles.container}
        >
            <View style={{ flex: 1 }}>
                <ScrollView
                    ref={scrollViewRef}
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
                        <View ref={profileSectionRef} style={styles.wizardContainer}>
                            {/* CLI Detection Status Banner - shows after detection completes */}
                            {selectedMachineId && cliAvailability.timestamp > 0 && selectedMachine && connectionStatus && (
                                <View style={{
                                    backgroundColor: theme.colors.surfacePressed,
                                    borderRadius: 10,
                                    padding: 10,
                                    paddingRight: 18,
                                    marginBottom: 12,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: STATUS_ITEM_GAP,
                                }}>
                                    <Ionicons name="desktop-outline" size={16} color={theme.colors.textSecondary} />
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: STATUS_ITEM_GAP, flexWrap: 'wrap' }}>
                                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                            {selectedMachine.metadata?.displayName || selectedMachine.metadata?.host || 'Machine'}:
                                        </Text>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                            <StatusDot
                                                color={connectionStatus.dotColor}
                                                isPulsing={connectionStatus.isPulsing}
                                                size={6}
                                            />
                                            <Text style={{ fontSize: 11, color: connectionStatus.color, ...Typography.default() }}>
                                                {connectionStatus.text}
                                            </Text>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                            <Text style={{ fontSize: 11, color: cliAvailability.claude ? theme.colors.success : theme.colors.textDestructive, ...Typography.default() }}>
                                                {cliAvailability.claude ? '✓' : '✗'}
                                            </Text>
                                            <Text style={{ fontSize: 11, color: cliAvailability.claude ? theme.colors.success : theme.colors.textDestructive, ...Typography.default() }}>
                                                claude
                                            </Text>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                            <Text style={{ fontSize: 11, color: cliAvailability.codex ? theme.colors.success : theme.colors.textDestructive, ...Typography.default() }}>
                                                {cliAvailability.codex ? '✓' : '✗'}
                                            </Text>
                                            <Text style={{ fontSize: 11, color: cliAvailability.codex ? theme.colors.success : theme.colors.textDestructive, ...Typography.default() }}>
                                                codex
                                            </Text>
                                        </View>
                                        {experimentsEnabled && (
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                <Text style={{ fontSize: 11, color: cliAvailability.gemini ? theme.colors.success : theme.colors.textDestructive, ...Typography.default() }}>
                                                    {cliAvailability.gemini ? '✓' : '✗'}
                                                </Text>
                                                <Text style={{ fontSize: 11, color: cliAvailability.gemini ? theme.colors.success : theme.colors.textDestructive, ...Typography.default() }}>
                                                    gemini
                                                </Text>
                                            </View>
                                        )}
                                    </View>
                                </View>
                            )}

                            {/* Section 1: Profile Management */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 12 }}>
                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>1.</Text>
                                <Ionicons name="person-outline" size={18} color={theme.colors.text} />
                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>Choose AI Profile</Text>
                            </View>
                            <Text style={styles.sectionDescription}>
                                Choose which AI backend runs your session (Claude or Codex). Create custom profiles for alternative APIs.
                            </Text>

                            {/* Missing CLI Installation Banners */}
                            {selectedMachineId && cliAvailability.claude === false && !isWarningDismissed('claude') && !hiddenBanners.claude && (
                                <View style={{
                                    backgroundColor: theme.colors.box.warning.background,
                                    borderRadius: 10,
                                    padding: 12,
                                    marginBottom: 12,
                                    borderWidth: 1,
                                    borderColor: theme.colors.box.warning.border,
                                }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                                        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginRight: 16 }}>
                                            <Ionicons name="warning" size={16} color={theme.colors.warning} />
                                            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                                                Claude CLI Not Detected
                                            </Text>
                                            <View style={{ flex: 1, minWidth: 20 }} />
                                            <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                Don't show this popup for
                                            </Text>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('claude', 'machine')}
                                                style={{
                                                    borderRadius: 4,
                                                    borderWidth: 1,
                                                    borderColor: theme.colors.textSecondary,
                                                    paddingHorizontal: 8,
                                                    paddingVertical: 3,
                                                }}
                                            >
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    this machine
                                                </Text>
                                            </Pressable>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('claude', 'global')}
                                                style={{
                                                    borderRadius: 4,
                                                    borderWidth: 1,
                                                    borderColor: theme.colors.textSecondary,
                                                    paddingHorizontal: 8,
                                                    paddingVertical: 3,
                                                }}
                                            >
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    any machine
                                                </Text>
                                            </Pressable>
                                        </View>
                                        <Pressable
                                            onPress={() => handleCLIBannerDismiss('claude', 'temporary')}
                                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        >
                                            <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    </View>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                            Install: npm install -g @anthropic-ai/claude-code •
                                        </Text>
                                        <Pressable onPress={() => {
                                            if (Platform.OS === 'web') {
                                                window.open('https://docs.anthropic.com/en/docs/claude-code/installation', '_blank');
                                            }
                                        }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                View Installation Guide →
                                            </Text>
                                        </Pressable>
                                    </View>
                                </View>
                            )}

                            {selectedMachineId && cliAvailability.codex === false && !isWarningDismissed('codex') && !hiddenBanners.codex && (
                                <View style={{
                                    backgroundColor: theme.colors.box.warning.background,
                                    borderRadius: 10,
                                    padding: 12,
                                    marginBottom: 12,
                                    borderWidth: 1,
                                    borderColor: theme.colors.box.warning.border,
                                }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                                        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginRight: 16 }}>
                                            <Ionicons name="warning" size={16} color={theme.colors.warning} />
                                            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                                                Codex CLI Not Detected
                                            </Text>
                                            <View style={{ flex: 1, minWidth: 20 }} />
                                            <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                Don't show this popup for
                                            </Text>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('codex', 'machine')}
                                                style={{
                                                    borderRadius: 4,
                                                    borderWidth: 1,
                                                    borderColor: theme.colors.textSecondary,
                                                    paddingHorizontal: 8,
                                                    paddingVertical: 3,
                                                }}
                                            >
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    this machine
                                                </Text>
                                            </Pressable>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('codex', 'global')}
                                                style={{
                                                    borderRadius: 4,
                                                    borderWidth: 1,
                                                    borderColor: theme.colors.textSecondary,
                                                    paddingHorizontal: 8,
                                                    paddingVertical: 3,
                                                }}
                                            >
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    any machine
                                                </Text>
                                            </Pressable>
                                        </View>
                                        <Pressable
                                            onPress={() => handleCLIBannerDismiss('codex', 'temporary')}
                                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        >
                                            <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    </View>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                            Install: npm install -g codex-cli •
                                        </Text>
                                        <Pressable onPress={() => {
                                            if (Platform.OS === 'web') {
                                                window.open('https://github.com/openai/openai-codex', '_blank');
                                            }
                                        }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                View Installation Guide →
                                            </Text>
                                        </Pressable>
                                    </View>
                                </View>
                            )}

                            {selectedMachineId && cliAvailability.gemini === false && experimentsEnabled && !isWarningDismissed('gemini') && !hiddenBanners.gemini && (
                                <View style={{
                                    backgroundColor: theme.colors.box.warning.background,
                                    borderRadius: 10,
                                    padding: 12,
                                    marginBottom: 12,
                                    borderWidth: 1,
                                    borderColor: theme.colors.box.warning.border,
                                }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                                        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginRight: 16 }}>
                                            <Ionicons name="warning" size={16} color={theme.colors.warning} />
                                            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                                                Gemini CLI Not Detected
                                            </Text>
                                            <View style={{ flex: 1, minWidth: 20 }} />
                                            <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                Don't show this popup for
                                            </Text>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('gemini', 'machine')}
                                                style={{
                                                    borderRadius: 4,
                                                    borderWidth: 1,
                                                    borderColor: theme.colors.textSecondary,
                                                    paddingHorizontal: 8,
                                                    paddingVertical: 3,
                                                }}
                                            >
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    this machine
                                                </Text>
                                            </Pressable>
                                            <Pressable
                                                onPress={() => handleCLIBannerDismiss('gemini', 'global')}
                                                style={{
                                                    borderRadius: 4,
                                                    borderWidth: 1,
                                                    borderColor: theme.colors.textSecondary,
                                                    paddingHorizontal: 8,
                                                    paddingVertical: 3,
                                                }}
                                            >
                                                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                    any machine
                                                </Text>
                                            </Pressable>
                                        </View>
                                        <Pressable
                                            onPress={() => handleCLIBannerDismiss('gemini', 'temporary')}
                                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        >
                                            <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    </View>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                            Install gemini CLI if available •
                                        </Text>
                                        <Pressable onPress={() => {
                                            if (Platform.OS === 'web') {
                                                window.open('https://ai.google.dev/gemini-api/docs/get-started', '_blank');
                                            }
                                        }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                View Gemini Docs →
                                            </Text>
                                        </Pressable>
                                    </View>
                                </View>
                            )}

                            {/* Custom profiles - show first */}
                            {profiles.map((profile) => {
                                const availability = isProfileAvailable(profile);

                                return (
                                    <Pressable
                                        key={profile.id}
                                        style={[
                                            styles.profileListItem,
                                            selectedProfileId === profile.id && styles.profileListItemSelected,
                                            !availability.available && { opacity: 0.5 }
                                        ]}
                                        onPress={() => availability.available && selectProfile(profile.id)}
                                        disabled={!availability.available}
                                    >
                                        <View style={[styles.profileIcon, { backgroundColor: theme.colors.button.secondary.tint }]}>
                                            <Text style={{ fontSize: 16, color: theme.colors.button.primary.tint, ...Typography.default() }}>
                                                {profile.compatibility.claude && profile.compatibility.codex ? '✳꩜' :
                                                 profile.compatibility.claude ? '✳' : '꩜'}
                                            </Text>
                                        </View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.profileListName}>{profile.name}</Text>
                                            <Text style={styles.profileListDetails}>
                                                {getProfileSubtitle(profile)}
                                            </Text>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                            {selectedProfileId === profile.id && (
                                                <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} />
                                            )}
                                            <Pressable
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    handleDeleteProfile(profile);
                                                }}
                                            >
                                                <Ionicons name="trash-outline" size={20} color={theme.colors.deleteAction} />
                                            </Pressable>
                                            <Pressable
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    handleDuplicateProfile(profile);
                                                }}
                                            >
                                                <Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
                                            </Pressable>
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

                            {/* Built-in profiles - show after custom */}
                            {DEFAULT_PROFILES.map((profileDisplay) => {
                                const profile = getBuiltInProfile(profileDisplay.id);
                                if (!profile) return null;

                                const availability = isProfileAvailable(profile);

                                return (
                                    <Pressable
                                        key={profile.id}
                                        style={[
                                            styles.profileListItem,
                                            selectedProfileId === profile.id && styles.profileListItemSelected,
                                            !availability.available && { opacity: 0.5 }
                                        ]}
                                        onPress={() => availability.available && selectProfile(profile.id)}
                                        disabled={!availability.available}
                                    >
                                        <View style={styles.profileIcon}>
                                            <Text style={{ fontSize: 16, color: theme.colors.button.primary.tint, ...Typography.default() }}>
                                                {profile.compatibility.claude && profile.compatibility.codex ? '✳꩜' :
                                                 profile.compatibility.claude ? '✳' : '꩜'}
                                            </Text>
                                        </View>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.profileListName}>{profile.name}</Text>
                                            <Text style={styles.profileListDetails}>
                                                {getProfileSubtitle(profile)}
                                            </Text>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                            {selectedProfileId === profile.id && (
                                                <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} />
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
                                <Pressable
                                    style={[
                                        styles.addProfileButton,
                                        { flex: 1 },
                                        !selectedProfile && { opacity: 0.4 }
                                    ]}
                                    onPress={() => selectedProfile && handleDuplicateProfile(selectedProfile)}
                                    disabled={!selectedProfile}
                                >
                                    <Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
                                    <Text style={styles.addProfileButtonText}>
                                        Duplicate
                                    </Text>
                                </Pressable>
                                <Pressable
                                    style={[
                                        styles.addProfileButton,
                                        { flex: 1 },
                                        (!selectedProfile || selectedProfile.isBuiltIn) && { opacity: 0.4 }
                                    ]}
                                    onPress={() => selectedProfile && !selectedProfile.isBuiltIn && handleDeleteProfile(selectedProfile)}
                                    disabled={!selectedProfile || selectedProfile.isBuiltIn}
                                >
                                    <Ionicons name="trash-outline" size={20} color={theme.colors.deleteAction} />
                                    <Text style={[styles.addProfileButtonText, { color: theme.colors.deleteAction }]}>
                                        Delete
                                    </Text>
                                </Pressable>
                            </View>

                            {/* Section 2: Machine Selection */}
                            <View ref={machineSectionRef}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 12 }}>
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>2.</Text>
                                    <Ionicons name="desktop-outline" size={18} color={theme.colors.text} />
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>Select Machine</Text>
                                </View>
                            </View>

                            <View style={{ marginBottom: 24 }}>
                                <SearchableListSelector<typeof machines[0]>
                                    config={{
                                    getItemId: (machine) => machine.id,
                                    getItemTitle: (machine) => machine.metadata?.displayName || machine.metadata?.host || machine.id,
                                    getItemSubtitle: undefined,
                                    getItemIcon: (machine) => (
                                        <Ionicons
                                            name="desktop-outline"
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    ),
                                    getRecentItemIcon: (machine) => (
                                        <Ionicons
                                            name="time-outline"
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    ),
                                    getItemStatus: (machine) => {
                                        const offline = !isMachineOnline(machine);
                                        return {
                                            text: offline ? 'offline' : 'online',
                                            color: offline ? theme.colors.status.disconnected : theme.colors.status.connected,
                                            dotColor: offline ? theme.colors.status.disconnected : theme.colors.status.connected,
                                            isPulsing: !offline,
                                        };
                                    },
                                    formatForDisplay: (machine) => machine.metadata?.displayName || machine.metadata?.host || machine.id,
                                    parseFromDisplay: (text) => {
                                        return machines.find(m =>
                                            m.metadata?.displayName === text || m.metadata?.host === text || m.id === text
                                        ) || null;
                                    },
                                    filterItem: (machine, searchText) => {
                                        const displayName = (machine.metadata?.displayName || '').toLowerCase();
                                        const host = (machine.metadata?.host || '').toLowerCase();
                                        const search = searchText.toLowerCase();
                                        return displayName.includes(search) || host.includes(search);
                                    },
                                    searchPlaceholder: "Type to filter machines...",
                                    recentSectionTitle: "Recent Machines",
                                    favoritesSectionTitle: "Favorite Machines",
                                    noItemsMessage: "No machines available",
                                    showFavorites: true,
                                    showRecent: true,
                                    showSearch: true,
                                    allowCustomInput: false,
                                    compactItems: true,
                                }}
                                items={machines}
                                recentItems={recentMachines}
                                favoriteItems={machines.filter(m => favoriteMachines.includes(m.id))}
                                selectedItem={selectedMachine || null}
                                onSelect={(machine) => {
                                    setSelectedMachineId(machine.id);
                                    const bestPath = getRecentPathForMachine(machine.id, recentMachinePaths);
                                    setSelectedPath(bestPath);
                                }}
                                onToggleFavorite={(machine) => {
                                    const isInFavorites = favoriteMachines.includes(machine.id);
                                    if (isInFavorites) {
                                        setFavoriteMachines(favoriteMachines.filter(id => id !== machine.id));
                                    } else {
                                        setFavoriteMachines([...favoriteMachines, machine.id]);
                                    }
                                }}
                                />
                            </View>

                            {/* Section 3: Working Directory */}
                            <View ref={pathSectionRef}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 12 }}>
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>3.</Text>
                                    <Ionicons name="folder-outline" size={18} color={theme.colors.text} />
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>Select Working Directory</Text>
                                </View>
                            </View>

                            <View style={{ marginBottom: 24 }}>
                                <SearchableListSelector<string>
                                    config={{
                                    getItemId: (path) => path,
                                    getItemTitle: (path) => formatPathRelativeToHome(path, selectedMachine?.metadata?.homeDir),
                                    getItemSubtitle: undefined,
                                    getItemIcon: (path) => (
                                        <Ionicons
                                            name="folder-outline"
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    ),
                                    getRecentItemIcon: (path) => (
                                        <Ionicons
                                            name="time-outline"
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    ),
                                    getFavoriteItemIcon: (path) => (
                                        <Ionicons
                                            name={path === selectedMachine?.metadata?.homeDir ? "home-outline" : "star-outline"}
                                            size={24}
                                            color={theme.colors.textSecondary}
                                        />
                                    ),
                                    canRemoveFavorite: (path) => path !== selectedMachine?.metadata?.homeDir,
                                    formatForDisplay: (path) => formatPathRelativeToHome(path, selectedMachine?.metadata?.homeDir),
                                    parseFromDisplay: (text) => {
                                        if (selectedMachine?.metadata?.homeDir) {
                                            return resolveAbsolutePath(text, selectedMachine.metadata.homeDir);
                                        }
                                        return null;
                                    },
                                    filterItem: (path, searchText) => {
                                        const displayPath = formatPathRelativeToHome(path, selectedMachine?.metadata?.homeDir);
                                        return displayPath.toLowerCase().includes(searchText.toLowerCase());
                                    },
                                    searchPlaceholder: "Type to filter or enter custom directory...",
                                    recentSectionTitle: "Recent Directories",
                                    favoritesSectionTitle: "Favorite Directories",
                                    noItemsMessage: "No recent directories",
                                    showFavorites: true,
                                    showRecent: true,
                                    showSearch: true,
                                    allowCustomInput: true,
                                    compactItems: true,
                                }}
                                items={recentPaths}
                                recentItems={recentPaths}
                                favoriteItems={(() => {
                                    if (!selectedMachine?.metadata?.homeDir) return [];
                                    const homeDir = selectedMachine.metadata.homeDir;
                                    // Include home directory plus user favorites
                                    return [homeDir, ...favoriteDirectories.map(fav => resolveAbsolutePath(fav, homeDir))];
                                })()}
                                selectedItem={selectedPath}
                                onSelect={(path) => {
                                    setSelectedPath(path);
                                }}
                                onToggleFavorite={(path) => {
                                    const homeDir = selectedMachine?.metadata?.homeDir;
                                    if (!homeDir) return;

                                    // Don't allow removing home directory (handled by canRemoveFavorite)
                                    if (path === homeDir) return;

                                    // Convert to relative format for storage
                                    const relativePath = formatPathRelativeToHome(path, homeDir);

                                    // Check if already in favorites
                                    const isInFavorites = favoriteDirectories.some(fav =>
                                        resolveAbsolutePath(fav, homeDir) === path
                                    );

                                    if (isInFavorites) {
                                        // Remove from favorites
                                        setFavoriteDirectories(favoriteDirectories.filter(fav =>
                                            resolveAbsolutePath(fav, homeDir) !== path
                                        ));
                                    } else {
                                        // Add to favorites
                                        setFavoriteDirectories([...favoriteDirectories, relativePath]);
                                    }
                                }}
                                    context={{ homeDir: selectedMachine?.metadata?.homeDir }}
                                />
                            </View>

                            {/* Section 4: Permission Mode */}
                            <View ref={permissionSectionRef}>
                                <Text style={styles.sectionHeader}>4. Permission Mode</Text>
                            </View>
                            <ItemGroup title="">
                                {(agentType === 'codex'
                                    ? [
                                        { value: 'default' as PermissionMode, label: 'Default', description: 'Ask for permissions', icon: 'shield-outline' },
                                        { value: 'read-only' as PermissionMode, label: 'Read Only', description: 'Read-only mode', icon: 'eye-outline' },
                                        { value: 'safe-yolo' as PermissionMode, label: 'Safe YOLO', description: 'Workspace write with approval', icon: 'shield-checkmark-outline' },
                                        { value: 'yolo' as PermissionMode, label: 'YOLO', description: 'Full access, skip permissions', icon: 'flash-outline' },
                                    ]
                                    : [
                                        { value: 'default' as PermissionMode, label: 'Default', description: 'Ask for permissions', icon: 'shield-outline' },
                                        { value: 'acceptEdits' as PermissionMode, label: 'Accept Edits', description: 'Auto-approve edits', icon: 'checkmark-outline' },
                                        { value: 'plan' as PermissionMode, label: 'Plan', description: 'Plan before executing', icon: 'list-outline' },
                                        { value: 'bypassPermissions' as PermissionMode, label: 'Bypass Permissions', description: 'Skip all permissions', icon: 'flash-outline' },
                                    ]
                                ).map((option, index, array) => (
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
                                            borderRadius: Platform.select({ ios: 10, default: 16 }),
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
                    </View>
                </View>
                </ScrollView>

                {/* Section 5: AgentInput - Sticky at bottom */}
                <View style={{ paddingHorizontal: screenWidth > 700 ? 16 : 8, paddingBottom: Math.max(16, safeArea.bottom) }}>
                    <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
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
                            onAgentClick={handleAgentInputAgentClick}
                            permissionMode={permissionMode}
                            onPermissionModeChange={handleAgentInputPermissionChange}
                            modelMode={modelMode}
                            onModelModeChange={setModelMode}
                            connectionStatus={connectionStatus}
                            machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                            onMachineClick={handleAgentInputMachineClick}
                            currentPath={selectedPath}
                            onPathClick={handleAgentInputPathClick}
                            profileId={selectedProfileId}
                            onProfileClick={handleAgentInputProfileClick}
                        />
                    </View>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}

export default React.memo(NewSessionWizard);
