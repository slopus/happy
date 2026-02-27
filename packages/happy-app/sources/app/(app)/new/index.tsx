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
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { machineBash, machineSpawnNewSession, sessionUpdateMetadataFields } from '@/sync/ops';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { createWorktree } from '@/utils/createWorktree';
import { createWorkspace, type WorkspaceRepoInput } from '@/utils/createWorkspace';
import { RepoPickerBar, type SelectedRepo } from '@/components/RepoPickerBar';
import type { RegisteredRepo } from '@/utils/workspaceRepos';
import { saveRegisteredRepos } from '@/sync/repoStore';
import { getTempData, type NewSessionData } from '@/utils/tempDataStore';
import { PermissionMode, ModelMode, PermissionModeSelector } from '@/components/PermissionModeSelector';
import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES } from '@/sync/profileUtils';
import { AgentInput } from '@/components/AgentInput';
import { StyleSheet } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';
import { Image } from 'expo-image';
import { resolveSessionIcon } from '@/components/Avatar';
import { useCLIDetection } from '@/hooks/useCLIDetection';
import { useEnvironmentVariables, resolveEnvVarSubstitution, extractEnvVarReferences } from '@/hooks/useEnvironmentVariables';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { MultiTextInput } from '@/components/MultiTextInput';
import { isMachineOnline } from '@/utils/machineUtils';
import { StatusDot } from '@/components/StatusDot';
import { SearchableListSelector, SelectorConfig } from '@/components/SearchableListSelector';
import { clearNewSessionDraft, loadNewSessionDraft, saveNewSessionDraft } from '@/sync/persistence';
import { useImagePicker } from '@/hooks/useImagePicker';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import { isModelModeForAgent } from '@/constants/modelCatalog';
import { FolderPickerSheet } from '@/components/FolderPickerSheet';
import { BottomSheetModal } from '@gorhom/bottom-sheet';

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
    },
    scrollContainer: {
        flex: 1,
    },
    contentContainer: {
        width: '100%',
        alignSelf: 'center',
        paddingTop: Platform.OS === 'web' ? rt.insets.top : 0,
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
        backgroundColor: '#000000',
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
    const { height: kbHeight, progress: kbProgress } = useReanimatedKeyboardAnimation();
    const animatedInputStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: kbHeight.value + safeArea.bottom * kbProgress.value }],
    }), [safeArea.bottom]);
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
            return tempSessionData.agentType;
        }
        if (lastUsedAgent === 'claude' || lastUsedAgent === 'codex' || lastUsedAgent === 'gemini') {
            return lastUsedAgent;
        }
        return 'claude';
    });

    // Agent cycling handler (for cycling through claude -> codex -> gemini)
    // Note: Does NOT persist immediately - persistence is handled by useEffect below
    const handleAgentClick = React.useCallback(() => {
        setAgentType(prev => {
            // Cycle: claude -> codex -> gemini -> claude
            if (prev === 'claude') return 'codex';
            if (prev === 'codex') return 'gemini';
            return 'claude';
        });
    }, []);

    // Persist agent selection changes (separate from setState to avoid race condition)
    // This runs after agentType state is updated, ensuring the value is stable
    React.useEffect(() => {
        sync.applySettings({ lastUsedAgent: agentType });
    }, [agentType]);

    const [sessionType, setSessionType] = React.useState<'simple' | 'worktree'>(persistedDraft?.sessionType || 'simple');
    const [selectedRepos, setSelectedRepos] = React.useState<SelectedRepo[]>([]);
    const [addDirBranchMenu, setAddDirBranchMenu] = React.useState<{ visible: boolean; items: ActionMenuItem[] }>({ visible: false, items: [] });
    const addDirBranchResolveRef = React.useRef<((value: string | undefined) => void) | null>(null);
    const folderPickerRef = React.useRef<BottomSheetModal>(null);
    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(() => {
        // Initialize with last used permission mode if valid, otherwise default to 'default'
        const validClaudeModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo'];
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
        // Support per-agent object format and legacy string format
        const saved = lastUsedModelMode;
        const mode = typeof saved === 'object' && saved !== null
            ? (saved as Record<string, string>)[agentType]
            : typeof saved === 'string' ? saved : undefined;
        if (mode && isModelModeForAgent(agentType, mode)) {
            return mode as ModelMode;
        }
        return 'default';
    });

    // Session details state
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => {
        // First try the persisted draft (saved immediately on selection)
        if (persistedDraft?.selectedMachineId && machines.find(m => m.id === persistedDraft.selectedMachineId)) {
            return persistedDraft.selectedMachineId;
        }
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

    const handleModelModeChange = React.useCallback((mode: ModelMode) => {
        setModelMode(mode);
        // Save the new selection immediately, per agent type
        const prev = storage.getState().settings.lastUsedModelMode;
        const prevObj = typeof prev === 'object' && prev !== null ? prev as Record<string, string> : {};
        sync.applySettings({ lastUsedModelMode: { ...prevObj, [agentType]: mode } });
    }, [agentType]);

    //
    // Path selection
    //

    const [selectedPath, setSelectedPath] = React.useState<string>(() => {
        // First try the persisted draft (saved immediately on selection)
        if (persistedDraft?.selectedPath) {
            return persistedDraft.selectedPath;
        }
        return getRecentPathForMachine(selectedMachineId, recentMachinePaths);
    });
    const [sessionPrompt, setSessionPrompt] = React.useState(() => {
        return tempSessionData?.prompt || prompt || persistedDraft?.input || '';
    });
    const [isCreating, setIsCreating] = React.useState(false);
    const [showAdvanced, setShowAdvanced] = React.useState(true);

    // Image picker
    const {
        images,
        pickFromGallery,
        pickFromCamera,
        addImageFromUri,
        removeImage,
        clearImages,
        canAddMore,
    } = useImagePicker({ maxImages: 4 });

    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const [imagePickerSheetVisible, setImagePickerSheetVisible] = React.useState(false);

    const supportsImages = agentType === 'claude' || agentType === 'gemini' || agentType === 'codex';

    const handleImageButtonPress = React.useCallback(() => {
        if (Platform.OS === 'web') {
            fileInputRef.current?.click();
        } else {
            setImagePickerSheetVisible(true);
        }
    }, []);

    const imagePickerMenuItems: ActionMenuItem[] = React.useMemo(() => [
        { label: t('session.takePhoto'), onPress: pickFromCamera },
        { label: t('session.chooseFromLibrary'), onPress: pickFromGallery },
    ], [pickFromCamera, pickFromGallery]);

    const handleFileInputChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        Array.from(files).forEach(file => {
            if (file.type.startsWith('image/')) {
                const url = URL.createObjectURL(file);
                addImageFromUri(url, file.type);
            }
        });
        event.target.value = '';
    }, [addImageFromUri]);

    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        if (!canAddMore || !supportsImages) return;

        const items = event.clipboardData?.items;
        if (!items) return;

        for (const item of Array.from(items)) {
            if (item.type.startsWith('image/')) {
                event.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    const url = URL.createObjectURL(file);
                    await addImageFromUri(url, file.type);
                }
                break;
            }
        }
    }, [canAddMore, supportsImages, addImageFromUri]);

    // Add paste event listener for images (web only)
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        const pasteListener = (e: Event) => handlePaste(e as ClipboardEvent);
        document.addEventListener('paste', pasteListener);

        return () => {
            document.removeEventListener('paste', pasteListener);
        };
    }, [handlePaste]);

    const handleImageDrop = React.useCallback(async (files: File[]) => {
        if (!canAddMore || !supportsImages) return;
        for (const file of files) {
            if (file.type.startsWith('image/') && canAddMore) {
                const url = URL.createObjectURL(file);
                await addImageFromUri(url, file.type);
            }
        }
    }, [canAddMore, supportsImages, addImageFromUri]);

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
                cliAvailability.gemini === true ? 'gemini' :
                'claude'; // Fallback to claude (will fail at spawn with clear error)

            console.warn(`[AgentSelection] ${agentType} not available, switching to ${availableAgent}`);
            setAgentType(availableAgent);
        }
    }, [cliAvailability.timestamp, cliAvailability.claude, cliAvailability.codex, cliAvailability.gemini, agentType]);

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

    // Helper to check if profile is available (CLI detected)
    // Note: Profile-agent compatibility no longer disables selection - selecting a profile will auto-switch agent
    const isProfileAvailable = React.useCallback((profile: AIBackendProfile): { available: boolean; reason?: string; willSwitchAgent?: string } => {
        // Determine which CLI(s) this profile supports
        const supportedCLIs = (Object.entries(profile.compatibility) as [string, boolean][])
            .filter(([, supported]) => supported)
            .map(([agent]) => agent);
        const requiredCLI = supportedCLIs.length === 1 ? supportedCLIs[0] as 'claude' | 'codex' | 'gemini' : null;

        // Only disable if required CLI is not detected on machine
        if (requiredCLI && cliAvailability[requiredCLI] === false) {
            return {
                available: false,
                reason: `cli-not-detected:${requiredCLI}`,
            };
        }

        // Check if selecting this profile will switch agent (for informational purposes)
        if (!validateProfileForAgent(profile, agentType) && requiredCLI) {
            return {
                available: true,
                willSwitchAgent: requiredCLI,
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

    /** Save defaultTargetBranch on a registered repo (fire-and-forget). */
    const persistDefaultBranch = React.useCallback((mId: string, repoId: string, branch: string) => {
        const latestRepos = storage.getState().registeredRepos[mId] || [];
        const updatedRepos = latestRepos.map(r =>
            r.id === repoId ? { ...r, defaultTargetBranch: branch } : r
        );
        const ver = storage.getState().registeredReposVersions[mId] ?? -1;
        const creds = sync.getCredentials();
        if (creds) {
            saveRegisteredRepos(creds, mId, updatedRepos, ver).then(nv => {
                storage.getState().setRegisteredRepos(mId, updatedRepos, nv);
            }).catch(() => {
                storage.getState().setRegisteredRepos(mId, updatedRepos, ver);
            });
        } else {
            storage.getState().setRegisteredRepos(mId, updatedRepos, ver);
        }
    }, []);

    /** Handle folder selected from FolderPickerSheet (registers + selects + branch picker). */
    const handleFolderSelected = React.useCallback(async (selectedPath: string) => {
        if (!selectedMachineId) return;
        const gitCheck = await machineBash(selectedMachineId, 'git rev-parse --git-dir', selectedPath);
        if (!gitCheck.success) {
            Modal.alert(t('common.error'), t('newSession.worktree.notGitRepo'));
            return;
        }
        const displayName = selectedPath.split('/').filter(Boolean).pop() || 'repo';

        // Register the repo permanently so it persists and shows in the picker next time
        let repoToSelect: RegisteredRepo;
        const currentRepos = storage.getState().registeredRepos[selectedMachineId] || [];
        const existing = currentRepos.find(r => r.path === selectedPath);
        if (existing) {
            repoToSelect = existing;
        } else {
            repoToSelect = { id: randomUUID(), path: selectedPath, displayName };
            const updatedRepos = [...currentRepos, repoToSelect];
            const version = storage.getState().registeredReposVersions[selectedMachineId] ?? -1;
            const credentials = sync.getCredentials();
            if (credentials) {
                try {
                    const newVersion = await saveRegisteredRepos(credentials, selectedMachineId, updatedRepos, version);
                    storage.getState().setRegisteredRepos(selectedMachineId, updatedRepos, newVersion);
                } catch {
                    storage.getState().setRegisteredRepos(selectedMachineId, updatedRepos, version);
                }
            } else {
                storage.getState().setRegisteredRepos(selectedMachineId, updatedRepos, version);
            }
        }

        // Fetch current branch, local branches, and remote branches in parallel
        const [currentBranchResult, localResult, remoteResult] = await Promise.all([
            machineBash(selectedMachineId, 'git rev-parse --abbrev-ref HEAD', selectedPath),
            machineBash(selectedMachineId, "git branch --list --format='%(refname:short)'", selectedPath),
            machineBash(selectedMachineId, "git branch -r --format='%(refname:short)'", selectedPath),
        ]);
        const currentBranch = currentBranchResult.success ? currentBranchResult.stdout.trim() : undefined;
        const localBranches = localResult.success && localResult.stdout.trim()
            ? localResult.stdout.trim().split('\n').filter(Boolean)
            : [];
        const remoteBranches = remoteResult.success && remoteResult.stdout.trim()
            ? remoteResult.stdout.trim().split('\n').filter(b => b && b.includes('/') && !b.endsWith('/HEAD'))
            : [];

        if (localBranches.length > 0 || remoteBranches.length > 0) {
            const selectedBranch = await new Promise<string | undefined>((resolve) => {
                addDirBranchResolveRef.current = resolve;
                const localSet = new Set(localBranches);
                const items: ActionMenuItem[] = localBranches.map(branch => ({
                    label: branch,
                    selected: branch === currentBranch,
                    onPress: () => {
                        resolve(branch);
                        setAddDirBranchMenu({ visible: false, items: [] });
                        addDirBranchResolveRef.current = null;
                    },
                }));
                for (const remote of remoteBranches) {
                    const shortName = remote.includes('/') ? remote.substring(remote.indexOf('/') + 1) : remote;
                    if (!localSet.has(shortName)) {
                        items.push({
                            label: remote,
                            onPress: () => {
                                resolve(remote);
                                setAddDirBranchMenu({ visible: false, items: [] });
                                addDirBranchResolveRef.current = null;
                            },
                            secondary: true,
                        });
                    }
                }
                setAddDirBranchMenu({ visible: true, items });
            });
            const finalBranch = selectedBranch ?? currentBranch;
            setSelectedRepos(prev => [...prev, { repo: repoToSelect, targetBranch: finalBranch }]);
            if (finalBranch) persistDefaultBranch(selectedMachineId, repoToSelect.id, finalBranch);
        } else {
            setSelectedRepos(prev => [...prev, { repo: repoToSelect, targetBranch: currentBranch }]);
            if (currentBranch) persistDefaultBranch(selectedMachineId, repoToSelect.id, currentBranch);
        }
    }, [selectedMachineId, persistDefaultBranch]);

    const handleAddDirectory = React.useCallback(() => {
        folderPickerRef.current?.present();
    }, []);

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
                // Check if this agent is available
                const isAvailable = cliAvailability[requiredAgent] !== false;

                if (isAvailable) {
                    setAgentType(requiredAgent);
                }
                // If the required CLI is unavailable, keep current agent (profile will show as unavailable)
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
    }, [profileMap, cliAvailability.claude, cliAvailability.codex, cliAvailability.gemini]);

    // Reset permission mode to 'default' when agent type changes and current mode is invalid for new agent
    React.useEffect(() => {
        const validClaudeModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo'];
        const validCodexGeminiModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

        const isValidForCurrentAgent = (agentType === 'codex' || agentType === 'gemini')
            ? validCodexGeminiModes.includes(permissionMode)
            : validClaudeModes.includes(permissionMode);

        if (!isValidForCurrentAgent) {
            setPermissionMode('default');
        }
    }, [agentType, permissionMode]);

    // Restore saved model mode when agent type changes
    React.useEffect(() => {
        const saved = storage.getState().settings.lastUsedModelMode;
        const savedObj = typeof saved === 'object' && saved !== null ? saved as Record<string, string> : {};
        const savedMode = savedObj[agentType];
        if (savedMode && isModelModeForAgent(agentType, savedMode)) {
            setModelMode(savedMode as ModelMode);
        } else if (!isModelModeForAgent(agentType, modelMode)) {
            setModelMode('default');
        }
    }, [agentType]);

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
        const supportedCliLabels = ([
            ['claude', 'Claude'],
            ['codex', 'Codex'],
            ['gemini', 'Gemini'],
        ] as const)
            .filter(([agent]) => profile.compatibility[agent])
            .map(([, label]) => label);

        if (supportedCliLabels.length === 3) {
            parts.push('Claude, Codex & Gemini CLI');
        } else if (supportedCliLabels.length === 2) {
            parts.push(`${supportedCliLabels[0]} & ${supportedCliLabels[1]} CLI`);
        } else if (supportedCliLabels.length === 1) {
            parts.push(`${supportedCliLabels[0]} CLI`);
        }

        // Add warning only if CLI not detected
        if (!availability.available && availability.reason?.startsWith('cli-not-detected:')) {
            const cli = availability.reason.split(':')[1];
            const cliName = cli === 'claude' ? 'Claude' : cli === 'codex' ? 'Codex' : 'Gemini';
            parts.push(`⚠️ ${cliName} CLI not detected`);
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
    const handleCreateSession = React.useCallback(async (promptSnapshot?: string) => {
        const promptToSend = (promptSnapshot ?? sessionPrompt).trim();
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
            let worktreeBranchName: string | undefined;
            let workspaceRepos: Array<{ repoId?: string; path: string; basePath: string; branchName: string; targetBranch?: string; displayName?: string }> | undefined;
            let workspacePath: string | undefined;
            let repoScripts: Array<{ repoDisplayName: string; worktreePath: string; setupScript?: string; parallelSetup?: boolean; cleanupScript?: string; archiveScript?: string; devServerScript?: string }> | undefined;

            // Handle worktree creation
            if (sessionType === 'worktree') {
                if (selectedRepos.length > 0) {
                    // Multi-repo workspace creation
                    const repoInputs: WorkspaceRepoInput[] = selectedRepos.map(sr => ({
                        repo: sr.repo,
                        targetBranch: sr.targetBranch,
                    }));
                    const wsResult = await createWorkspace(selectedMachineId, repoInputs);
                    if (!wsResult.success) {
                        Modal.alert(t('common.error'), t('newSession.worktree.failed', { error: wsResult.error || 'Unknown error' }));
                        setIsCreating(false);
                        return;
                    }
                    workspaceRepos = wsResult.repos;
                    workspacePath = wsResult.workspacePath;

                    // Build repoScripts from registered repo config
                    const allRegisteredRepos = storage.getState().registeredRepos[selectedMachineId] || [];

                    // CWD: single repo -> inside repo dir (+ defaultWorkingDir), multi repo -> workspace root
                    if (wsResult.repos.length === 1) {
                        const r = wsResult.repos[0];
                        const registered = r.repoId ? allRegisteredRepos.find(rr => rr.id === r.repoId) : undefined;
                        const subdir = registered?.defaultWorkingDir;
                        actualPath = subdir ? `${r.path}/${subdir}` : r.path;
                    } else {
                        actualPath = wsResult.workspacePath;
                    }
                    repoScripts = wsResult.repos.map(r => {
                        const registered = r.repoId ? allRegisteredRepos.find(rr => rr.id === r.repoId) : undefined;
                        return {
                            repoDisplayName: r.displayName || '',
                            worktreePath: r.path,
                            setupScript: registered?.setupScript,
                            parallelSetup: registered?.parallelSetup,
                            cleanupScript: registered?.cleanupScript,
                            archiveScript: registered?.archiveScript,
                            devServerScript: registered?.devServerScript,
                        };
                    });
                } else {
                    // Legacy single-repo worktree
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
                    worktreeBranchName = worktreeResult.branchName;
                }
            }

            // Save settings
            const updatedPaths = [{ machineId: selectedMachineId, path: selectedPath }, ...recentMachinePaths.filter(rp => rp.machineId !== selectedMachineId)].slice(0, 10);
            sync.applySettings({
                recentMachinePaths: updatedPaths,
                lastUsedAgent: agentType,
                lastUsedProfile: selectedProfileId,
                lastUsedPermissionMode: permissionMode,
            });

            // Get environment variables from selected profile
            let environmentVariables = undefined;
            if (selectedProfileId) {
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
                environmentVariables,
                // Pass worktree metadata so CLI includes it in initial metadata (avoids race condition)
                ...(sessionType === 'worktree' && worktreeBranchName ? {
                    worktreeBasePath: selectedPath,
                    worktreeBranchName,
                } : {}),
                // Pass workspace metadata for multi-repo sessions
                ...(workspaceRepos ? { workspaceRepos, workspacePath, repoScripts } : {}),
                // Pass through external MCP servers and session title
                ...(tempSessionData?.mcpServers ? { mcpServers: tempSessionData.mcpServers } : {}),
                ...(tempSessionData?.sessionTitle ? { sessionTitle: tempSessionData.sessionTitle } : {}),
            });

            if ('sessionId' in result && result.sessionId) {
                // Clear draft state on successful session creation
                clearNewSessionDraft();

                await sync.refreshSessions();

                // Write external context and session icon to metadata
                if (tempSessionData?.externalContext || tempSessionData?.sessionIcon) {
                    const freshSession = storage.getState().sessions[result.sessionId];
                    if (freshSession?.metadata) {
                        try {
                            await sessionUpdateMetadataFields(
                                result.sessionId,
                                freshSession.metadata,
                                {
                                    ...(tempSessionData.externalContext ? { externalContext: tempSessionData.externalContext } : {}),
                                    ...(tempSessionData.sessionIcon ? { sessionIcon: tempSessionData.sessionIcon } : {}),
                                },
                                freshSession.metadataVersion
                            );
                        } catch (e) {
                            console.warn('Failed to write external context to session metadata:', e);
                        }
                    } else {
                        console.warn('Session metadata not available after refresh, external context not written for session:', result.sessionId);
                    }
                }

                // Set permission mode and model mode on the session
                storage.getState().updateSessionPermissionMode(result.sessionId, permissionMode);
                if (modelMode && modelMode !== 'default') {
                    storage.getState().updateSessionModelMode(result.sessionId, modelMode);
                }

                // Send initial message if provided
                if (promptToSend || images.length > 0) {
                    await sync.sendMessage(result.sessionId, promptToSend, undefined, images.length > 0 ? images : undefined);
                    clearImages();
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
    }, [selectedMachineId, selectedPath, sessionPrompt, sessionType, agentType, selectedProfileId, permissionMode, modelMode, recentMachinePaths, profileMap, router, images, clearImages, tempSessionData, selectedRepos]);

    const screenWidth = useWindowDimensions().width;

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

    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    // Skip draft saving when opened via external context (e.g. DooTask "Start AI Session")
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        if (tempSessionData) return;
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
    }, [tempSessionData, sessionPrompt, selectedMachineId, selectedPath, agentType, permissionMode, sessionType]);

    const externalContextBanner = tempSessionData?.externalContext ? (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 10,
            gap: 8,
            backgroundColor: theme.colors.surface,
            borderRadius: 10,
            marginBottom: 8,
        }}>
            {tempSessionData.sessionIcon ? (() => {
                const resolved = resolveSessionIcon(tempSessionData.sessionIcon);
                return resolved.type === 'image' ? (
                    <Image
                        source={resolved.source}
                        style={{ width: 28, height: 28, borderRadius: 6 }}
                        contentFit="cover"
                    />
                ) : (
                    <Text style={{ fontSize: 18 }}>{resolved.value}</Text>
                );
            })() : null}
            <View style={{ flex: 1 }}>
                <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary }}>
                    {tempSessionData.externalContext.source === 'dootask' ? t('dootask.title') : tempSessionData.externalContext.source}
                </Text>
                {tempSessionData.externalContext.title ? (
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: theme.colors.text }} numberOfLines={1}>
                        {tempSessionData.externalContext.title}
                    </Text>
                ) : null}
            </View>
        </View>
    ) : null;

    // ========================================================================
    // CONTROL A: Simpler AgentInput-driven layout (flag OFF)
    // Shows machine/path selection via chips that navigate to picker screens
    // ========================================================================
    if (!useEnhancedSessionWizard) {
        return (
            <View style={[styles.container, Platform.OS !== 'web' && { paddingTop: 40 }]}>
                <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                    <Animated.View style={animatedInputStyle}>
                    {/* External context banner */}
                    {externalContextBanner && (
                        <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
                            <View style={{ maxWidth: layout.maxWidth, width: '100%', paddingHorizontal: screenWidth > 700 ? 16 : 0, alignSelf: 'center' }}>
                                {externalContextBanner}
                            </View>
                        </View>
                    )}

                    {/* Session type selector */}
                    <View style={{ paddingHorizontal: 16, marginBottom: 16 }}>
                        <View style={{ maxWidth: layout.maxWidth, width: '100%', paddingHorizontal: screenWidth > 700 ? 16 : 0, alignSelf: 'center' }}>
                            <SessionTypeSelector
                                value={sessionType}
                                onChange={setSessionType}
                            />
                        </View>
                    </View>

                    {/* Repo picker for worktree mode */}
                    {sessionType === 'worktree' && selectedMachineId && (
                        <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
                            <View style={{ maxWidth: layout.maxWidth, width: '100%', paddingHorizontal: screenWidth > 700 ? 16 : 0, alignSelf: 'center' }}>
                                <RepoPickerBar
                                    machineId={selectedMachineId}
                                    selectedRepos={selectedRepos}
                                    onReposChange={setSelectedRepos}
                                    onAddDirectory={handleAddDirectory}
                                />
                            </View>
                        </View>
                    )}

                    {/* AgentInput with inline chips - sticky at bottom */}
                    <View style={{ paddingHorizontal: screenWidth > 700 ? 16 : 8, paddingBottom: safeArea.bottom }}>
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
                                onModelModeChange={handleModelModeChange}
                                connectionStatus={connectionStatus}
                                machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                                onMachineClick={handleMachineClick}
                                currentPath={sessionType === 'worktree' && selectedRepos.length > 0 ? t('machine.worktreeAutoPath') : formatPathRelativeToHome(selectedPath, selectedMachine?.metadata?.homeDir)}
                                onPathClick={sessionType === 'worktree' && selectedRepos.length > 0 ? undefined : handlePathClick}
                                images={images}
                                onImagesChange={(newImages) => {
                                    const currentUris = new Set(newImages.map(img => img.uri));
                                    images.forEach((img, index) => {
                                        if (!currentUris.has(img.uri)) {
                                            removeImage(index);
                                        }
                                    });
                                }}
                                onImageButtonPress={handleImageButtonPress}
                                supportsImages={supportsImages}
                                onImageDrop={handleImageDrop}
                            />
                        </View>
                    </View>
                    </Animated.View>
                </View>

                {/* Hidden file input for web image upload */}
                {Platform.OS === 'web' && (
                    <input
                        ref={fileInputRef as any}
                        type="file"
                        accept="image/jpeg,image/png"
                        multiple
                        style={{ display: 'none' }}
                        onChange={handleFileInputChange as any}
                    />
                )}

                {/* Image Picker Sheet (native) */}
                <ActionMenuModal
                    visible={imagePickerSheetVisible}
                    items={imagePickerMenuItems}
                    onClose={() => setImagePickerSheetVisible(false)}
                    deferItemPress
                />

                {/* Branch picker for Add Directory flow */}
                <ActionMenuModal
                    visible={addDirBranchMenu.visible}
                    title={t('newSession.repos.targetBranch')}
                    items={addDirBranchMenu.items}
                    onClose={() => {
                        setAddDirBranchMenu({ visible: false, items: [] });
                        addDirBranchResolveRef.current?.(undefined);
                        addDirBranchResolveRef.current = null;
                    }}
                />

                {/* Folder picker for Add Directory flow */}
                {selectedMachineId && (
                    <FolderPickerSheet
                        ref={folderPickerRef}
                        machineId={selectedMachineId}
                        homeDir={selectedMachine?.metadata?.homeDir}
                        onSelect={handleFolderSelected}
                    />
                )}
            </View>
        );
    }

    // ========================================================================
    // VARIANT B: Enhanced profile-first wizard (flag ON)
    // Full wizard with numbered sections, profile management, CLI detection
    // ========================================================================
    return (
        <View style={styles.container}>
            <Animated.View style={[{ flex: 1 }, animatedInputStyle]}>
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
                            {/* External context banner */}
                            {externalContextBanner}

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
                                    </View>
                                </View>
                            )}

                            {/* Section 1: Profile Management */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 12 }}>
                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>1.</Text>
                                <Ionicons name="person-outline" size={18} color={theme.colors.text} />
                                <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('wizard.step1Title')}</Text>
                            </View>
                            <Text style={styles.sectionDescription}>
                                {t('wizard.step1Description')}
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
                                                {t('wizard.cliNotDetected', { name: 'Claude' })}
                                            </Text>
                                            <View style={{ flex: 1, minWidth: 20 }} />
                                            <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('wizard.dontShowFor')}
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
                                                    {t('wizard.thisMachine')}
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
                                                    {t('wizard.anyMachine')}
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
                                            {t('wizard.installClaude')} •
                                        </Text>
                                        <Pressable onPress={() => {
                                            if (Platform.OS === 'web') {
                                                window.open('https://docs.anthropic.com/en/docs/claude-code/installation', '_blank');
                                            }
                                        }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                {t('wizard.viewInstallGuide')}
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
                                                {t('wizard.cliNotDetected', { name: 'Codex' })}
                                            </Text>
                                            <View style={{ flex: 1, minWidth: 20 }} />
                                            <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('wizard.dontShowFor')}
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
                                                    {t('wizard.thisMachine')}
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
                                                    {t('wizard.anyMachine')}
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
                                            {t('wizard.installCodex')} •
                                        </Text>
                                        <Pressable onPress={() => {
                                            if (Platform.OS === 'web') {
                                                window.open('https://github.com/openai/openai-codex', '_blank');
                                            }
                                        }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                {t('wizard.viewInstallGuide')}
                                            </Text>
                                        </Pressable>
                                    </View>
                                </View>
                            )}

                            {selectedMachineId && cliAvailability.gemini === false && !isWarningDismissed('gemini') && !hiddenBanners.gemini && (
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
                                                {t('wizard.cliNotDetected', { name: 'Gemini' })}
                                            </Text>
                                            <View style={{ flex: 1, minWidth: 20 }} />
                                            <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('wizard.dontShowFor')}
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
                                                    {t('wizard.thisMachine')}
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
                                                    {t('wizard.anyMachine')}
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
                                            {t('wizard.installGemini')} •
                                        </Text>
                                        <Pressable onPress={() => {
                                            if (Platform.OS === 'web') {
                                                window.open('https://ai.google.dev/gemini-api/docs/get-started', '_blank');
                                            }
                                        }}>
                                            <Text style={{ fontSize: 11, color: theme.colors.textLink, ...Typography.default() }}>
                                                {t('wizard.viewGeminiDocs')}
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
                                        <View style={styles.profileIcon}>
                                            <Ionicons name="person" size={12} color="#FFFFFF" />
                                        </View>
                                        <View style={{ flex: 1, marginRight: 12 }}>
                                            <Text style={styles.profileListName}>{profile.name}</Text>
                                            <Text style={styles.profileListDetails} numberOfLines={2}>
                                                {getProfileSubtitle(profile)}
                                            </Text>
                                        </View>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
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
                                            <Ionicons name="star" size={12} color="#FFFFFF" />
                                        </View>
                                        <View style={{ flex: 1, marginRight: 12 }}>
                                            <Text style={styles.profileListName}>{profile.name}</Text>
                                            <Text style={styles.profileListDetails} numberOfLines={2}>
                                                {getProfileSubtitle(profile)}
                                            </Text>
                                        </View>
                                        <Pressable
                                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                            onPress={(e) => {
                                                e.stopPropagation();
                                                handleEditProfile(profile);
                                            }}
                                        >
                                            <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                        </Pressable>
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
                                        {t('wizard.add')}
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
                                        {t('wizard.duplicate')}
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
                                        {t('wizard.delete')}
                                    </Text>
                                </Pressable>
                            </View>

                            {/* Section 2: Machine Selection */}
                            <View ref={machineSectionRef}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 12 }}>
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>2.</Text>
                                    <Ionicons name="desktop-outline" size={18} color={theme.colors.text} />
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('wizard.step2Title')}</Text>
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
                                    searchPlaceholder: t('wizard.filterMachines'),
                                    recentSectionTitle: t('wizard.recentMachines'),
                                    favoritesSectionTitle: t('wizard.favoriteMachines'),
                                    noItemsMessage: t('wizard.noMachinesAvailable'),
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

                            {/* Section 3: Session Mode */}
                            <View>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 12 }}>
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>3.</Text>
                                    <Ionicons name="git-branch-outline" size={18} color={theme.colors.text} />
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('wizard.step3Title')}</Text>
                                </View>
                                <Text style={styles.sectionDescription}>
                                    {t('wizard.step3Description')}
                                </Text>
                                <View style={{ marginBottom: 12 }}>
                                    <SessionTypeSelector value={sessionType} onChange={setSessionType} />
                                    {sessionType === 'worktree' && selectedMachineId && (
                                        <View style={{ marginTop: 8 }}>
                                            <RepoPickerBar
                                                machineId={selectedMachineId}
                                                selectedRepos={selectedRepos}
                                                onReposChange={setSelectedRepos}
                                                onAddDirectory={handleAddDirectory}
                                            />
                                        </View>
                                    )}
                                </View>
                            </View>

                            {/* Section 4: Working Directory */}
                            <View ref={pathSectionRef}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 12 }}>
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>4.</Text>
                                    <Ionicons name="folder-outline" size={18} color={theme.colors.text} />
                                    <Text style={[styles.sectionHeader, { marginBottom: 0, marginTop: 0 }]}>{t('wizard.step4Title')}</Text>
                                </View>
                            </View>

                            {sessionType === 'worktree' && selectedRepos.length > 0 ? (
                                <Text style={[styles.sectionDescription, { marginBottom: 24 }]}>
                                    {t('machine.worktreeAutoPath')}
                                </Text>
                            ) : (
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
                                    searchPlaceholder: t('wizard.filterDirectories'),
                                    recentSectionTitle: t('wizard.recentDirectories'),
                                    favoritesSectionTitle: t('wizard.favoriteDirectories'),
                                    noItemsMessage: t('wizard.noRecentDirectories'),
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
                            )}

                            {/* Section 5: Permission Mode */}
                            <View ref={permissionSectionRef}>
                                <Text style={styles.sectionHeader}>5. {t('wizard.step5Title')}</Text>
                            </View>
                            <ItemGroup title="">
                                {(agentType === 'codex'
                                    ? [
                                        { value: 'default' as PermissionMode, label: t('wizard.permDefault'), description: t('wizard.permDefaultDesc'), icon: 'shield-outline' },
                                        { value: 'read-only' as PermissionMode, label: t('wizard.permReadOnly'), description: t('wizard.permReadOnlyDesc'), icon: 'eye-outline' },
                                        { value: 'safe-yolo' as PermissionMode, label: t('wizard.permSafeYolo'), description: t('wizard.permSafeYoloDesc'), icon: 'shield-checkmark-outline' },
                                        { value: 'yolo' as PermissionMode, label: t('wizard.permYolo'), description: t('wizard.permFullAccess'), icon: 'flash-outline' },
                                    ]
                                    : [
                                        { value: 'default' as PermissionMode, label: t('wizard.permDefault'), description: t('wizard.permDefaultDesc'), icon: 'shield-outline' },
                                        { value: 'acceptEdits' as PermissionMode, label: t('wizard.permAcceptEdits'), description: t('wizard.permAcceptEditsDesc'), icon: 'checkmark-outline' },
                                        { value: 'plan' as PermissionMode, label: t('wizard.permPlan'), description: t('wizard.permPlanDesc'), icon: 'list-outline' },
                                        { value: 'bypassPermissions' as PermissionMode, label: t('wizard.permBypass'), description: t('wizard.permBypassDesc'), icon: 'flash-outline' },
                                        { value: 'yolo' as PermissionMode, label: t('wizard.permYolo'), description: t('wizard.permYoloDesc'), icon: 'warning-outline' },
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
                                                color={permissionMode === option.value ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                            />
                                        }
                                        rightElement={null}
                                        onPress={() => setPermissionMode(option.value)}
                                        showChevron={false}
                                        selected={permissionMode === option.value}
                                        hideSelectedCheckmark={true}
                                        showDivider={index < array.length - 1}
                                        style={permissionMode === option.value ? {
                                            borderWidth: 2,
                                            borderColor: theme.colors.button.primary.background,
                                            borderRadius: Platform.select({ ios: 10, default: 16 }),
                                        } : undefined}
                                    />
                                ))}
                            </ItemGroup>

                        </View>
                    </View>
                </View>
                </ScrollView>

                {/* Section 5: AgentInput - Sticky at bottom */}
                <View style={{ paddingHorizontal: screenWidth > 700 ? 16 : 8, paddingBottom: safeArea.bottom }}>
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
                            onModelModeChange={handleModelModeChange}
                            connectionStatus={connectionStatus}
                            machineName={selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host}
                            onMachineClick={handleAgentInputMachineClick}
                            currentPath={sessionType === 'worktree' && selectedRepos.length > 0 ? undefined : formatPathRelativeToHome(selectedPath, selectedMachine?.metadata?.homeDir)}
                            onPathClick={sessionType === 'worktree' && selectedRepos.length > 0 ? undefined : handleAgentInputPathClick}
                            profileId={selectedProfileId}
                            onProfileClick={handleAgentInputProfileClick}
                            images={images}
                            onImagesChange={(newImages) => {
                                const currentUris = new Set(newImages.map(img => img.uri));
                                images.forEach((img, index) => {
                                    if (!currentUris.has(img.uri)) {
                                        removeImage(index);
                                    }
                                });
                            }}
                            onImageButtonPress={handleImageButtonPress}
                            supportsImages={supportsImages}
                            onImageDrop={handleImageDrop}
                        />
                    </View>
                </View>

                {/* Hidden file input for web image upload */}
                {Platform.OS === 'web' && (
                    <input
                        ref={fileInputRef as any}
                        type="file"
                        accept="image/jpeg,image/png"
                        multiple
                        style={{ display: 'none' }}
                        onChange={handleFileInputChange as any}
                    />
                )}

                {/* Image Picker Sheet (native) */}
                <ActionMenuModal
                    visible={imagePickerSheetVisible}
                    items={imagePickerMenuItems}
                    onClose={() => setImagePickerSheetVisible(false)}
                    deferItemPress
                />

                {/* Branch picker for Add Directory flow */}
                <ActionMenuModal
                    visible={addDirBranchMenu.visible}
                    title={t('newSession.repos.targetBranch')}
                    items={addDirBranchMenu.items}
                    onClose={() => {
                        setAddDirBranchMenu({ visible: false, items: [] });
                        addDirBranchResolveRef.current?.(undefined);
                        addDirBranchResolveRef.current = null;
                    }}
                />

                {/* Folder picker for Add Directory flow */}
                {selectedMachineId && (
                    <FolderPickerSheet
                        ref={folderPickerRef}
                        machineId={selectedMachineId}
                        homeDir={selectedMachine?.metadata?.homeDir}
                        onSelect={handleFolderSelected}
                    />
                )}
            </Animated.View>
        </View>
    );
}

export default React.memo(NewSessionWizard);
