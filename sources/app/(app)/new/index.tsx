import React from 'react';
import { View, Text, Platform, Pressable, useWindowDimensions, ScrollView } from 'react-native';
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
import { SessionTypeSelector, SessionTypeSelectorRows } from '@/components/SessionTypeSelector';
import { createWorktree } from '@/utils/createWorktree';
import { getTempData, type NewSessionData } from '@/utils/tempDataStore';
import { linkTaskToSession } from '@/-zen/model/taskSessionLink';
import { PermissionMode, ModelMode, PermissionModeSelector } from '@/components/PermissionModeSelector';
import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES, getProfilePrimaryCli } from '@/sync/profileUtils';
import { AgentInput } from '@/components/AgentInput';
import { StyleSheet } from 'react-native-unistyles';
import { useCLIDetection } from '@/hooks/useCLIDetection';
import { useEnvironmentVariables, resolveEnvVarSubstitution, extractEnvVarReferences } from '@/hooks/useEnvironmentVariables';

import { isMachineOnline } from '@/utils/machineUtils';
import { StatusDot } from '@/components/StatusDot';
import { clearNewSessionDraft, loadNewSessionDraft, saveNewSessionDraft } from '@/sync/persistence';
import { MachineSelector } from '@/components/newSession/MachineSelector';
import { PathSelector } from '@/components/newSession/PathSelector';
import { SearchHeader } from '@/components/SearchHeader';
import { ProfileCompatibilityIcon } from '@/components/newSession/ProfileCompatibilityIcon';
import { EnvironmentVariablesPreviewModal } from '@/components/newSession/EnvironmentVariablesPreviewModal';
import { buildProfileGroups } from '@/sync/profileGrouping';
import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/profileMutations';

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
	        marginBottom: 16,
	    },
	    wizardSectionHeaderRow: {
	        flexDirection: 'row',
	        alignItems: 'center',
	        gap: 8,
	        marginBottom: 8,
	        marginTop: 12,
	        paddingHorizontal: 16,
	    },
		    sectionHeader: {
		        fontSize: 17,
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
	        paddingHorizontal: 16,
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
    const headerHeight = useHeaderHeight();
    const { prompt, dataId, machineId: machineIdParam, path: pathParam, profileId: profileIdParam } = useLocalSearchParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string;
        path?: string;
        profileId?: string;
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
    const useProfiles = useSetting('useProfiles');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');
    const experimentsEnabled = useSetting('experiments');
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [dismissedCLIWarnings, setDismissedCLIWarnings] = useSettingMutable('dismissedCLIWarnings');

    // Combined profiles (built-in + custom)
    const allProfiles = React.useMemo(() => {
        const builtInProfiles = DEFAULT_PROFILES.map(bp => getBuiltInProfile(bp.id)!);
        return [...builtInProfiles, ...profiles];
    }, [profiles]);

    const profileMap = useProfileMap(allProfiles);

    const {
        favoriteProfiles: favoriteProfileItems,
        customProfiles: nonFavoriteCustomProfiles,
        builtInProfiles: nonFavoriteBuiltInProfiles,
        favoriteIds: favoriteProfileIdSet,
    } = React.useMemo(() => {
        return buildProfileGroups({ customProfiles: profiles, favoriteProfileIds });
    }, [favoriteProfileIds, profiles]);

    const toggleFavoriteProfile = React.useCallback((profileId: string) => {
        if (favoriteProfileIdSet.has(profileId)) {
            setFavoriteProfileIds(favoriteProfileIds.filter((id) => id !== profileId));
        } else {
            setFavoriteProfileIds([profileId, ...favoriteProfileIds]);
        }
    }, [favoriteProfileIdSet, favoriteProfileIds, setFavoriteProfileIds]);
    const machines = useAllMachines();
    const sessions = useSessions();

    // Wizard state
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(() => {
        if (!useProfiles) {
            return null;
        }
        const draftProfileId = persistedDraft?.selectedProfileId;
        if (draftProfileId && profileMap.has(draftProfileId)) {
            return draftProfileId;
        }
        if (lastUsedProfile && profileMap.has(lastUsedProfile)) {
            return lastUsedProfile;
        }
        // Default to "no profile" so default session creation remains unchanged.
        return null;
    });

    React.useEffect(() => {
        if (!useProfiles && selectedProfileId !== null) {
            setSelectedProfileId(null);
        }
    }, [useProfiles, selectedProfileId]);
    const allowGemini = experimentsEnabled;

    const [agentType, setAgentType] = React.useState<'claude' | 'codex' | 'gemini'>(() => {
        // Check if agent type was provided in temp data
        if (tempSessionData?.agentType) {
            if (tempSessionData.agentType === 'gemini' && !allowGemini) {
                return 'claude';
            }
            return tempSessionData.agentType;
        }
        if (lastUsedAgent === 'claude' || lastUsedAgent === 'codex' || lastUsedAgent === 'gemini') {
            if (lastUsedAgent === 'gemini' && !allowGemini) {
                return 'claude';
            }
            return lastUsedAgent;
        }
        return 'claude';
    });

    // Agent cycling handler (for cycling through claude -> codex -> gemini)
    // Note: Does NOT persist immediately - persistence is handled by useEffect below
    const handleAgentCycle = React.useCallback(() => {
        setAgentType(prev => {
            // Cycle: claude -> codex -> (gemini?) -> claude
            if (prev === 'claude') return 'codex';
            if (prev === 'codex') return allowGemini ? 'gemini' : 'claude';
            return 'claude';
        });
    }, [allowGemini]);

    // Persist agent selection changes (separate from setState to avoid race condition)
    // This runs after agentType state is updated, ensuring the value is stable
    React.useEffect(() => {
        sync.applySettings({ lastUsedAgent: agentType });
    }, [agentType]);

    const [sessionType, setSessionType] = React.useState<'simple' | 'worktree'>('simple');
    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(() => {
        // Initialize with last used permission mode if valid, otherwise default to 'default'
        const validClaudeGeminiModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        const validCodexModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

        if (lastUsedPermissionMode) {
            if (agentType === 'codex' && validCodexModes.includes(lastUsedPermissionMode as PermissionMode)) {
                return lastUsedPermissionMode as PermissionMode;
            } else if ((agentType === 'claude' || agentType === 'gemini') && validClaudeGeminiModes.includes(lastUsedPermissionMode as PermissionMode)) {
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
        const validCodexModes: ModelMode[] = ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'default', 'gpt-5-minimal', 'gpt-5-low', 'gpt-5-medium', 'gpt-5-high'];
        const validGeminiModes: ModelMode[] = ['default'];

        if (persistedDraft?.modelMode) {
            const draftMode = persistedDraft.modelMode as ModelMode;
            if (agentType === 'codex' && validCodexModes.includes(draftMode)) {
                return draftMode;
            } else if (agentType === 'claude' && validClaudeModes.includes(draftMode)) {
                return draftMode;
            } else if (agentType === 'gemini' && validGeminiModes.includes(draftMode)) {
                return draftMode;
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

    const hasUserSelectedPermissionModeRef = React.useRef(false);
    const permissionModeRef = React.useRef(permissionMode);
    React.useEffect(() => {
        permissionModeRef.current = permissionMode;
    }, [permissionMode]);

    const applyPermissionMode = React.useCallback((mode: PermissionMode, source: 'user' | 'auto') => {
        setPermissionMode(mode);
        sync.applySettings({ lastUsedPermissionMode: mode });
        if (source === 'user') {
            hasUserSelectedPermissionModeRef.current = true;
        }
    }, []);

    const handlePermissionModeChange = React.useCallback((mode: PermissionMode) => {
        applyPermissionMode(mode, 'user');
    }, [applyPermissionMode]);

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

    // Ensure a machine is pre-selected once machines have loaded (wizard expects this).
    React.useEffect(() => {
        if (selectedMachineId !== null) {
            return;
        }
        if (machines.length === 0) {
            return;
        }

        let machineIdToUse: string | null = null;
        if (recentMachinePaths.length > 0) {
            for (const recent of recentMachinePaths) {
                if (machines.find(m => m.id === recent.machineId)) {
                    machineIdToUse = recent.machineId;
                    break;
                }
            }
        }
        if (!machineIdToUse) {
            machineIdToUse = machines[0].id;
        }

        setSelectedMachineId(machineIdToUse);
        setSelectedPath(getRecentPathForMachine(machineIdToUse, recentMachinePaths));
    }, [machines, recentMachinePaths, selectedMachineId]);

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

    // Helper to check if profile is available (CLI detected + experiments gating)
    const isProfileAvailable = React.useCallback((profile: AIBackendProfile): { available: boolean; reason?: string } => {
        const supportedCLIs = (Object.entries(profile.compatibility) as [string, boolean][])
            .filter(([, supported]) => supported)
            .map(([agent]) => agent as 'claude' | 'codex' | 'gemini');

        const allowedCLIs = supportedCLIs.filter((cli) => cli !== 'gemini' || experimentsEnabled);

        if (allowedCLIs.length === 0) {
            return {
                available: false,
                reason: 'no-supported-cli',
            };
        }

        // If a profile requires exactly one CLI, enforce that one.
        if (allowedCLIs.length === 1) {
            const requiredCLI = allowedCLIs[0];
            if (cliAvailability[requiredCLI] === false) {
                return {
                    available: false,
                    reason: `cli-not-detected:${requiredCLI}`,
                };
            }
            return { available: true };
        }

        // Multi-CLI profiles: available if *any* supported CLI is available (or detection not finished).
        const anyAvailable = allowedCLIs.some((cli) => cliAvailability[cli] !== false);
        if (!anyAvailable) {
            return {
                available: false,
                reason: 'cli-not-detected:any',
            };
        }
        return { available: true };
    }, [cliAvailability, experimentsEnabled]);

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

    const openProfileEdit = React.useCallback((profile: AIBackendProfile) => {
        // Persist wizard state before navigating so selection doesn't reset on return.
        saveNewSessionDraft({
            input: sessionPrompt,
            selectedMachineId,
            selectedPath,
            selectedProfileId: useProfiles ? selectedProfileId : null,
            agentType,
            permissionMode,
            modelMode,
            sessionType,
            updatedAt: Date.now(),
        });

        const profileData = JSON.stringify(profile);
        const base = `/new/pick/profile-edit?profileData=${encodeURIComponent(profileData)}`;
        router.push(selectedMachineId ? `${base}&machineId=${encodeURIComponent(selectedMachineId)}` as any : base as any);
    }, [agentType, modelMode, permissionMode, router, selectedMachineId, selectedPath, selectedProfileId, sessionPrompt, sessionType, useProfiles]);

    const handleAddProfile = React.useCallback(() => {
        openProfileEdit(createEmptyCustomProfile());
    }, [openProfileEdit]);

    const handleDuplicateProfile = React.useCallback((profile: AIBackendProfile) => {
        openProfileEdit(duplicateProfileForEdit(profile));
    }, [openProfileEdit]);

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
                        setProfiles(updatedProfiles);
                        if (selectedProfileId === profile.id) {
                            setSelectedProfileId(null);
                        }
                    },
                },
            ],
        );
    }, [profiles, selectedProfileId, setProfiles]);

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

    const favoriteMachineItems = React.useMemo(() => {
        return machines.filter(m => favoriteMachines.includes(m.id));
    }, [machines, favoriteMachines]);

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
        return selectedMachineId !== null && selectedPath.trim() !== '';
    }, [selectedMachineId, selectedPath]);

    const selectProfile = React.useCallback((profileId: string) => {
        const prevSelectedProfileId = selectedProfileId;
        setSelectedProfileId(profileId);
        // Check both custom profiles and built-in profiles
        const profile = profileMap.get(profileId) || getBuiltInProfile(profileId);
        if (profile) {
            const supportedAgents = (Object.entries(profile.compatibility) as Array<[string, boolean]>)
                .filter(([, supported]) => supported)
                .map(([agent]) => agent as 'claude' | 'codex' | 'gemini')
                .filter((agent) => agent !== 'gemini' || allowGemini);

            if (supportedAgents.length > 0 && !supportedAgents.includes(agentType)) {
                setAgentType(supportedAgents[0] ?? 'claude');
            }

            // Set session type from profile's default
            if (profile.defaultSessionType) {
                setSessionType(profile.defaultSessionType);
            }

            // Apply permission defaults only on first selection (or if the user hasn't explicitly chosen one).
            // Switching between profiles should not reset permissions when the backend stays the same.
            if (!hasUserSelectedPermissionModeRef.current && profile.defaultPermissionMode) {
                const nextMode = profile.defaultPermissionMode as PermissionMode;
                // If the user is switching profiles (not initial selection), keep their current permissionMode.
                const isInitialProfileSelection = prevSelectedProfileId === null;
                if (isInitialProfileSelection) {
                    applyPermissionMode(nextMode, 'auto');
                }
            }
        }
    }, [agentType, allowGemini, applyPermissionMode, profileMap, selectedProfileId]);

    // Handle profile route param from picker screens
    React.useEffect(() => {
        if (!useProfiles) {
            return;
        }

        const nextProfileIdFromParams = Array.isArray(profileIdParam) ? profileIdParam[0] : profileIdParam;
        if (typeof nextProfileIdFromParams !== 'string') {
            return;
        }
        if (nextProfileIdFromParams === '') {
            if (selectedProfileId !== null) {
                setSelectedProfileId(null);
            }
            return;
        }
        if (nextProfileIdFromParams !== selectedProfileId) {
            selectProfile(nextProfileIdFromParams);
        }
    }, [profileIdParam, selectedProfileId, selectProfile, useProfiles]);

    // Keep agentType compatible with the currently selected profile.
    React.useEffect(() => {
        if (!useProfiles || selectedProfileId === null) {
            return;
        }

        const profile = profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId);
        if (!profile) {
            return;
        }

        const supportedAgents = (Object.entries(profile.compatibility) as Array<[string, boolean]>)
            .filter(([, supported]) => supported)
            .map(([agent]) => agent as 'claude' | 'codex' | 'gemini')
            .filter((agent) => agent !== 'gemini' || allowGemini);

        if (supportedAgents.length > 0 && !supportedAgents.includes(agentType)) {
            setAgentType(supportedAgents[0] ?? 'claude');
        }
    }, [agentType, allowGemini, profileMap, selectedProfileId, useProfiles]);

    const prevAgentTypeRef = React.useRef(agentType);

    const mapPermissionModeAcrossAgents = React.useCallback((mode: PermissionMode, from: 'claude' | 'codex' | 'gemini', to: 'claude' | 'codex' | 'gemini'): PermissionMode => {
        if (from === to) return mode;

        const toCodex = to === 'codex';
        if (toCodex) {
            // Claude/Gemini -> Codex
            switch (mode) {
                case 'bypassPermissions':
                    return 'yolo';
                case 'plan':
                    return 'safe-yolo';
                case 'acceptEdits':
                    return 'safe-yolo';
                case 'default':
                    return 'default';
                default:
                    return 'default';
            }
        }

        // Codex -> Claude/Gemini
        switch (mode) {
            case 'yolo':
                return 'bypassPermissions';
            case 'safe-yolo':
                return 'plan';
            case 'read-only':
                return 'default';
            case 'default':
                return 'default';
            default:
                return 'default';
        }
    }, []);

    // When agent type changes, keep the "permission level" consistent by mapping modes across backends.
    React.useEffect(() => {
        const prev = prevAgentTypeRef.current;
        if (prev === agentType) {
            return;
        }
        prevAgentTypeRef.current = agentType;

        const current = permissionModeRef.current;
        const validClaudeModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        const validCodexModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

        const isValidForNewAgent = agentType === 'codex'
            ? validCodexModes.includes(current)
            : validClaudeModes.includes(current);

        if (isValidForNewAgent) {
            return;
        }

        const mapped = mapPermissionModeAcrossAgents(current, prev, agentType);
        applyPermissionMode(mapped, 'auto');
    }, [agentType, applyPermissionMode, mapPermissionModeAcrossAgents]);

    // Scroll to section helpers - for AgentInput button clicks
    const wizardSectionOffsets = React.useRef<{ profile?: number; agent?: number; machine?: number; path?: number; permission?: number; sessionType?: number }>({});
    const registerWizardSectionOffset = React.useCallback((key: keyof typeof wizardSectionOffsets.current) => {
        return (e: any) => {
            wizardSectionOffsets.current[key] = e?.nativeEvent?.layout?.y ?? 0;
        };
    }, []);
    const scrollToWizardSection = React.useCallback((key: keyof typeof wizardSectionOffsets.current) => {
        const y = wizardSectionOffsets.current[key];
        if (typeof y !== 'number' || !scrollViewRef.current) return;
        scrollViewRef.current.scrollTo({ y: Math.max(0, y - 20), animated: true });
    }, []);

    const handleAgentInputProfileClick = React.useCallback(() => {
        scrollToWizardSection('profile');
    }, [scrollToWizardSection]);

    const handleAgentInputMachineClick = React.useCallback(() => {
        scrollToWizardSection('machine');
    }, [scrollToWizardSection]);

    const handleAgentInputPathClick = React.useCallback(() => {
        scrollToWizardSection('path');
    }, [scrollToWizardSection]);

    const handleAgentInputPermissionClick = React.useCallback(() => {
        scrollToWizardSection('permission');
    }, [scrollToWizardSection]);

    const handleAgentInputAgentClick = React.useCallback(() => {
        scrollToWizardSection('agent');
    }, [scrollToWizardSection]);

    const ignoreProfileRowPressRef = React.useRef(false);

    const openProfileEnvVarsPreview = React.useCallback((profile: AIBackendProfile) => {
        Modal.show({
            component: EnvironmentVariablesPreviewModal,
            props: {
                environmentVariables: getProfileEnvironmentVariables(profile),
                machineId: selectedMachineId,
                machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
                profileName: profile.name,
            },
        } as any);
    }, [selectedMachine, selectedMachineId]);

    const renderProfileLeftElement = React.useCallback((profile: AIBackendProfile) => {
        return <ProfileCompatibilityIcon profile={profile} />;
    }, []);

    const renderProfileRightElement = React.useCallback((profile: AIBackendProfile, isSelected: boolean, isFavorite: boolean) => {
        const envVarCount = Object.keys(getProfileEnvironmentVariables(profile)).length;
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                        name="checkmark-circle"
                        size={24}
                        color={theme.colors.button.primary.background}
                        style={{ opacity: isSelected ? 1 : 0 }}
                    />
                </View>
                <Pressable
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPressIn={() => {
                        ignoreProfileRowPressRef.current = true;
                    }}
                    onPress={(e) => {
                        e.stopPropagation();
                        toggleFavoriteProfile(profile.id);
                    }}
                >
                    <Ionicons
                        name={isFavorite ? 'star' : 'star-outline'}
                        size={24}
                        color={isFavorite ? theme.colors.button.primary.background : theme.colors.textSecondary}
                    />
                </Pressable>
                {envVarCount > 0 && (
                    <Pressable
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        onPressIn={() => {
                            ignoreProfileRowPressRef.current = true;
                        }}
                        onPress={(e) => {
                            e.stopPropagation();
                            openProfileEnvVarsPreview(profile);
                        }}
                    >
                        <Ionicons name="list-outline" size={22} color={theme.colors.button.secondary.tint} />
                    </Pressable>
                )}
                <Pressable
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPressIn={() => {
                        ignoreProfileRowPressRef.current = true;
                    }}
                    onPress={(e) => {
                        e.stopPropagation();
                        openProfileEdit(profile);
                    }}
                >
                    <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                </Pressable>
                <Pressable
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPressIn={() => {
                        ignoreProfileRowPressRef.current = true;
                    }}
                    onPress={(e) => {
                        e.stopPropagation();
                        handleDuplicateProfile(profile);
                    }}
                >
                    <Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
                </Pressable>
                {!profile.isBuiltIn && (
                    <Pressable
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        onPressIn={() => {
                            ignoreProfileRowPressRef.current = true;
                        }}
                        onPress={(e) => {
                            e.stopPropagation();
                            handleDeleteProfile(profile);
                        }}
                    >
                        <Ionicons name="trash-outline" size={20} color={theme.colors.deleteAction} />
                    </Pressable>
                )}
            </View>
        );
    }, [
        handleDeleteProfile,
        handleDuplicateProfile,
        openProfileEnvVarsPreview,
        openProfileEdit,
        theme.colors.button.primary.background,
        theme.colors.button.secondary.tint,
        theme.colors.deleteAction,
        theme.colors.textSecondary,
        toggleFavoriteProfile,
    ]);

    // Helper to get meaningful subtitle text for profiles
    const getProfileSubtitle = React.useCallback((profile: AIBackendProfile): string => {
        const parts: string[] = [];
        const availability = isProfileAvailable(profile);

        if (profile.isBuiltIn) {
            parts.push('Built-in');
        }

        if (profile.compatibility.claude && profile.compatibility.codex) {
            parts.push('Claude & Codex');
        } else if (profile.compatibility.claude) {
            parts.push('Claude');
        } else if (profile.compatibility.codex) {
            parts.push('Codex');
        }

        if (!availability.available && availability.reason) {
            if (availability.reason.startsWith('requires-agent:')) {
                const required = availability.reason.split(':')[1];
                parts.push(`Requires ${required}`);
            } else if (availability.reason.startsWith('cli-not-detected:')) {
                const cli = availability.reason.split(':')[1];
                parts.push(`${cli} CLI not detected`);
            }
        }

        return parts.join(' · ');
    }, [isProfileAvailable]);

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
            // Only auto-select newly created profiles (Add / Duplicate / Save As).
            // Edits to other profiles should not change the current selection.
            const wasExisting = profiles.some(p => p.id === savedProfile.id);
            if (!wasExisting) {
                setSelectedProfileId(savedProfile.id);
            }
        };
        onProfileSaved = handler;
        return () => {
            onProfileSaved = () => { };
        };
    }, [profiles]);

    const handleMachineClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/machine',
            params: selectedMachineId ? { selectedId: selectedMachineId } : {},
        });
    }, [router, selectedMachineId]);

    const handleProfileClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/profile',
            params: {
                ...(selectedProfileId ? { selectedId: selectedProfileId } : {}),
                ...(selectedMachineId ? { machineId: selectedMachineId } : {}),
            },
        });
    }, [router, selectedMachineId, selectedProfileId]);

    const handleAgentClick = React.useCallback(() => {
        if (useProfiles && selectedProfileId !== null) {
            const profile = profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId);
            const supportedAgents = profile
                ? (Object.entries(profile.compatibility) as Array<[string, boolean]>)
                    .filter(([, supported]) => supported)
                    .map(([agent]) => agent as 'claude' | 'codex' | 'gemini')
                    .filter((agent) => agent !== 'gemini' || allowGemini)
                : [];

            if (supportedAgents.length <= 1) {
                Modal.alert(
                    'AI Backend',
                    'AI backend is selected by your profile. To change it, select a different profile.',
                    [
                        { text: t('common.ok'), style: 'cancel' },
                        { text: 'Change Profile', onPress: handleProfileClick },
                    ],
                );
                return;
            }

            const currentIndex = supportedAgents.indexOf(agentType);
            const nextIndex = (currentIndex + 1) % supportedAgents.length;
            setAgentType(supportedAgents[nextIndex] ?? supportedAgents[0] ?? 'claude');
            return;
        }

        handleAgentCycle();
    }, [agentType, allowGemini, handleAgentCycle, handleProfileClick, profileMap, selectedProfileId, setAgentType, useProfiles]);

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

    const selectedProfileForEnvVars = React.useMemo(() => {
        if (!useProfiles || !selectedProfileId) return null;
        return profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId) || null;
    }, [profileMap, selectedProfileId, useProfiles]);

    const selectedProfileEnvVars = React.useMemo(() => {
        if (!selectedProfileForEnvVars) return {};
        return transformProfileToEnvironmentVars(selectedProfileForEnvVars, agentType) ?? {};
    }, [agentType, selectedProfileForEnvVars]);

    const selectedProfileEnvVarsCount = React.useMemo(() => {
        return Object.keys(selectedProfileEnvVars).length;
    }, [selectedProfileEnvVars]);

    const handleEnvVarsClick = React.useCallback(() => {
        if (!selectedProfileForEnvVars) return;
        Modal.show({
            component: EnvironmentVariablesPreviewModal,
            props: {
                environmentVariables: selectedProfileEnvVars,
                machineId: selectedMachineId,
                machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
                profileName: selectedProfileForEnvVars.name,
            },
        } as any);
    }, [selectedMachine, selectedMachineId, selectedProfileEnvVars, selectedProfileForEnvVars]);

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
            const profilesActive = useProfiles;

            // Keep prod session creation behavior unchanged:
            // only persist/apply profiles & model when an explicit opt-in flag is enabled.
            const settingsUpdate: Parameters<typeof sync.applySettings>[0] = {
                recentMachinePaths: updatedPaths,
                lastUsedAgent: agentType,
                lastUsedPermissionMode: permissionMode,
            };
            if (profilesActive) {
                settingsUpdate.lastUsedProfile = selectedProfileId;
            }
            sync.applySettings(settingsUpdate);

            // Get environment variables from selected profile
            let environmentVariables = undefined;
            if (profilesActive && selectedProfileId) {
                const selectedProfile = profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId);
                if (selectedProfile) {
                    environmentVariables = transformProfileToEnvironmentVars(selectedProfile, agentType);
                }
            }

            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: actualPath,
                approvedNewDirectoryCreation: true,
                agent: agentType,
                profileId: profilesActive ? (selectedProfileId ?? '') : undefined,
                environmentVariables
            });

            if ('sessionId' in result && result.sessionId) {
                // Clear draft state on successful session creation
                clearNewSessionDraft();

                await sync.refreshSessions();

                // Set permission mode on the session
                storage.getState().updateSessionPermissionMode(result.sessionId, permissionMode);

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
    }, [selectedMachineId, selectedPath, sessionPrompt, sessionType, experimentsEnabled, agentType, selectedProfileId, permissionMode, modelMode, recentMachinePaths, profileMap, router, useEnhancedSessionWizard]);

    const screenWidth = useWindowDimensions().width;
    const showInlineClose = screenWidth < 520;

    const handleCloseModal = React.useCallback(() => {
        // On web (especially mobile), `router.back()` can be a no-op if the modal is the first history entry.
        // Fall back to home so the user always has an exit.
        if (Platform.OS === 'web') {
            if (typeof window !== 'undefined' && window.history.length > 1) {
                router.back();
            } else {
                router.replace('/');
            }
            return;
        }

        router.back();
    }, [router]);

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

    const persistDraftNow = React.useCallback(() => {
        saveNewSessionDraft({
            input: sessionPrompt,
            selectedMachineId,
            selectedPath,
            selectedProfileId: useProfiles ? selectedProfileId : null,
            agentType,
            permissionMode,
            modelMode,
            sessionType,
            updatedAt: Date.now(),
        });
    }, [agentType, modelMode, permissionMode, selectedMachineId, selectedPath, selectedProfileId, sessionPrompt, sessionType, useProfiles]);

    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        if (draftSaveTimerRef.current) {
            clearTimeout(draftSaveTimerRef.current);
        }
        draftSaveTimerRef.current = setTimeout(() => {
            persistDraftNow();
        }, 250);
        return () => {
            if (draftSaveTimerRef.current) {
                clearTimeout(draftSaveTimerRef.current);
            }
        };
    }, [persistDraftNow]);

    // ========================================================================
    // CONTROL A: Simpler AgentInput-driven layout (flag OFF)
    // Shows machine/path selection via chips that navigate to picker screens
    // ========================================================================
    if (!useEnhancedSessionWizard) {
        return (
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight + safeArea.bottom + 16 : 0}
                style={styles.container}
            >
                {showInlineClose && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        onPress={handleCloseModal}
                        hitSlop={12}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            right: 8,
                            zIndex: 1000,
                            backgroundColor: 'transparent',
                            borderWidth: 0,
                            padding: 0,
                            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
                        }}
                    >
                        <Ionicons name="close" size={24} color={theme.colors.header.tint} />
                    </Pressable>
                )}
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
                                placeholder={t('session.inputPlaceholder')}
                                autocompletePrefixes={[]}
                                autocompleteSuggestions={async () => []}
                                agentType={agentType}
                                onAgentClick={handleAgentClick}
                                permissionMode={permissionMode}
                                onPermissionModeChange={handlePermissionModeChange}
                                connectionStatus={connectionStatus}
                                machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                                onMachineClick={handleMachineClick}
                                currentPath={selectedPath}
                                onPathClick={handlePathClick}
                                {...(useProfiles ? {
                                    profileId: selectedProfileId,
                                    onProfileClick: handleProfileClick,
                                    envVarsCount: selectedProfileEnvVarsCount || undefined,
                                    onEnvVarsClick: selectedProfileEnvVarsCount > 0 ? handleEnvVarsClick : undefined,
                                } : {})}
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
            keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight + safeArea.bottom + 16 : 0}
            style={styles.container}
        >
                {showInlineClose && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        onPress={handleCloseModal}
                        hitSlop={12}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                        right: 8,
                        zIndex: 1000,
                        backgroundColor: 'transparent',
                        borderWidth: 0,
                        padding: 0,
                        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
                    }}
                >
                    <Ionicons name="close" size={24} color={theme.colors.header.tint} />
                </Pressable>
            )}
            <View style={{ flex: 1 }}>
                <ScrollView
                    ref={scrollViewRef}
                    style={styles.scrollContainer}
                    contentContainerStyle={styles.contentContainer}
                    keyboardShouldPersistTaps="handled"
                >
	                <View style={{ paddingHorizontal: 0 }}>
                    <View style={[
                        { maxWidth: layout.maxWidth, flex: 1, width: '100%', alignSelf: 'center' }
                    ]}>
                        <View ref={profileSectionRef} onLayout={registerWizardSectionOffset('profile')} style={styles.wizardContainer}>
                            {/* CLI Detection Status Banner - shows after detection completes */}
                            {selectedMachineId && cliAvailability.timestamp > 0 && selectedMachine && connectionStatus && (
                                <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
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
                                </View>
                            )}

                            {useProfiles && (
                                <>
                                    <View style={styles.wizardSectionHeaderRow}>
                                        <Ionicons name="person-outline" size={18} color={theme.colors.text} />
                                        <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>
                                            Select AI Profile
                                        </Text>
                                    </View>
                                    <Text style={styles.sectionDescription}>
                                        Select a profile to apply environment variables and defaults to your session.
                                    </Text>

                                    {favoriteProfileItems.length > 0 && (
                                        <ItemGroup title="Favorites">
                                            {favoriteProfileItems.map((profile, index) => {
                                                const availability = isProfileAvailable(profile);
                                                const isSelected = selectedProfileId === profile.id;
                                                const isLast = index === favoriteProfileItems.length - 1;
                                                return (
                                                    <Item
                                                        key={profile.id}
                                                        title={profile.name}
                                                        subtitle={getProfileSubtitle(profile)}
                                                        leftElement={renderProfileLeftElement(profile)}
                                                        showChevron={false}
                                                        selected={isSelected}
                                                        pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                                        disabled={!availability.available}
                                                        onPress={() => {
                                                            if (!availability.available) return;
                                                            if (ignoreProfileRowPressRef.current) {
                                                                ignoreProfileRowPressRef.current = false;
                                                                return;
                                                            }
                                                            selectProfile(profile.id);
                                                        }}
                                                        rightElement={renderProfileRightElement(profile, isSelected, true)}
                                                        showDivider={!isLast}
                                                    />
                                                );
                                            })}
                                        </ItemGroup>
                                    )}

                                    {nonFavoriteCustomProfiles.length > 0 && (
                                        <ItemGroup title="Your Profiles">
                                            {nonFavoriteCustomProfiles.map((profile, index) => {
                                                const availability = isProfileAvailable(profile);
                                                const isSelected = selectedProfileId === profile.id;
                                                const isLast = index === nonFavoriteCustomProfiles.length - 1;
                                                const isFavorite = favoriteProfileIdSet.has(profile.id);
                                                return (
                                                    <Item
                                                        key={profile.id}
                                                        title={profile.name}
                                                        subtitle={getProfileSubtitle(profile)}
                                                        leftElement={renderProfileLeftElement(profile)}
                                                        showChevron={false}
                                                        selected={isSelected}
                                                        pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                                        disabled={!availability.available}
                                                        onPress={() => {
                                                            if (!availability.available) return;
                                                            if (ignoreProfileRowPressRef.current) {
                                                                ignoreProfileRowPressRef.current = false;
                                                                return;
                                                            }
                                                            selectProfile(profile.id);
                                                        }}
                                                        rightElement={renderProfileRightElement(profile, isSelected, isFavorite)}
                                                        showDivider={!isLast}
                                                    />
                                                );
                                            })}
                                        </ItemGroup>
                                    )}

                                    <ItemGroup title="Built-in Profiles">
                                        <Item
                                            title={t('profiles.noProfile')}
                                            subtitle={t('profiles.noProfileDescription')}
                                            leftElement={<Ionicons name="home-outline" size={29} color={theme.colors.textSecondary} />}
                                            showChevron={false}
                                            selected={!selectedProfileId}
                                            onPress={() => setSelectedProfileId(null)}
                                            pressableStyle={!selectedProfileId ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                            rightElement={!selectedProfileId
                                                ? (
                                                    <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                                                        <Ionicons
                                                            name="checkmark-circle"
                                                            size={24}
                                                            color={theme.colors.button.primary.background}
                                                        />
                                                    </View>
                                                )
                                                : null}
                                            showDivider={nonFavoriteBuiltInProfiles.length > 0}
                                        />
                                        {nonFavoriteBuiltInProfiles.map((profile, index) => {
                                            const availability = isProfileAvailable(profile);
                                            const isSelected = selectedProfileId === profile.id;
                                            const isLast = index === nonFavoriteBuiltInProfiles.length - 1;
                                            const isFavorite = favoriteProfileIdSet.has(profile.id);
                                            return (
                                                <Item
                                                    key={profile.id}
                                                    title={profile.name}
                                                    subtitle={getProfileSubtitle(profile)}
                                                    leftElement={renderProfileLeftElement(profile)}
                                                    showChevron={false}
                                                    selected={isSelected}
                                                    pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                                    disabled={!availability.available}
                                                    onPress={() => {
                                                        if (!availability.available) return;
                                                        if (ignoreProfileRowPressRef.current) {
                                                            ignoreProfileRowPressRef.current = false;
                                                            return;
                                                        }
                                                        selectProfile(profile.id);
                                                    }}
                                                    rightElement={renderProfileRightElement(profile, isSelected, isFavorite)}
                                                    showDivider={!isLast}
                                                />
                                            );
                                        })}
                                    </ItemGroup>
                                    <ItemGroup title="">
                                        <Item
                                            title={t('profiles.addProfile')}
                                            subtitle={t('profiles.subtitle')}
                                            leftElement={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                                            onPress={handleAddProfile}
                                            showChevron={false}
                                            showDivider={false}
                                        />
                                    </ItemGroup>

                                    <View style={{ height: 24 }} />
                                </>
                            )}

                            {/* Section: AI Backend */}
                            <View onLayout={registerWizardSectionOffset('agent')}>
                                <View style={styles.wizardSectionHeaderRow}>
                                    <Ionicons name="hardware-chip-outline" size={18} color={theme.colors.text} />
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>
                                        Select AI Backend
                                    </Text>
                                </View>
                            </View>
                            <Text style={styles.sectionDescription}>
                                {useProfiles && selectedProfileId
                                    ? 'Limited by your selected profile and available CLIs on this machine.'
                                    : 'Select which AI runs your session.'}
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

                            {selectedMachineId && cliAvailability.gemini === false && allowGemini && !isWarningDismissed('gemini') && !hiddenBanners.gemini && (
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

                            <ItemGroup title={<View />} headerStyle={{ paddingTop: 0, paddingBottom: 0 }}>
                                {(() => {
                                    const selectedProfile = useProfiles && selectedProfileId
                                        ? (profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId))
                                        : null;

                                    const options: Array<{
                                        key: 'claude' | 'codex' | 'gemini';
                                        title: string;
                                        subtitle: string;
                                        icon: React.ComponentProps<typeof Ionicons>['name'];
                                    }> = [
                                        { key: 'claude', title: 'Claude', subtitle: 'Claude CLI', icon: 'sparkles-outline' },
                                        { key: 'codex', title: 'Codex', subtitle: 'Codex CLI', icon: 'terminal-outline' },
                                        ...(allowGemini ? [{ key: 'gemini' as const, title: 'Gemini', subtitle: 'Gemini CLI', icon: 'planet-outline' as const }] : []),
                                    ];

                                    return options.map((option, index) => {
                                        const compatible = !selectedProfile || !!selectedProfile.compatibility?.[option.key];
                                        const cliOk = cliAvailability[option.key] !== false;
                                        const disabledReason = !compatible
                                            ? 'Not compatible with the selected profile.'
                                            : !cliOk
                                                ? `${option.title} CLI not detected on this machine.`
                                                : null;

                                        const isSelected = agentType === option.key;

                                        return (
                                            <Item
                                                key={option.key}
                                                title={option.title}
                                                subtitle={disabledReason ?? option.subtitle}
                                                leftElement={<Ionicons name={option.icon} size={24} color={theme.colors.textSecondary} />}
                                                selected={isSelected}
                                                disabled={!!disabledReason}
                                                pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                                onPress={() => {
                                                    if (disabledReason) {
                                                        Modal.alert(
                                                            'AI Backend',
                                                            disabledReason,
                                                            compatible
                                                                ? [{ text: t('common.ok'), style: 'cancel' }]
                                                                : [
                                                                    { text: t('common.ok'), style: 'cancel' },
                                                                    ...(useProfiles && selectedProfileId ? [{ text: 'Change Profile', onPress: handleAgentInputProfileClick }] : []),
                                                                ],
                                                        );
                                                        return;
                                                    }
                                                    setAgentType(option.key);
                                                }}
                                                rightElement={(
                                                    <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                                                        <Ionicons
                                                            name="checkmark-circle"
                                                            size={24}
                                                            color={theme.colors.button.primary.background}
                                                            style={{ opacity: isSelected ? 1 : 0 }}
                                                        />
                                                    </View>
                                                )}
                                                showChevron={false}
                                                showDivider={index < options.length - 1}
                                            />
                                        );
                                    });
                                })()}
                            </ItemGroup>

                            <View style={{ height: 24 }} />

                            {/* Section 2: Machine Selection */}
                            <View ref={machineSectionRef} onLayout={registerWizardSectionOffset('machine')}>
                                <View style={styles.wizardSectionHeaderRow}>
                                    <Ionicons name="desktop-outline" size={18} color={theme.colors.text} />
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>Select Machine</Text>
                                </View>
                            </View>

                            <View style={{ marginBottom: 24 }}>
                                <MachineSelector
                                    machines={machines}
                                    selectedMachine={selectedMachine || null}
                                    recentMachines={recentMachines}
                                    favoriteMachines={favoriteMachineItems}
                                    showFavorites={true}
                                    showSearch={useMachinePickerSearch}
                                    searchPlacement="all"
                                    searchPlaceholder="Search machines..."
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
                            <View ref={pathSectionRef} onLayout={registerWizardSectionOffset('path')}>
                                <View style={styles.wizardSectionHeaderRow}>
                                    <Ionicons name="folder-outline" size={18} color={theme.colors.text} />
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>Select Working Directory</Text>
                                </View>
                            </View>

                            <View style={{ marginBottom: 24 }}>
                                    <PathSelector
                                        machineHomeDir={selectedMachine?.metadata?.homeDir || '/home'}
                                        selectedPath={selectedPath}
                                        onChangeSelectedPath={setSelectedPath}
                                        recentPaths={recentPaths}
                                        usePickerSearch={usePathPickerSearch}
                                        searchVariant="group"
                                        favoriteDirectories={favoriteDirectories}
                                        onChangeFavoriteDirectories={setFavoriteDirectories}
                                    />
                            </View>

                            {/* Section 4: Permission Mode */}
	                            <View ref={permissionSectionRef} onLayout={registerWizardSectionOffset('permission')}>
		                                <View style={styles.wizardSectionHeaderRow}>
		                                    <Ionicons name="shield-outline" size={18} color={theme.colors.text} />
		                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>Select Permission Mode</Text>
		                                </View>
		                            </View>
		                            <ItemGroup title="">
		                                {(agentType === 'codex'
		                                    ? [
		                                        { value: 'default' as PermissionMode, label: t('agentInput.codexPermissionMode.default'), description: 'Use CLI permission settings', icon: 'shield-outline' },
		                                        { value: 'read-only' as PermissionMode, label: t('agentInput.codexPermissionMode.readOnly'), description: 'Read-only mode', icon: 'eye-outline' },
		                                        { value: 'safe-yolo' as PermissionMode, label: t('agentInput.codexPermissionMode.safeYolo'), description: 'Workspace write with approval', icon: 'shield-checkmark-outline' },
		                                        { value: 'yolo' as PermissionMode, label: t('agentInput.codexPermissionMode.yolo'), description: 'Full access, skip permissions', icon: 'flash-outline' },
		                                    ]
		                                    : [
		                                        { value: 'default' as PermissionMode, label: t(agentType === 'gemini' ? 'agentInput.geminiPermissionMode.default' : 'agentInput.permissionMode.default'), description: 'Ask for permissions', icon: 'shield-outline' },
		                                        { value: 'acceptEdits' as PermissionMode, label: t(agentType === 'gemini' ? 'agentInput.geminiPermissionMode.acceptEdits' : 'agentInput.permissionMode.acceptEdits'), description: 'Auto-approve edits', icon: 'checkmark-outline' },
		                                        { value: 'plan' as PermissionMode, label: t(agentType === 'gemini' ? 'agentInput.geminiPermissionMode.plan' : 'agentInput.permissionMode.plan'), description: 'Plan before executing', icon: 'list-outline' },
		                                        { value: 'bypassPermissions' as PermissionMode, label: t(agentType === 'gemini' ? 'agentInput.geminiPermissionMode.bypassPermissions' : 'agentInput.permissionMode.bypassPermissions'), description: 'Skip all permissions', icon: 'flash-outline' },
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
                                                color={theme.colors.textSecondary}
                                            />
                                        }
                                        rightElement={permissionMode === option.value ? (
                                            <Ionicons
                                                name="checkmark-circle"
                                                size={24}
                                                color={theme.colors.button.primary.background}
                                            />
	                                        ) : null}
	                                        onPress={() => handlePermissionModeChange(option.value)}
	                                        showChevron={false}
	                                        selected={permissionMode === option.value}
	                                        pressableStyle={permissionMode === option.value ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
	                                        showDivider={index < array.length - 1}
	                                    />
	                                ))}
	                            </ItemGroup>

	                            <View style={{ height: 24 }} />

	                            {/* Section 5: Session Type */}
	                            <View onLayout={registerWizardSectionOffset('sessionType')}>
	                                <View style={styles.wizardSectionHeaderRow}>
	                                    <Ionicons name="layers-outline" size={18} color={theme.colors.text} />
	                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>Select Session Type</Text>
	                                </View>
	                            </View>

	                            <View style={{ marginBottom: 0 }}>
	                                <ItemGroup title={<View />} headerStyle={{ paddingTop: 0, paddingBottom: 0 }}>
	                                    <SessionTypeSelectorRows value={sessionType} onChange={setSessionType} />
	                                </ItemGroup>
	                            </View>
	                        </View>
                    </View>
                </View>
                </ScrollView>

                {/* AgentInput - Sticky at bottom */}
                <View style={{ paddingHorizontal: screenWidth > 700 ? 16 : 8, paddingBottom: Math.max(16, safeArea.bottom) }}>
                    <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                            <AgentInput
                                value={sessionPrompt}
                                onChangeText={setSessionPrompt}
                                onSend={handleCreateSession}
                                isSendDisabled={!canCreate}
                                isSending={isCreating}
                                placeholder={t('session.inputPlaceholder')}
                                autocompletePrefixes={[]}
                                autocompleteSuggestions={async () => []}
                                agentType={agentType}
                                onAgentClick={handleAgentInputAgentClick}
                                permissionMode={permissionMode}
                                onPermissionClick={handleAgentInputPermissionClick}
                                modelMode={modelMode}
                                onModelModeChange={setModelMode}
                                connectionStatus={connectionStatus}
                                machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                                onMachineClick={handleAgentInputMachineClick}
                                currentPath={selectedPath}
                                onPathClick={handleAgentInputPathClick}
                                {...(useProfiles ? {
                                    profileId: selectedProfileId,
                                    onProfileClick: handleAgentInputProfileClick,
                                    envVarsCount: selectedProfileEnvVarsCount || undefined,
                                    onEnvVarsClick: selectedProfileEnvVarsCount > 0 ? handleEnvVarsClick : undefined,
                                } : {})}
                            />
                    </View>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}

export default React.memo(NewSessionWizard);
