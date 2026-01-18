import React from 'react';
import { View, Text, Platform, Pressable, useWindowDimensions, ScrollView } from 'react-native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, storage, useSetting, useSettingMutable } from '@/sync/storage';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { machineSpawnNewSession } from '@/sync/ops';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { SessionTypeSelectorRows } from '@/components/SessionTypeSelector';
import { createWorktree } from '@/utils/createWorktree';
import { getTempData, type NewSessionData } from '@/utils/tempDataStore';
import { linkTaskToSession } from '@/-zen/model/taskSessionLink';
import type { PermissionMode, ModelMode } from '@/sync/permissionTypes';
import { mapPermissionModeAcrossAgents } from '@/sync/permissionMapping';
import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES, getProfilePrimaryCli } from '@/sync/profileUtils';
import { AgentInput } from '@/components/AgentInput';
import { StyleSheet } from 'react-native-unistyles';
import { useCLIDetection } from '@/hooks/useCLIDetection';
import { useProfileEnvRequirements } from '@/hooks/useProfileEnvRequirements';
import { getRequiredSecretEnvVarName } from '@/sync/profileSecrets';

import { isMachineOnline } from '@/utils/machineUtils';
import { StatusDot } from '@/components/StatusDot';
import { clearNewSessionDraft, loadNewSessionDraft, saveNewSessionDraft } from '@/sync/persistence';
import { MachineSelector } from '@/components/newSession/MachineSelector';
import { PathSelector } from '@/components/newSession/PathSelector';
import { SearchHeader } from '@/components/SearchHeader';
import { ProfileCompatibilityIcon } from '@/components/newSession/ProfileCompatibilityIcon';
import { EnvironmentVariablesPreviewModal } from '@/components/newSession/EnvironmentVariablesPreviewModal';
import { buildProfileGroups, toggleFavoriteProfileId } from '@/sync/profileGrouping';
import { ItemRowActions } from '@/components/ItemRowActions';
import { ProfileRequirementsBadge } from '@/components/ProfileRequirementsBadge';
import { buildProfileActions } from '@/components/profileActions';
import type { ItemAction } from '@/components/ItemActionsMenuModal';
import { consumeApiKeyIdParam, consumeProfileIdParam } from '@/profileRouteParams';
import { getModelOptionsForAgentType } from '@/sync/modelOptions';
import { ignoreNextRowPress } from '@/utils/ignoreNextRowPress';
import { ApiKeyRequirementModal, type ApiKeyRequirementModalResult } from '@/components/ApiKeyRequirementModal';
import { useFocusEffect } from '@react-navigation/native';
import { getRecentPathsForMachine } from '@/utils/recentPaths';
import { InteractionManager } from 'react-native';
import { NewSessionWizard } from './NewSessionWizard';
import { prefetchMachineDetectCliIfStale } from '@/hooks/useMachineDetectCliCache';

// Optimized profile lookup utility
const useProfileMap = (profiles: AIBackendProfile[]) => {
    return React.useMemo(() =>
        new Map(profiles.map(p => [p.id, p])),
        [profiles]
    );
};

// Environment variable transformation helper
// Returns ALL profile environment variables - daemon will use them as-is
const transformProfileToEnvironmentVars = (profile: AIBackendProfile) => {
    // getProfileEnvironmentVariables already returns ALL env vars from profile
    // including custom environmentVariables array
    return getProfileEnvironmentVariables(profile);
};

// Configuration constants
const RECENT_PATHS_DEFAULT_VISIBLE = 5;
const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
        paddingTop: Platform.OS === 'web' ? 20 : 10,
        ...(Platform.select({
            web: { minHeight: 0 },
            default: {},
        }) as any),
    },
    scrollContainer: {
        flex: 1,
        ...(Platform.select({
            web: { minHeight: 0 },
            default: {},
        }) as any),
    },
    contentContainer: {
        width: '100%',
        alignSelf: 'center',
        paddingTop: 0,
        paddingBottom: 16,
    },
    wizardContainer: {
        marginBottom: 16,
    },
    wizardSectionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 6,
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
        marginBottom: Platform.OS === 'web' ? 8 : 0,
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

function NewSessionScreen() {
    const { theme, rt } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const { width: screenWidth } = useWindowDimensions();
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;

    const openApiKeys = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/api-key',
            params: { selectedId: '' },
        });
    }, [router]);

    const newSessionSidePadding = 16;
    const newSessionBottomPadding = Math.max(screenWidth < 420 ? 8 : 16, safeArea.bottom);
    const { prompt, dataId, machineId: machineIdParam, path: pathParam, profileId: profileIdParam, apiKeyId: apiKeyIdParam, apiKeySessionOnlyId } = useLocalSearchParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string;
        path?: string;
        profileId?: string;
        apiKeyId?: string;
        apiKeySessionOnlyId?: string;
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
    const [apiKeys, setApiKeys] = useSettingMutable('apiKeys');
    const [defaultApiKeyByProfileId, setDefaultApiKeyByProfileId] = useSettingMutable('defaultApiKeyByProfileId');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');
    const experimentsEnabled = useSetting('experiments');
    const expGemini = useSetting('expGemini');
    const expSessionType = useSetting('expSessionType');
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [dismissedCLIWarnings, setDismissedCLIWarnings] = useSettingMutable('dismissedCLIWarnings');

    useFocusEffect(
        React.useCallback(() => {
            // Ensure newly-registered machines show up without requiring an app restart.
            // Throttled to avoid spamming the server when navigating back/forth.
            // Defer until after interactions so the screen feels instant on iOS.
            InteractionManager.runAfterInteractions(() => {
                void sync.refreshMachinesThrottled({ staleMs: 15_000 });
            });
        }, [])
    );

    // (prefetch effect moved below, after machines/recent/favorites are defined)

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

    const isDefaultEnvironmentFavorite = favoriteProfileIdSet.has('');

    const toggleFavoriteProfile = React.useCallback((profileId: string) => {
        setFavoriteProfileIds(toggleFavoriteProfileId(favoriteProfileIds, profileId));
    }, [favoriteProfileIds, setFavoriteProfileIds]);
    const machines = useAllMachines();

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

    const [selectedApiKeyId, setSelectedApiKeyId] = React.useState<string | null>(() => {
        return persistedDraft?.selectedApiKeyId ?? null;
    });

    // Session-only secret (NOT persisted). Highest-precedence override for this session.
    const [sessionOnlyApiKeyValue, setSessionOnlyApiKeyValue] = React.useState<string | null>(null);

    const prevProfileIdBeforeApiKeyPromptRef = React.useRef<string | null>(null);
    const lastApiKeyPromptKeyRef = React.useRef<string | null>(null);
    const suppressNextApiKeyAutoPromptKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!useProfiles && selectedProfileId !== null) {
            setSelectedProfileId(null);
        }
    }, [useProfiles, selectedProfileId]);

    const allowGemini = experimentsEnabled && expGemini;

    // AgentInput autocomplete is unused on this screen today, but passing a new
    // function/array each render forces autocomplete hooks to re-sync.
    // Keep these stable to avoid unnecessary work during taps/selection changes.
    const emptyAutocompletePrefixes = React.useMemo(() => [], []);
    const emptyAutocompleteSuggestions = React.useCallback(async () => [], []);

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
        return agentType === 'codex' ? 'gpt-5-codex-high' : agentType === 'gemini' ? 'gemini-2.5-pro' : 'default';
    });
    const modelOptions = React.useMemo(() => getModelOptionsForAgentType(agentType), [agentType]);

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

    const getBestPathForMachine = React.useCallback((machineId: string | null): string => {
        if (!machineId) return '';
        const recent = getRecentPathsForMachine({
            machineId,
            recentMachinePaths,
            sessions: null,
        });
        if (recent.length > 0) return recent[0]!;
        const machine = machines.find((m) => m.id === machineId);
        return machine?.metadata?.homeDir ?? '';
    }, [machines, recentMachinePaths]);

    const openApiKeyRequirementModal = React.useCallback((profile: AIBackendProfile, options: { revertOnCancel: boolean }) => {
        const handleResolve = (result: ApiKeyRequirementModalResult) => {
            if (result.action === 'cancel') {
                // Always allow future prompts for this profile.
                lastApiKeyPromptKeyRef.current = null;
                suppressNextApiKeyAutoPromptKeyRef.current = null;
                if (options.revertOnCancel) {
                    const prev = prevProfileIdBeforeApiKeyPromptRef.current;
                    setSelectedProfileId(prev);
                }
                return;
            }

            if (result.action === 'useMachine') {
                // Explicit choice: do not auto-apply default key.
                setSelectedApiKeyId('');
                setSessionOnlyApiKeyValue(null);
                return;
            }

            if (result.action === 'enterOnce') {
                // Explicit choice: do not auto-apply default key.
                setSelectedApiKeyId('');
                setSessionOnlyApiKeyValue(result.value);
                return;
            }

            if (result.action === 'selectSaved') {
                setSessionOnlyApiKeyValue(null);
                setSelectedApiKeyId(result.apiKeyId);
                if (result.setDefault) {
                    setDefaultApiKeyByProfileId({
                        ...defaultApiKeyByProfileId,
                        [profile.id]: result.apiKeyId,
                    });
                }
            }
        };

        Modal.show({
            component: ApiKeyRequirementModal,
            props: {
                profile,
                machineId: selectedMachineId ?? null,
                apiKeys,
                defaultApiKeyId: defaultApiKeyByProfileId[profile.id] ?? null,
                onChangeApiKeys: setApiKeys,
                allowSessionOnly: true,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' }),
            },
        });
    }, [
        apiKeys,
        defaultApiKeyByProfileId,
        selectedMachineId,
        setDefaultApiKeyByProfileId,
    ]);

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
        return getBestPathForMachine(selectedMachineId);
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
            const bestPath = getBestPathForMachine(machineIdParam);
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
        setSelectedPath(getBestPathForMachine(machineIdToUse));
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
    const modelSectionRef = React.useRef<View>(null);
    const machineSectionRef = React.useRef<View>(null);
    const pathSectionRef = React.useRef<View>(null);
    const permissionSectionRef = React.useRef<View>(null);

    // CLI Detection - automatic, non-blocking detection of installed CLIs on selected machine
    const cliAvailability = useCLIDetection(selectedMachineId, { autoDetect: false });

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

    const profileAvailabilityById = React.useMemo(() => {
        const map = new Map<string, { available: boolean; reason?: string }>();
        for (const profile of allProfiles) {
            map.set(profile.id, isProfileAvailable(profile));
        }
        return map;
    }, [allProfiles, isProfileAvailable]);

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

    React.useEffect(() => {
        // Session-only secrets are only for the current launch attempt; clear when profile changes.
        setSessionOnlyApiKeyValue(null);
    }, [selectedProfileId]);

    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId);
    }, [selectedMachineId, machines]);

    const requiredSecretEnvVarName = React.useMemo(() => {
        return getRequiredSecretEnvVarName(selectedProfile);
    }, [selectedProfile]);

    const shouldShowApiKeySection = Boolean(
        selectedProfile &&
        selectedProfile.authMode === 'apiKeyEnv' &&
        requiredSecretEnvVarName,
    );

    const apiKeyPreflight = useProfileEnvRequirements(
        shouldShowApiKeySection ? selectedMachineId : null,
        shouldShowApiKeySection ? selectedProfile : null,
    );

    const selectedSavedApiKey = React.useMemo(() => {
        if (!selectedApiKeyId) return null;
        return apiKeys.find((k) => k.id === selectedApiKeyId) ?? null;
    }, [apiKeys, selectedApiKeyId]);

    React.useEffect(() => {
        if (!selectedProfileId) return;
        if (selectedApiKeyId !== null) return;
        const nextDefault = defaultApiKeyByProfileId[selectedProfileId];
        if (typeof nextDefault === 'string' && nextDefault.length > 0) {
            setSelectedApiKeyId(nextDefault);
        }
    }, [defaultApiKeyByProfileId, selectedApiKeyId, selectedProfileId]);

    const activeApiKeySource = sessionOnlyApiKeyValue
        ? 'sessionOnly'
        : selectedApiKeyId
            ? 'saved'
            : 'machineEnv';

    const openProfileEdit = React.useCallback((params: { profileId?: string; cloneFromProfileId?: string }) => {
        // Persisting can block the JS thread on iOS (MMKV). Navigation should be instant,
        // so we persist after the navigation transition.
        const draft = {
            input: sessionPrompt,
            selectedMachineId,
            selectedPath,
            selectedProfileId: useProfiles ? selectedProfileId : null,
            selectedApiKeyId,
            agentType,
            permissionMode,
            modelMode,
            sessionType,
            updatedAt: Date.now(),
        };

        router.push({
            pathname: '/new/pick/profile-edit',
            params: {
                ...params,
                ...(selectedMachineId ? { machineId: selectedMachineId } : {}),
            },
        } as any);

        InteractionManager.runAfterInteractions(() => {
            saveNewSessionDraft(draft);
        });
    }, [agentType, modelMode, permissionMode, router, selectedMachineId, selectedPath, selectedProfileId, sessionPrompt, sessionType, useProfiles]);

    const handleAddProfile = React.useCallback(() => {
        openProfileEdit({});
    }, [openProfileEdit]);

    const handleDuplicateProfile = React.useCallback((profile: AIBackendProfile) => {
        openProfileEdit({ cloneFromProfileId: profile.id });
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
    // Recent machines computed from recentMachinePaths (lightweight; avoids subscribing to sessions updates)
    const recentMachines = React.useMemo(() => {
        if (machines.length === 0) return [];
        if (!recentMachinePaths || recentMachinePaths.length === 0) return [];

        const byId = new Map(machines.map((m) => [m.id, m] as const));
        const seen = new Set<string>();
        const result: typeof machines = [];
        for (const entry of recentMachinePaths) {
            if (seen.has(entry.machineId)) continue;
            const m = byId.get(entry.machineId);
            if (!m) continue;
            seen.add(entry.machineId);
            result.push(m);
        }
        return result;
    }, [machines, recentMachinePaths]);

    const favoriteMachineItems = React.useMemo(() => {
        return machines.filter(m => favoriteMachines.includes(m.id));
    }, [machines, favoriteMachines]);

    // Background refresh on open: pick up newly-installed CLIs without fetching on taps.
    // Keep this fairly conservative to avoid impacting iOS responsiveness.
    const CLI_DETECT_REVALIDATE_STALE_MS = 2 * 60 * 1000; // 2 minutes

    // One-time prefetch of detect-cli results for the wizard machine list.
    // This keeps machine glyphs responsive (cache-only in the list) without
    // triggering per-row auto-detect work during taps.
    const didPrefetchWizardMachineGlyphsRef = React.useRef(false);
    React.useEffect(() => {
        if (!useEnhancedSessionWizard) return;
        if (didPrefetchWizardMachineGlyphsRef.current) return;
        didPrefetchWizardMachineGlyphsRef.current = true;

        InteractionManager.runAfterInteractions(() => {
            try {
                const candidates: string[] = [];
                for (const m of favoriteMachineItems) candidates.push(m.id);
                for (const m of recentMachines) candidates.push(m.id);
                for (const m of machines.slice(0, 8)) candidates.push(m.id);

                const seen = new Set<string>();
                const unique = candidates.filter((id) => {
                    if (seen.has(id)) return false;
                    seen.add(id);
                    return true;
                });

                // Limit to avoid a thundering herd on iOS.
                const toPrefetch = unique.slice(0, 12);
                for (const machineId of toPrefetch) {
                    const machine = machines.find((m) => m.id === machineId);
                    if (!machine) continue;
                    if (!isMachineOnline(machine)) continue;
                    void prefetchMachineDetectCliIfStale({ machineId, staleMs: CLI_DETECT_REVALIDATE_STALE_MS });
                }
            } catch {
                // best-effort prefetch only
            }
        });
    }, [favoriteMachineItems, machines, recentMachines, useEnhancedSessionWizard]);

    // Cache-first + background refresh: for the actively selected machine, prefetch detect-cli
    // if missing or stale. This updates the banners/agent availability on screen open, but avoids
    // any fetches on tap handlers.
    React.useEffect(() => {
        if (!selectedMachineId) return;
        const machine = machines.find((m) => m.id === selectedMachineId);
        if (!machine) return;
        if (!isMachineOnline(machine)) return;

        InteractionManager.runAfterInteractions(() => {
            void prefetchMachineDetectCliIfStale({
                machineId: selectedMachineId,
                staleMs: CLI_DETECT_REVALIDATE_STALE_MS,
            });
        });
    }, [machines, selectedMachineId]);

    const recentPaths = React.useMemo(() => {
        if (!selectedMachineId) return [];
        return getRecentPathsForMachine({
            machineId: selectedMachineId,
            recentMachinePaths,
            sessions: null,
        });
    }, [recentMachinePaths, selectedMachineId]);

    // Validation
    const canCreate = React.useMemo(() => {
        return selectedMachineId !== null && selectedPath.trim() !== '';
    }, [selectedMachineId, selectedPath]);

    // On iOS, keep tap handlers extremely light so selection state can commit instantly.
    // We defer any follow-up adjustments (agent/session-type/permission defaults) until after interactions.
    const pendingProfileSelectionRef = React.useRef<{ profileId: string; prevProfileId: string | null } | null>(null);

    const selectProfile = React.useCallback((profileId: string) => {
        const prevSelectedProfileId = selectedProfileId;
        prevProfileIdBeforeApiKeyPromptRef.current = prevSelectedProfileId;
        // Ensure selecting a profile can re-prompt if needed.
        lastApiKeyPromptKeyRef.current = null;
        pendingProfileSelectionRef.current = { profileId, prevProfileId: prevSelectedProfileId };
        setSelectedProfileId(profileId);
    }, [selectedProfileId]);

    React.useEffect(() => {
        if (!selectedProfileId) return;
        const pending = pendingProfileSelectionRef.current;
        if (!pending || pending.profileId !== selectedProfileId) return;
        pendingProfileSelectionRef.current = null;

        InteractionManager.runAfterInteractions(() => {
            // Ensure nothing changed while we waited.
            if (selectedProfileId !== pending.profileId) return;

            const profile = profileMap.get(pending.profileId) || getBuiltInProfile(pending.profileId);
            if (!profile) return;

            const supportedAgents = (Object.entries(profile.compatibility) as Array<[string, boolean]>)
                .filter(([, supported]) => supported)
                .map(([agent]) => agent as 'claude' | 'codex' | 'gemini')
                .filter((agent) => agent !== 'gemini' || allowGemini);

            if (supportedAgents.length > 0 && !supportedAgents.includes(agentType)) {
                setAgentType(supportedAgents[0] ?? 'claude');
            }

            if (profile.defaultSessionType) {
                setSessionType(profile.defaultSessionType);
            }

            if (!hasUserSelectedPermissionModeRef.current && profile.defaultPermissionMode) {
                const nextMode = profile.defaultPermissionMode as PermissionMode;
                const isInitialProfileSelection = pending.prevProfileId === null;
                if (isInitialProfileSelection) {
                    applyPermissionMode(nextMode, 'auto');
                }
            }
        });
    }, [agentType, allowGemini, applyPermissionMode, profileMap, selectedProfileId]);

    // Keep ProfilesList props stable to avoid rerendering the whole list on
    // unrelated state updates (iOS perf).
    const profilesGroupTitles = React.useMemo(() => {
        return {
            favorites: t('profiles.groups.favorites'),
            custom: t('profiles.groups.custom'),
            builtIn: t('profiles.groups.builtIn'),
        };
    }, []);

    const getProfileDisabled = React.useCallback((profile: { id: string }) => {
        return !(profileAvailabilityById.get(profile.id) ?? { available: true }).available;
    }, [profileAvailabilityById]);

    const getProfileSubtitleExtra = React.useCallback((profile: { id: string }) => {
        const availability = profileAvailabilityById.get(profile.id) ?? { available: true };
        if (availability.available || !availability.reason) return null;
        if (availability.reason.startsWith('requires-agent:')) {
            const required = availability.reason.split(':')[1];
            const agentLabel = required === 'claude'
                ? t('agentInput.agent.claude')
                : required === 'codex'
                    ? t('agentInput.agent.codex')
                    : required === 'gemini'
                        ? t('agentInput.agent.gemini')
                        : required;
            return t('newSession.profileAvailability.requiresAgent', { agent: agentLabel });
        }
        if (availability.reason.startsWith('cli-not-detected:')) {
            const cli = availability.reason.split(':')[1];
            const cliLabel = cli === 'claude'
                ? t('agentInput.agent.claude')
                : cli === 'codex'
                    ? t('agentInput.agent.codex')
                    : cli === 'gemini'
                        ? t('agentInput.agent.gemini')
                        : cli;
            return t('newSession.profileAvailability.cliNotDetected', { cli: cliLabel });
        }
        return availability.reason;
    }, [profileAvailabilityById]);

    const onPressProfile = React.useCallback((profile: { id: string }) => {
        const availability = profileAvailabilityById.get(profile.id) ?? { available: true };
        if (!availability.available) return;
        selectProfile(profile.id);
    }, [profileAvailabilityById, selectProfile]);

    const onPressDefaultEnvironment = React.useCallback(() => {
        setSelectedProfileId(null);
    }, []);

    // If a selected profile requires an API key and the key isn't available on the selected machine,
    // prompt immediately and revert selection on cancel (so the profile isn't "selected" without a key).
    React.useEffect(() => {
        if (!useProfiles) return;
        if (!selectedMachineId) return;
        if (!shouldShowApiKeySection) return;
        if (!selectedProfileId) return;

        const hasInjected = Boolean(sessionOnlyApiKeyValue || selectedSavedApiKey?.value);
        const hasMachineEnv = apiKeyPreflight.isReady;
        if (hasInjected || hasMachineEnv) {
            // Reset prompt key when requirements are satisfied so future selections can prompt again if needed.
            lastApiKeyPromptKeyRef.current = null;
            return;
        }

        const promptKey = `${selectedMachineId}:${selectedProfileId}`;
        if (suppressNextApiKeyAutoPromptKeyRef.current === promptKey) {
            // One-shot suppression (used when the user explicitly opened the modal via the badge).
            suppressNextApiKeyAutoPromptKeyRef.current = null;
            return;
        }
        if (lastApiKeyPromptKeyRef.current === promptKey) {
            return;
        }
        lastApiKeyPromptKeyRef.current = promptKey;
        if (!selectedProfile) {
            return;
        }
        openApiKeyRequirementModal(selectedProfile, { revertOnCancel: true });
    }, [
        apiKeyPreflight.isReady,
        defaultApiKeyByProfileId,
        openApiKeyRequirementModal,
        requiredSecretEnvVarName,
        selectedApiKeyId,
        selectedMachineId,
        selectedProfileId,
        selectedProfile,
        selectedSavedApiKey?.value,
        sessionOnlyApiKeyValue,
        shouldShowApiKeySection,
        suppressNextApiKeyAutoPromptKeyRef,
        useProfiles,
    ]);

    // Handle profile route param from picker screens
    React.useEffect(() => {
        if (!useProfiles) {
            return;
        }

        const { nextSelectedProfileId, shouldClearParam } = consumeProfileIdParam({
            profileIdParam,
            selectedProfileId,
        });

        if (nextSelectedProfileId === null) {
            if (selectedProfileId !== null) {
                setSelectedProfileId(null);
            }
        } else if (typeof nextSelectedProfileId === 'string') {
            selectProfile(nextSelectedProfileId);
        }

        if (shouldClearParam) {
            const setParams = (navigation as any)?.setParams;
            if (typeof setParams === 'function') {
                setParams({ profileId: undefined });
            } else {
                navigation.dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { profileId: undefined } },
                } as never);
            }
        }
    }, [navigation, profileIdParam, selectedProfileId, selectProfile, useProfiles]);

    // Handle apiKey route param from picker screens
    React.useEffect(() => {
        const { nextSelectedApiKeyId, shouldClearParam } = consumeApiKeyIdParam({
            apiKeyIdParam,
            selectedApiKeyId,
        });

        if (nextSelectedApiKeyId === null) {
            if (selectedApiKeyId !== null) {
                setSelectedApiKeyId(null);
            }
        } else if (typeof nextSelectedApiKeyId === 'string') {
            setSelectedApiKeyId(nextSelectedApiKeyId);
        }

        if (shouldClearParam) {
            const setParams = (navigation as any)?.setParams;
            if (typeof setParams === 'function') {
                setParams({ apiKeyId: undefined });
            } else {
                navigation.dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { apiKeyId: undefined } },
                } as never);
            }
        }
    }, [apiKeyIdParam, navigation, selectedApiKeyId]);

    // Handle session-only API key temp id from picker screens (value is stored in-memory only).
    React.useEffect(() => {
        if (typeof apiKeySessionOnlyId !== 'string' || apiKeySessionOnlyId.length === 0) {
            return;
        }

        const entry = getTempData<{ apiKey?: string }>(apiKeySessionOnlyId);
        const value = entry?.apiKey;
        if (typeof value === 'string' && value.length > 0) {
            setSessionOnlyApiKeyValue(value);
            setSelectedApiKeyId(null);
        }

        const setParams = (navigation as any)?.setParams;
        if (typeof setParams === 'function') {
            setParams({ apiKeySessionOnlyId: undefined });
        } else {
            navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: { apiKeySessionOnlyId: undefined } },
            } as never);
        }
    }, [apiKeySessionOnlyId, navigation]);

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

    // When agent type changes, keep the "permission level" consistent by mapping modes across backends.
    React.useEffect(() => {
        const prev = prevAgentTypeRef.current;
        if (prev === agentType) {
            return;
        }
        prevAgentTypeRef.current = agentType;

        const current = permissionModeRef.current;
        const validClaudeModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        const validCodexGeminiModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

        const isValidForNewAgent = (agentType === 'codex' || agentType === 'gemini')
            ? validCodexGeminiModes.includes(current)
            : validClaudeModes.includes(current);

        if (isValidForNewAgent) {
            return;
        }

        const mapped = mapPermissionModeAcrossAgents(current, prev, agentType);
        applyPermissionMode(mapped, 'auto');
    }, [agentType, applyPermissionMode]);

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
	    const wizardSectionOffsets = React.useRef<{ profile?: number; agent?: number; model?: number; machine?: number; path?: number; permission?: number; sessionType?: number }>({});
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
        });
    }, [selectedMachine, selectedMachineId]);

	    const renderProfileLeftElement = React.useCallback((profile: AIBackendProfile) => {
	        return <ProfileCompatibilityIcon profile={profile} />;
	    }, []);

	    const renderDefaultEnvironmentRightElement = React.useCallback((isSelected: boolean) => {
	        const isFavorite = isDefaultEnvironmentFavorite;
	        const actions: ItemAction[] = [
	            {
	                id: 'favorite',
	                title: isFavorite ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites'),
	                icon: isFavorite ? 'star' : 'star-outline',
	                onPress: () => toggleFavoriteProfile(''),
	                color: isFavorite ? selectedIndicatorColor : theme.colors.textSecondary,
	            },
	        ];

	        return (
	            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
	                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
	                    <Ionicons
	                        name="checkmark-circle"
	                        size={24}
	                        color={selectedIndicatorColor}
	                        style={{ opacity: isSelected ? 1 : 0 }}
	                    />
	                </View>
	                <ItemRowActions
	                    title={t('profiles.noProfile')}
	                    actions={actions}
	                    compactActionIds={['favorite']}
	                    iconSize={20}
	                    onActionPressIn={() => {
	                        ignoreNextRowPress(ignoreProfileRowPressRef);
	                    }}
	                />
	            </View>
	        );
	    }, [isDefaultEnvironmentFavorite, selectedIndicatorColor, theme.colors.textSecondary, toggleFavoriteProfile]);

	    const renderProfileRightElement = React.useCallback((profile: AIBackendProfile, isSelected: boolean, isFavorite: boolean) => {
	        const envVarCount = Object.keys(getProfileEnvironmentVariables(profile)).length;

	        const actions = buildProfileActions({
	            profile,
	            isFavorite,
	            favoriteActionColor: selectedIndicatorColor,
	            nonFavoriteActionColor: theme.colors.textSecondary,
	            onToggleFavorite: () => toggleFavoriteProfile(profile.id),
	            onEdit: () => openProfileEdit({ profileId: profile.id }),
	            onDuplicate: () => handleDuplicateProfile(profile),
	            onDelete: () => handleDeleteProfile(profile),
	            onViewEnvironmentVariables: envVarCount > 0 ? () => openProfileEnvVarsPreview(profile) : undefined,
	        });

	        return (
	            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                    <ProfileRequirementsBadge
                        profile={profile}
                        machineId={selectedMachineId ?? null}
                        onPress={openApiKeys}
                    />
	                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
	                    <Ionicons
                        name="checkmark-circle"
                        size={24}
	                        color={selectedIndicatorColor}
	                        style={{ opacity: isSelected ? 1 : 0 }}
	                    />
	                </View>
		                <ItemRowActions
		                    title={profile.name}
		                    actions={actions}
		                    compactActionIds={['favorite', ...(envVarCount > 0 ? ['envVars'] : [])]}
		                    iconSize={20}
		                    onActionPressIn={() => {
		                        ignoreNextRowPress(ignoreProfileRowPressRef);
		                    }}
		                />
	            </View>
	        );
	    }, [
	        handleDeleteProfile,
	        handleDuplicateProfile,
            openApiKeys,
	        openProfileEnvVarsPreview,
	        openProfileEdit,
	        screenWidth,
            selectedMachineId,
	        selectedIndicatorColor,
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
                    t('profiles.aiBackend.title'),
                    t('newSession.aiBackendSelectedByProfile'),
                    [
                        { text: t('common.ok'), style: 'cancel' },
                        { text: t('newSession.changeProfile'), onPress: handleProfileClick },
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
        return transformProfileToEnvironmentVars(selectedProfileForEnvVars) ?? {};
    }, [selectedProfileForEnvVars]);

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
        });
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
                    environmentVariables = transformProfileToEnvironmentVars(selectedProfile);

                    // Spawn-time secret injection overlay (saved key / session-only key)
                    const requiredSecretName = requiredSecretEnvVarName;
                    const injectedSecretValue =
                        sessionOnlyApiKeyValue
                            ?? selectedSavedApiKey?.value
                            ?? null;

                    const needsSecret =
                        selectedProfile.authMode === 'apiKeyEnv' &&
                        typeof requiredSecretName === 'string' &&
                        requiredSecretName.length > 0;

                    if (needsSecret) {
                        const hasMachineEnv = apiKeyPreflight.isReady;
                        const hasInjected = typeof injectedSecretValue === 'string' && injectedSecretValue.length > 0;

                        if (!hasInjected && !hasMachineEnv) {
                            Modal.alert(
                                t('common.error'),
                                `Missing API key (${requiredSecretName}). Configure it on the machine or select/enter a key.`,
                            );
                            setIsCreating(false);
                            return;
                        }

                        if (hasInjected) {
                            environmentVariables = {
                                ...environmentVariables,
                                [requiredSecretName]: injectedSecretValue!,
                            };
                        }
                    }
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
    }, [
        agentType,
        apiKeyPreflight.isReady,
        experimentsEnabled,
        modelMode,
        permissionMode,
        profileMap,
        recentMachinePaths,
        requiredSecretEnvVarName,
        router,
        selectedMachineId,
        selectedPath,
        selectedProfileId,
        selectedSavedApiKey?.value,
        sessionOnlyApiKeyValue,
        sessionPrompt,
        sessionType,
        useEnhancedSessionWizard,
        useProfiles,
    ]);

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

        return {
            text: isOnline ? 'online' : 'offline',
            color: isOnline ? theme.colors.success : theme.colors.textDestructive,
            dotColor: isOnline ? theme.colors.success : theme.colors.textDestructive,
            isPulsing: isOnline,
        };
    }, [selectedMachine, theme]);

    const persistDraftNow = React.useCallback(() => {
        saveNewSessionDraft({
            input: sessionPrompt,
            selectedMachineId,
            selectedPath,
            selectedProfileId: useProfiles ? selectedProfileId : null,
            selectedApiKeyId,
            agentType,
            permissionMode,
            modelMode,
            sessionType,
            updatedAt: Date.now(),
        });
    }, [agentType, modelMode, permissionMode, selectedApiKeyId, selectedMachineId, selectedPath, selectedProfileId, sessionPrompt, sessionType, useProfiles]);

    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        if (draftSaveTimerRef.current) {
            clearTimeout(draftSaveTimerRef.current);
        }
        const delayMs = Platform.OS === 'web' ? 250 : 900;
        draftSaveTimerRef.current = setTimeout(() => {
            // Persisting uses synchronous storage under the hood (MMKV), which can block the JS thread on iOS.
            // Run after interactions so taps/animations stay responsive.
            if (Platform.OS === 'web') {
                persistDraftNow();
            } else {
                InteractionManager.runAfterInteractions(() => {
                    persistDraftNow();
                });
            }
        }, delayMs);
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
                style={[
                    styles.container,
                    ...(Platform.OS === 'web'
                        ? [
                            {
                                justifyContent: 'center',
                                paddingTop: 0,
                            },
                        ]
                        : [
                            {
                                justifyContent: 'flex-end',
                                paddingTop: 40,
                            },
                        ]),
                ]}
            >
                <View style={{ 
                    width: '100%',
                    alignSelf: 'center',
                    paddingTop: safeArea.top,
                    paddingBottom: safeArea.bottom,
                }}>
                    {/* Session type selector only if enabled via experiments */}
                    {experimentsEnabled && expSessionType && (
                        <View style={{ paddingHorizontal: newSessionSidePadding, marginBottom: 16 }}>
                            <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                                <ItemGroup title={t('newSession.sessionType.title')} containerStyle={{ marginHorizontal: 0 }}>
                                    <SessionTypeSelectorRows value={sessionType} onChange={setSessionType} />
                                </ItemGroup>
                            </View>
                        </View>
                    )}

                    {/* AgentInput with inline chips - sticky at bottom */}
                    <View
                        style={{
                            paddingTop: 12,
                            paddingBottom: newSessionBottomPadding,
                        }}
                    >
                        <View style={{ paddingHorizontal: newSessionSidePadding }}>
                            <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                                <AgentInput
                                    value={sessionPrompt}
                                    onChangeText={setSessionPrompt}
                                    onSend={handleCreateSession}
                                    isSendDisabled={!canCreate}
                                    isSending={isCreating}
                                    placeholder={t('session.inputPlaceholder')}
                                    autocompletePrefixes={emptyAutocompletePrefixes}
                                    autocompleteSuggestions={emptyAutocompleteSuggestions}
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
                                    contentPaddingHorizontal={0}
                                    {...(useProfiles
                                        ? {
                                                profileId: selectedProfileId,
                                                onProfileClick: handleProfileClick,
                                                envVarsCount: selectedProfileEnvVarsCount || undefined,
                                                onEnvVarsClick: selectedProfileEnvVarsCount > 0 ? handleEnvVarsClick : undefined,
                                            }
                                        : {})}
                                />
                            </View>
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

    const wizardLayoutProps = React.useMemo(() => {
        return {
            theme,
            styles,
            safeAreaBottom: safeArea.bottom,
            headerHeight,
            newSessionSidePadding,
            newSessionBottomPadding,
            scrollViewRef,
            profileSectionRef,
            modelSectionRef,
            machineSectionRef,
            pathSectionRef,
            permissionSectionRef,
            registerWizardSectionOffset,
        };
    }, [headerHeight, newSessionBottomPadding, newSessionSidePadding, registerWizardSectionOffset, safeArea.bottom, theme]);

    const wizardProfilesProps = React.useMemo(() => {
        return {
            useProfiles,
            profiles,
            favoriteProfileIds,
            setFavoriteProfileIds,
            experimentsEnabled,
            selectedProfileId,
            onPressDefaultEnvironment,
            onPressProfile,
            selectedMachineId,
            getProfileDisabled,
            getProfileSubtitleExtra,
            handleAddProfile,
            openProfileEdit,
            handleDuplicateProfile,
            handleDeleteProfile,
            openProfileEnvVarsPreview,
            suppressNextApiKeyAutoPromptKeyRef,
            sessionOnlyApiKeyValue,
            selectedSavedApiKeyValue: selectedSavedApiKey?.value,
            apiKeyPreflightIsReady: apiKeyPreflight.isReady,
            openApiKeyRequirementModal,
            profilesGroupTitles,
        };
    }, [
        apiKeyPreflight.isReady,
        experimentsEnabled,
        favoriteProfileIds,
        getProfileDisabled,
        getProfileSubtitleExtra,
        handleAddProfile,
        handleDeleteProfile,
        handleDuplicateProfile,
        onPressDefaultEnvironment,
        onPressProfile,
        openApiKeyRequirementModal,
        openProfileEdit,
        openProfileEnvVarsPreview,
        profiles,
        profilesGroupTitles,
        selectedMachineId,
        selectedProfileId,
        selectedSavedApiKey?.value,
        sessionOnlyApiKeyValue,
        setFavoriteProfileIds,
        suppressNextApiKeyAutoPromptKeyRef,
        useProfiles,
    ]);

    const wizardAgentProps = React.useMemo(() => {
        return {
            cliAvailability,
            allowGemini,
            isWarningDismissed,
            hiddenBanners,
            handleCLIBannerDismiss,
            agentType,
            setAgentType,
            modelOptions,
            modelMode,
            setModelMode,
            selectedIndicatorColor,
            profileMap,
            handleAgentInputProfileClick,
            permissionMode,
            handlePermissionModeChange,
            sessionType,
            setSessionType,
        };
    }, [
        agentType,
        allowGemini,
        cliAvailability,
        handleAgentInputProfileClick,
        handleCLIBannerDismiss,
        hiddenBanners,
        isWarningDismissed,
        modelMode,
        modelOptions,
        permissionMode,
        profileMap,
        selectedIndicatorColor,
        sessionType,
        setAgentType,
        setModelMode,
        setSessionType,
        handlePermissionModeChange,
    ]);

    const wizardMachineProps = React.useMemo(() => {
        return {
            machines,
            selectedMachine: selectedMachine || null,
            recentMachines,
            favoriteMachineItems,
            useMachinePickerSearch,
            setSelectedMachineId,
            getBestPathForMachine,
            setSelectedPath,
            favoriteMachines,
            setFavoriteMachines,
            selectedPath,
            recentPaths,
            usePathPickerSearch,
            favoriteDirectories,
            setFavoriteDirectories,
        };
    }, [
        favoriteDirectories,
        favoriteMachineItems,
        favoriteMachines,
        getBestPathForMachine,
        machines,
        recentMachines,
        recentPaths,
        selectedMachine,
        selectedPath,
        setFavoriteDirectories,
        setFavoriteMachines,
        setSelectedMachineId,
        setSelectedPath,
        useMachinePickerSearch,
        usePathPickerSearch,
    ]);

    const wizardFooterProps = React.useMemo(() => {
        return {
            sessionPrompt,
            setSessionPrompt,
            handleCreateSession,
            canCreate,
            isCreating,
            emptyAutocompletePrefixes,
            emptyAutocompleteSuggestions,
            handleAgentInputAgentClick,
            handleAgentInputPermissionClick,
            connectionStatus,
            handleAgentInputMachineClick,
            handleAgentInputPathClick,
            handleAgentInputProfileClick: handleAgentInputProfileClick,
            selectedProfileEnvVarsCount,
            handleEnvVarsClick,
        };
    }, [
        canCreate,
        connectionStatus,
        emptyAutocompletePrefixes,
        emptyAutocompleteSuggestions,
        handleAgentInputAgentClick,
        handleAgentInputMachineClick,
        handleAgentInputPathClick,
        handleAgentInputPermissionClick,
        handleCreateSession,
        handleEnvVarsClick,
        isCreating,
        selectedProfileEnvVarsCount,
        sessionPrompt,
        setSessionPrompt,
        handleAgentInputProfileClick,
    ]);

    return (
        <NewSessionWizard
            layout={wizardLayoutProps}
            profiles={wizardProfilesProps}
            agent={wizardAgentProps}
            machine={wizardMachineProps}
            footer={wizardFooterProps}
        />
    );
}

export default React.memo(NewSessionScreen);
