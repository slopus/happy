import React from 'react';
import { View, Platform, useWindowDimensions } from 'react-native';
import { useAllMachines, storage, useSetting, useSettingMutable, useSettings } from '@/sync/storage';
import { useRouter, useLocalSearchParams, useNavigation, usePathname } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { getTempData, type NewSessionData } from '@/utils/tempDataStore';
import type { PermissionMode, ModelMode } from '@/sync/permissionTypes';
import { mapPermissionModeAcrossAgents } from '@/sync/permissionMapping';
import { readAccountPermissionDefaults, resolveNewSessionDefaultPermissionMode } from '@/sync/permissionDefaults';
import { AIBackendProfile, getProfileEnvironmentVariables, isProfileCompatibleWithAgent } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES, getProfilePrimaryCli, getProfileSupportedAgentIds, isProfileCompatibleWithAnyAgent } from '@/sync/profileUtils';
import { useCLIDetection } from '@/hooks/useCLIDetection';
import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, resolveAgentIdFromCliDetectKey, type AgentId } from '@/agents/catalog';
import { useEnabledAgentIds } from '@/agents/useEnabledAgentIds';
import { applyCliWarningDismissal, isCliWarningDismissed } from '@/agents/cliWarnings';

import { isMachineOnline } from '@/utils/machineUtils';
import { loadNewSessionDraft, saveNewSessionDraft } from '@/sync/persistence';
import { EnvironmentVariablesPreviewModal } from '@/components/sessions/new/components/EnvironmentVariablesPreviewModal';
import { consumeProfileIdParam, consumeSecretIdParam } from '@/profileRouteParams';
import { getModelOptionsForAgentType } from '@/sync/modelOptions';
import { useFocusEffect } from '@react-navigation/native';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';
import { useMachineEnvPresence } from '@/hooks/useMachineEnvPresence';
import { InteractionManager } from 'react-native';
import { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale, useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { getInstallableDepRegistryEntries } from '@/capabilities/installableDepsRegistry';
import { resolveTerminalSpawnOptions } from '@/sync/terminalSettings';
import type { CapabilityId } from '@/sync/capabilitiesProtocol';
import {
    buildResumeCapabilityOptionsFromUiState,
    getAgentResumeExperimentsFromSettings,
    getAllowExperimentalResumeByAgentIdFromUiState,
    buildNewSessionOptionsFromUiState,
    getNewSessionAgentInputExtraActionChips,
    getNewSessionRelevantInstallableDepKeys,
    getResumeRuntimeSupportPrefetchPlan,
} from '@/agents/catalog';
import type { SecretChoiceByProfileIdByEnvVarName } from '@/utils/secrets/secretRequirementApply';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { computeNewSessionInputMaxHeight } from '@/components/sessions/agentInput/inputMaxHeight';
import { useProfileMap, transformProfileToEnvironmentVars } from '@/components/sessions/new/modules/profileHelpers';
import { newSessionScreenStyles } from '@/components/sessions/new/newSessionScreenStyles';
import { useSecretRequirementFlow } from '@/components/sessions/new/hooks/useSecretRequirementFlow';
import { useNewSessionCapabilitiesPrefetch } from '@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch';
import { useNewSessionDraftAutoPersist } from '@/components/sessions/new/hooks/useNewSessionDraftAutoPersist';
import { useCreateNewSession } from '@/components/sessions/new/hooks/useCreateNewSession';
import { useNewSessionWizardProps } from '@/components/sessions/new/hooks/useNewSessionWizardProps';

// Configuration constants
const RECENT_PATHS_DEFAULT_VISIBLE = 5;
const styles = newSessionScreenStyles;

export type NewSessionScreenModel =
    | Readonly<{
        variant: 'simple';
        popoverBoundaryRef: React.RefObject<View>;
        simpleProps: any;
    }>
    | Readonly<{
        variant: 'wizard';
        popoverBoundaryRef: React.RefObject<View>;
        wizardProps: Readonly<{
            layout: any;
            profiles: any;
            agent: any;
            machine: any;
            footer: any;
        }>;
    }>;

export function useNewSessionScreenModel(): NewSessionScreenModel {
    const { theme, rt } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const pathname = usePathname();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;
    const popoverBoundaryRef = React.useRef<View>(null!);

    const newSessionSidePadding = 16;
    const newSessionBottomPadding = Math.max(screenWidth < 420 ? 8 : 16, safeArea.bottom);
    const {
        prompt,
        dataId,
        machineId: machineIdParam,
        path: pathParam,
        profileId: profileIdParam,
        resumeSessionId: resumeSessionIdParam,
        secretId: secretIdParam,
        secretSessionOnlyId,
        secretRequirementResultId,
    } = useLocalSearchParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string;
        path?: string;
        profileId?: string;
        resumeSessionId?: string;
        secretId?: string;
        secretSessionOnlyId?: string;
        secretRequirementResultId?: string;
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

    const [resumeSessionId, setResumeSessionId] = React.useState(() => {
        if (typeof tempSessionData?.resumeSessionId === 'string') {
            return tempSessionData.resumeSessionId;
        }
        if (typeof persistedDraft?.resumeSessionId === 'string') {
            return persistedDraft.resumeSessionId;
        }
        return typeof resumeSessionIdParam === 'string' ? resumeSessionIdParam : '';
    });

    const [agentNewSessionOptionStateByAgentId, setAgentNewSessionOptionStateByAgentId] = React.useState<
        Partial<Record<AgentId, Record<string, unknown>>>
    >(() => {
        const raw = (persistedDraft as any)?.agentNewSessionOptionStateByAgentId;
        return raw && typeof raw === 'object' ? (raw as any) : {};
    });

    // Settings and state
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');

    // A/B Test Flag - determines which wizard UI to show
    // Control A (false): Simpler AgentInput-driven layout
    // Variant B (true): Enhanced profile-first wizard with sections
    const useEnhancedSessionWizard = useSetting('useEnhancedSessionWizard');

    const previousHappyRouteRef = React.useRef<string | undefined>(undefined);
    const hasCapturedPreviousHappyRouteRef = React.useRef(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;

        const root = document.documentElement;
        if (!hasCapturedPreviousHappyRouteRef.current) {
            previousHappyRouteRef.current = root.dataset.happyRoute;
            hasCapturedPreviousHappyRouteRef.current = true;
        }

        const previous = previousHappyRouteRef.current;
        if (pathname === '/new') {
            root.dataset.happyRoute = 'new';
        } else {
            if (previous === undefined) {
                delete root.dataset.happyRoute;
            } else {
                root.dataset.happyRoute = previous;
            }
        }
        return () => {
            if (pathname !== '/new') return;
            if (root.dataset.happyRoute !== 'new') return;
            if (previous === undefined) {
                delete root.dataset.happyRoute;
            } else {
                root.dataset.happyRoute = previous;
            }
        };
    }, [pathname]);

    const sessionPromptInputMaxHeight = React.useMemo(() => {
        return computeNewSessionInputMaxHeight({
            useEnhancedSessionWizard,
            screenHeight,
            keyboardHeight,
        });
    }, [keyboardHeight, screenHeight, useEnhancedSessionWizard]);
    const useProfiles = useSetting('useProfiles');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const sessionDefaultPermissionModeByAgent = useSetting('sessionDefaultPermissionModeByAgent');
    const settings = useSettings();
    const experimentsEnabled = settings.experiments;
    const experimentalAgents = useSetting('experimentalAgents');
    const expSessionType = useSetting('expSessionType');
    const resumeCapabilityOptions = React.useMemo(() => {
        return buildResumeCapabilityOptionsFromUiState({
            settings,
            results: undefined,
        });
    }, [settings]);
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const lastUsedProfile = useSetting('lastUsedProfile');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');
    const [dismissedCLIWarnings, setDismissedCLIWarnings] = useSettingMutable('dismissedCLIWarnings');
    const terminalUseTmux = useSetting('sessionUseTmux');
    const terminalTmuxByMachineId = useSetting('sessionTmuxByMachineId');

    const enabledAgentIds = useEnabledAgentIds();

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

    /**
     * Per-profile per-env-var secret selections for the current flow (multi-secret).
     * This allows the user to resolve secrets for multiple profiles without switching selection.
     *
     * - value === '' means “prefer machine env” for that env var (disallow default saved).
     * - value === savedSecretId means “use saved secret”
     * - null/undefined means “no explicit choice yet”
     */
    const [selectedSecretIdByProfileIdByEnvVarName, setSelectedSecretIdByProfileIdByEnvVarName] = React.useState<SecretChoiceByProfileIdByEnvVarName>(() => {
        const raw = persistedDraft?.selectedSecretIdByProfileIdByEnvVarName;
        if (!raw || typeof raw !== 'object') return {};
        const out: SecretChoiceByProfileIdByEnvVarName = {};
        for (const [profileId, byEnv] of Object.entries(raw)) {
            if (!byEnv || typeof byEnv !== 'object') continue;
            const inner: Record<string, string | null> = {};
            for (const [envVarName, v] of Object.entries(byEnv as any)) {
                if (v === null) inner[envVarName] = null;
                else if (typeof v === 'string') inner[envVarName] = v;
            }
            if (Object.keys(inner).length > 0) out[profileId] = inner;
        }
        return out;
    });
    /**
     * Session-only secrets (never persisted in plaintext), keyed by profileId then env var name.
     */
    const [sessionOnlySecretValueByProfileIdByEnvVarName, setSessionOnlySecretValueByProfileIdByEnvVarName] = React.useState<SecretChoiceByProfileIdByEnvVarName>(() => {
        const raw = persistedDraft?.sessionOnlySecretValueEncByProfileIdByEnvVarName;
        if (!raw || typeof raw !== 'object') return {};
        const out: SecretChoiceByProfileIdByEnvVarName = {};
        for (const [profileId, byEnv] of Object.entries(raw)) {
            if (!byEnv || typeof byEnv !== 'object') continue;
            const inner: Record<string, string | null> = {};
            for (const [envVarName, enc] of Object.entries(byEnv as any)) {
                const decrypted = enc ? sync.decryptSecretValue(enc as any) : null;
                if (typeof decrypted === 'string' && decrypted.trim().length > 0) {
                    inner[envVarName] = decrypted;
                }
            }
            if (Object.keys(inner).length > 0) out[profileId] = inner;
        }
        return out;
    });

    const prevProfileIdBeforeSecretPromptRef = React.useRef<string | null>(null);
    const lastSecretPromptKeyRef = React.useRef<string | null>(null);
    const suppressNextSecretAutoPromptKeyRef = React.useRef<string | null>(null);
    const isSecretRequirementModalOpenRef = React.useRef(false);

    const getSessionOnlySecretValueEncByProfileIdByEnvVarName = React.useCallback(() => {
        const out: Record<string, Record<string, any>> = {};
        for (const [profileId, byEnv] of Object.entries(sessionOnlySecretValueByProfileIdByEnvVarName)) {
            if (!byEnv || typeof byEnv !== 'object') continue;
            for (const [envVarName, value] of Object.entries(byEnv)) {
                const v = typeof value === 'string' ? value.trim() : '';
                if (!v) continue;
                const enc = sync.encryptSecretValue(v);
                if (!enc) continue;
                if (!out[profileId]) out[profileId] = {};
                out[profileId]![envVarName] = enc;
            }
        }
        return Object.keys(out).length > 0 ? out : null;
    }, [sessionOnlySecretValueByProfileIdByEnvVarName]);

    React.useEffect(() => {
        if (!useProfiles && selectedProfileId !== null) {
            setSelectedProfileId(null);
        }
    }, [useProfiles, selectedProfileId]);

    React.useEffect(() => {
        if (!useProfiles) return;
        if (!selectedProfileId) return;
        const selected = profileMap.get(selectedProfileId) ?? getBuiltInProfile(selectedProfileId);
        if (!selected) {
            setSelectedProfileId(null);
            return;
        }
        if (isProfileCompatibleWithAnyAgent(selected, enabledAgentIds)) return;
        setSelectedProfileId(null);
    }, [enabledAgentIds, profileMap, selectedProfileId, useProfiles]);

    // AgentInput autocomplete is unused on this screen today, but passing a new
    // function/array each render forces autocomplete hooks to re-sync.
    // Keep these stable to avoid unnecessary work during taps/selection changes.
    const emptyAutocompletePrefixes = React.useMemo(() => [], []);
    const emptyAutocompleteSuggestions = React.useCallback(async () => [], []);

    const [agentType, setAgentType] = React.useState<AgentId>(() => {
        const fromTemp = tempSessionData?.agentType;
        if (isAgentId(fromTemp) && enabledAgentIds.includes(fromTemp)) {
            return fromTemp;
        }
        if (isAgentId(lastUsedAgent) && enabledAgentIds.includes(lastUsedAgent)) {
            return lastUsedAgent;
        }
        return enabledAgentIds[0] ?? DEFAULT_AGENT_ID;
    });

    React.useEffect(() => {
        if (enabledAgentIds.includes(agentType)) return;
        setAgentType(enabledAgentIds[0] ?? DEFAULT_AGENT_ID);
    }, [agentType, enabledAgentIds]);

    // Agent cycling handler (cycles through enabled agents)
    // Note: Does NOT persist immediately - persistence is handled by useEffect below
    const handleAgentCycle = React.useCallback(() => {
        setAgentType(prev => {
            const enabled = enabledAgentIds;
            if (enabled.length === 0) return prev;
            const idx = enabled.indexOf(prev);
            if (idx < 0) return enabled[0] ?? prev;
            return enabled[(idx + 1) % enabled.length] ?? prev;
        });
    }, [enabledAgentIds]);

    // Persist agent selection changes, but avoid no-op writes (especially on initial mount).
    // `sync.applySettings()` triggers a server POST, so only write when it actually changed.
    React.useEffect(() => {
        if (lastUsedAgent === agentType) return;
        sync.applySettings({ lastUsedAgent: agentType });
    }, [agentType, lastUsedAgent]);

    const [sessionType, setSessionType] = React.useState<'simple' | 'worktree'>('simple');
    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(() => {
        const accountDefaults = readAccountPermissionDefaults(sessionDefaultPermissionModeByAgent, enabledAgentIds);

        // If a profile is pre-selected (e.g. from draft), use its override; otherwise fall back to account defaults.
        const profile = selectedProfileId ? (profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId)) : null;

        return resolveNewSessionDefaultPermissionMode({
            agentType,
            accountDefaults,
            profileDefaults: profile ? profile.defaultPermissionModeByAgent : null,
            legacyProfileDefaultPermissionMode: (profile?.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
        });
    });

    // NOTE: Permission mode reset on agentType change is handled by the validation useEffect below (lines ~670-681)
    // which intelligently resets only when the current mode is invalid for the new agent type.
    // A duplicate unconditional reset here was removed to prevent race conditions.

    const [modelMode, setModelMode] = React.useState<ModelMode>(() => {
        const core = getAgentCore(agentType);
        const draftMode = typeof persistedDraft?.modelMode === 'string' ? persistedDraft.modelMode : null;
        if (draftMode && (core.model.allowedModes as readonly string[]).includes(draftMode)) {
            return draftMode as ModelMode;
        }
        return core.model.defaultMode;
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

    const allProfilesRequirementNames = React.useMemo(() => {
        const names = new Set<string>();
        for (const p of allProfiles) {
            for (const req of p.envVarRequirements ?? []) {
                const name = typeof req?.name === 'string' ? req.name : '';
                if (name) names.add(name);
            }
        }
        return Array.from(names);
    }, [allProfiles]);

    const machineEnvPresence = useMachineEnvPresence(
        selectedMachineId ?? null,
        allProfilesRequirementNames,
        { ttlMs: 5 * 60_000 },
    );
    const refreshMachineEnvPresence = machineEnvPresence.refresh;

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

    const hasUserSelectedPermissionModeRef = React.useRef(false);
    const permissionModeRef = React.useRef(permissionMode);
    React.useEffect(() => {
        permissionModeRef.current = permissionMode;
    }, [permissionMode]);

    const applyPermissionMode = React.useCallback((mode: PermissionMode, source: 'user' | 'auto') => {
        setPermissionMode((prev) => (prev === mode ? prev : mode));
        if (source === 'user') {
            sync.applySettings({ lastUsedPermissionMode: mode });
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
    const [isResumeSupportChecking, setIsResumeSupportChecking] = React.useState(false);

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

    // Handle resumeSessionId param from the resume picker screen
    React.useEffect(() => {
        if (typeof resumeSessionIdParam !== 'string') {
            return;
        }
        setResumeSessionId(resumeSessionIdParam);
    }, [resumeSessionIdParam]);

    // Path selection state - initialize with formatted selected path

    // CLI Detection - automatic, non-blocking detection of installed CLIs on selected machine
    const cliAvailability = useCLIDetection(selectedMachineId, { autoDetect: false });
    const { state: selectedMachineCapabilities } = useMachineCapabilitiesCache({
        machineId: selectedMachineId,
        enabled: false,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
    });

    const tmuxRequested = React.useMemo(() => {
        return Boolean(resolveTerminalSpawnOptions({
            settings: storage.getState().settings,
            machineId: selectedMachineId,
        }));
    }, [selectedMachineId, terminalTmuxByMachineId, terminalUseTmux]);

    const selectedMachineCapabilitiesSnapshot = React.useMemo(() => {
        return selectedMachineCapabilities.status === 'loaded'
            ? selectedMachineCapabilities.snapshot
            : selectedMachineCapabilities.status === 'loading'
                ? selectedMachineCapabilities.snapshot
                : selectedMachineCapabilities.status === 'error'
                    ? selectedMachineCapabilities.snapshot
                    : undefined;
    }, [selectedMachineCapabilities]);

    const resumeCapabilityOptionsResolved = React.useMemo(() => {
        return buildResumeCapabilityOptionsFromUiState({
            settings,
            results: selectedMachineCapabilitiesSnapshot?.response.results as any,
        });
    }, [selectedMachineCapabilitiesSnapshot, settings]);

    const showResumePicker = React.useMemo(() => {
        const core = getAgentCore(agentType);
        if (core.resume.supportsVendorResume !== true) {
            return core.resume.runtimeGate !== null;
        }
        if (core.resume.experimental !== true) return true;
        const allowExperimental = getAllowExperimentalResumeByAgentIdFromUiState(settings);
        return allowExperimental[agentType] === true;
    }, [agentType, settings]);

    const wizardInstallableDeps = React.useMemo(() => {
        if (!selectedMachineId) return [];
        if (experimentsEnabled !== true) return [];
        if (cliAvailability.available[agentType] !== true) return [];

        const experiments = getAgentResumeExperimentsFromSettings(agentType, settings);
        const relevantKeys = getNewSessionRelevantInstallableDepKeys({
            agentId: agentType,
            experiments,
            resumeSessionId,
        });
        if (relevantKeys.length === 0) return [];

        const entries = getInstallableDepRegistryEntries().filter((e) => relevantKeys.includes(e.key));
        const results = selectedMachineCapabilitiesSnapshot?.response.results;
        return entries.map((entry) => {
            const depStatus = entry.getDepStatus(results);
            const detectResult = entry.getDetectResult(results);
            return { entry, depStatus, detectResult };
        });
    }, [
        agentType,
        cliAvailability.available,
        experimentsEnabled,
        settings,
        resumeSessionId,
        selectedMachineCapabilitiesSnapshot,
        selectedMachineId,
    ]);

    React.useEffect(() => {
        if (!selectedMachineId) return;
        if (!experimentsEnabled) return;
        if (wizardInstallableDeps.length === 0) return;

        const machine = machines.find((m) => m.id === selectedMachineId);
        if (!machine || !isMachineOnline(machine)) return;

        const requests = wizardInstallableDeps
            .filter((d) =>
                d.entry.shouldPrefetchRegistry({ requireExistingResult: true, result: d.detectResult, data: d.depStatus }),
            )
            .flatMap((d) => d.entry.buildRegistryDetectRequest().requests ?? []);

        if (requests.length === 0) return;

        InteractionManager.runAfterInteractions(() => {
            void prefetchMachineCapabilities({
                machineId: selectedMachineId,
                request: { requests },
                timeoutMs: 12_000,
            });
        });
    }, [experimentsEnabled, machines, selectedMachineId, wizardInstallableDeps]);

    React.useEffect(() => {
        const results = selectedMachineCapabilitiesSnapshot?.response.results as any;
        const plan = getResumeRuntimeSupportPrefetchPlan({ agentId: agentType, settings, results });
        if (!plan) return;
        if (!selectedMachineId) return;
        const machine = machines.find((m) => m.id === selectedMachineId);
        if (!machine || !isMachineOnline(machine)) return;

        InteractionManager.runAfterInteractions(() => {
            void prefetchMachineCapabilities({
                machineId: selectedMachineId,
                request: plan.request,
                timeoutMs: plan.timeoutMs,
            });
        });
    }, [agentType, experimentsEnabled, machines, selectedMachineCapabilitiesSnapshot, selectedMachineId, settings]);

    // Auto-correct invalid agent selection after CLI detection completes
    // This handles the case where lastUsedAgent was 'codex' but codex is not installed
    React.useEffect(() => {
        // Only act when detection has completed (timestamp > 0)
        if (cliAvailability.timestamp === 0) return;

        const agentAvailable = cliAvailability.available[agentType];

        if (agentAvailable !== false) return;

        const firstInstalled = enabledAgentIds.find((id) => cliAvailability.available[id] === true);
        const fallback = enabledAgentIds[0] ?? DEFAULT_AGENT_ID;
        const nextAgent = firstInstalled ?? fallback;
        setAgentType(nextAgent);
    }, [
        cliAvailability.timestamp,
        cliAvailability.available,
        agentType,
        enabledAgentIds,
    ]);

    const [hiddenCliWarningKeys, setHiddenCliWarningKeys] = React.useState<Record<string, boolean>>({});

    const isCliBannerDismissed = React.useCallback((agentId: AgentId): boolean => {
        const warningKey = getAgentCore(agentId).cli.detectKey;
        if (hiddenCliWarningKeys[warningKey] === true) return true;
        return isCliWarningDismissed({ dismissed: dismissedCLIWarnings as any, machineId: selectedMachineId, warningKey });
    }, [dismissedCLIWarnings, hiddenCliWarningKeys, selectedMachineId]);

    const dismissCliBanner = React.useCallback((agentId: AgentId, scope: 'machine' | 'global' | 'temporary') => {
        const warningKey = getAgentCore(agentId).cli.detectKey;
        if (scope === 'temporary') {
            setHiddenCliWarningKeys((prev) => ({ ...prev, [warningKey]: true }));
            return;
        }
        setDismissedCLIWarnings(
            applyCliWarningDismissal({
                dismissed: dismissedCLIWarnings as any,
                machineId: selectedMachineId,
                warningKey,
                scope,
            }) as any,
        );
    }, [dismissedCLIWarnings, selectedMachineId, setDismissedCLIWarnings]);

    // Helper to check if profile is available (CLI detected + experiments gating)
    const isProfileAvailable = React.useCallback((profile: AIBackendProfile): { available: boolean; reason?: string } => {
        const allowedCLIs = getProfileSupportedAgentIds(profile).filter((agentId) => enabledAgentIds.includes(agentId));

        if (allowedCLIs.length === 0) {
            return {
                available: false,
                reason: 'no-supported-cli',
            };
        }

        // If a profile requires exactly one CLI, enforce that one.
        if (allowedCLIs.length === 1) {
            const requiredCLI = allowedCLIs[0];
            if (cliAvailability.available[requiredCLI] === false) {
                return {
                    available: false,
                    reason: `cli-not-detected:${requiredCLI}`,
                };
            }
            return { available: true };
        }

        // Multi-CLI profiles: available if *any* supported CLI is available (or detection not finished).
        const anyAvailable = allowedCLIs.some((cli) => cliAvailability.available[cli] !== false);
        if (!anyAvailable) {
            return {
                available: false,
                reason: 'cli-not-detected:any',
            };
        }
        return { available: true };
    }, [cliAvailability, enabledAgentIds]);

    const profileAvailabilityById = React.useMemo(() => {
        const map = new Map<string, { available: boolean; reason?: string }>();
        for (const profile of allProfiles) {
            map.set(profile.id, isProfileAvailable(profile));
        }
        return map;
    }, [allProfiles, isProfileAvailable]);

    // Computed values
    const compatibleProfiles = React.useMemo(() => {
        return allProfiles.filter((profile) => isProfileCompatibleWithAgent(profile, agentType));
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

    // NOTE: we intentionally do NOT clear per-profile secret overrides when profile changes.
    // Users may resolve secrets for multiple profiles and then switch between them before creating a session.

    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machines.find(m => m.id === selectedMachineId);
    }, [selectedMachineId, machines]);

    const secretRequirements = React.useMemo(() => {
        const reqs = selectedProfile?.envVarRequirements ?? [];
        return reqs
            .filter((r) => (r?.kind ?? 'secret') === 'secret')
            .map((r) => ({ name: r.name, required: r.required === true }))
            .filter((r) => typeof r.name === 'string' && r.name.length > 0) as Array<{ name: string; required: boolean }>;
    }, [selectedProfile]);
    const shouldShowSecretSection = secretRequirements.length > 0;

    const { openSecretRequirementModal } = useSecretRequirementFlow({
        router,
        navigation,
        useProfiles,
        selectedProfileId,
        selectedProfile,
        setSelectedProfileId,
        shouldShowSecretSection,
        selectedMachineId,
        machineEnvPresence,
        secrets,
        setSecrets,
        secretBindingsByProfileId,
        setSecretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        setSelectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        setSessionOnlySecretValueByProfileIdByEnvVarName,
        secretRequirementResultId: typeof secretRequirementResultId === 'string' ? secretRequirementResultId : undefined,
        prevProfileIdBeforeSecretPromptRef,
        lastSecretPromptKeyRef,
        suppressNextSecretAutoPromptKeyRef,
        isSecretRequirementModalOpenRef,
    });

    // Legacy convenience: treat the first required secret (or first secret) as the “primary” secret for
    // older single-secret UI paths (e.g. route params, draft persistence). Multi-secret enforcement uses
    // the full maps + `getSecretSatisfaction`.
    const primarySecretEnvVarName = React.useMemo(() => {
        const required = secretRequirements.find((r) => r.required)?.name ?? null;
        return required ?? (secretRequirements[0]?.name ?? null);
    }, [secretRequirements]);

    const selectedSecretId = React.useMemo(() => {
        if (!primarySecretEnvVarName) return null;
        if (!selectedProfileId) return null;
        const v = (selectedSecretIdByProfileIdByEnvVarName[selectedProfileId] ?? {})[primarySecretEnvVarName];
        return typeof v === 'string' ? v : null;
    }, [primarySecretEnvVarName, selectedProfileId, selectedSecretIdByProfileIdByEnvVarName]);

    const setSelectedSecretId = React.useCallback((next: string | null) => {
        if (!primarySecretEnvVarName) return;
        if (!selectedProfileId) return;
        setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
            ...prev,
            [selectedProfileId]: {
                ...(prev[selectedProfileId] ?? {}),
                [primarySecretEnvVarName]: next,
            },
        }));
    }, [primarySecretEnvVarName, selectedProfileId]);

    const sessionOnlySecretValue = React.useMemo(() => {
        if (!primarySecretEnvVarName) return null;
        if (!selectedProfileId) return null;
        const v = (sessionOnlySecretValueByProfileIdByEnvVarName[selectedProfileId] ?? {})[primarySecretEnvVarName];
        return typeof v === 'string' ? v : null;
    }, [primarySecretEnvVarName, selectedProfileId, sessionOnlySecretValueByProfileIdByEnvVarName]);

    const setSessionOnlySecretValue = React.useCallback((next: string | null) => {
        if (!primarySecretEnvVarName) return;
        if (!selectedProfileId) return;
        setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
            ...prev,
            [selectedProfileId]: {
                ...(prev[selectedProfileId] ?? {}),
                [primarySecretEnvVarName]: next,
            },
        }));
    }, [primarySecretEnvVarName, selectedProfileId]);

    const refreshMachineData = React.useCallback(() => {
        // Treat this as “refresh machine-related data”:
        // - machine list from server (new machines / metadata updates)
        // - CLI detection cache for selected machine (glyphs + login/availability)
        // - machine env presence preflight cache (API key env var presence)
        void sync.refreshMachinesThrottled({ staleMs: 0, force: true });
        refreshMachineEnvPresence();

        if (selectedMachineId) {
            void prefetchMachineCapabilities({ machineId: selectedMachineId, request: CAPABILITIES_REQUEST_NEW_SESSION });
        }
    }, [refreshMachineEnvPresence, selectedMachineId, sync]);

    const selectedSavedSecret = React.useMemo(() => {
        if (!selectedSecretId) return null;
        return secrets.find((k) => k.id === selectedSecretId) ?? null;
    }, [secrets, selectedSecretId]);

    React.useEffect(() => {
        if (!selectedProfileId) return;
        if (selectedSecretId !== null) return;
        if (!primarySecretEnvVarName) return;
        const nextDefault = secretBindingsByProfileId[selectedProfileId]?.[primarySecretEnvVarName] ?? null;
        if (typeof nextDefault === 'string' && nextDefault.length > 0) {
            setSelectedSecretId(nextDefault);
        }
    }, [primarySecretEnvVarName, secretBindingsByProfileId, selectedSecretId, selectedProfileId]);

    const activeSecretSource = sessionOnlySecretValue
        ? 'sessionOnly'
        : selectedSecretId
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
            selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: getSessionOnlySecretValueEncByProfileIdByEnvVarName(),
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
    }, [
        agentType,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        modelMode,
        permissionMode,
        router,
        selectedMachineId,
        selectedPath,
        selectedProfileId,
        selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName,
        sessionPrompt,
        sessionType,
        useProfiles,
    ]);

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
    useNewSessionCapabilitiesPrefetch({
        enabled: useEnhancedSessionWizard,
        machines,
        favoriteMachineItems,
        recentMachines,
        selectedMachineId,
        isMachineOnline,
        staleMs: CLI_DETECT_REVALIDATE_STALE_MS,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
        prefetchMachineCapabilitiesIfStale,
    });

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
        prevProfileIdBeforeSecretPromptRef.current = prevSelectedProfileId;
        // Ensure selecting a profile can re-prompt if needed.
        lastSecretPromptKeyRef.current = null;
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

            const supportedAgents = getProfileSupportedAgentIds(profile).filter((agentId) => enabledAgentIds.includes(agentId));

            if (supportedAgents.length > 0 && !supportedAgents.includes(agentType)) {
                setAgentType(supportedAgents[0] ?? (enabledAgentIds[0] ?? agentType));
            }

            if (profile.defaultSessionType) {
                setSessionType(profile.defaultSessionType);
            }

            if (!hasUserSelectedPermissionModeRef.current) {
                const accountDefaults = readAccountPermissionDefaults(sessionDefaultPermissionModeByAgent, enabledAgentIds);
                const nextMode = resolveNewSessionDefaultPermissionMode({
                    agentType,
                    accountDefaults,
                    profileDefaults: profile.defaultPermissionModeByAgent,
                    legacyProfileDefaultPermissionMode: (profile.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
                });
                applyPermissionMode(nextMode, 'auto');
            }
        });
    }, [
        agentType,
        applyPermissionMode,
        experimentsEnabled,
        experimentalAgents,
        profileMap,
        selectedProfileId,
        sessionDefaultPermissionModeByAgent,
    ]);

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
            const agentLabel = isAgentId(required) ? t(getAgentCore(required).displayNameKey) : required;
            return t('newSession.profileAvailability.requiresAgent', { agent: agentLabel });
        }
        if (availability.reason.startsWith('cli-not-detected:')) {
            const cli = availability.reason.split(':')[1];
            const agentFromCli = resolveAgentIdFromCliDetectKey(cli);
            const cliLabel = agentFromCli ? t(getAgentCore(agentFromCli).displayNameKey) : cli;
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

    // Handle secret route param from picker screens
    React.useEffect(() => {
        const { nextSelectedSecretId, shouldClearParam } = consumeSecretIdParam({
            secretIdParam,
            selectedSecretId,
        });

        if (nextSelectedSecretId === null) {
            if (selectedSecretId !== null) {
                setSelectedSecretId(null);
            }
        } else if (typeof nextSelectedSecretId === 'string') {
            setSelectedSecretId(nextSelectedSecretId);
        }

        if (shouldClearParam) {
            const setParams = (navigation as any)?.setParams;
            if (typeof setParams === 'function') {
                setParams({ secretId: undefined });
            } else {
                navigation.dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { secretId: undefined } },
                } as never);
            }
        }
    }, [navigation, secretIdParam, selectedSecretId]);

    // Handle session-only secret temp id from picker screens (value is stored in-memory only).
    React.useEffect(() => {
        if (typeof secretSessionOnlyId !== 'string' || secretSessionOnlyId.length === 0) {
            return;
        }

        const entry = getTempData<{ secret?: string }>(secretSessionOnlyId);
        const value = entry?.secret;
        if (typeof value === 'string' && value.length > 0) {
            setSessionOnlySecretValue(value);
            setSelectedSecretId(null);
        }

        const setParams = (navigation as any)?.setParams;
        if (typeof setParams === 'function') {
            setParams({ secretSessionOnlyId: undefined });
        } else {
            navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: { secretSessionOnlyId: undefined } },
            } as never);
        }
    }, [navigation, secretSessionOnlyId]);

    // Keep agentType compatible with the currently selected profile.
    React.useEffect(() => {
        if (!useProfiles || selectedProfileId === null) {
            return;
        }

        const profile = profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId);
        if (!profile) {
            return;
        }

        const supportedAgents = getProfileSupportedAgentIds(profile).filter((agentId) => enabledAgentIds.includes(agentId));

        if (supportedAgents.length > 0 && !supportedAgents.includes(agentType)) {
            setAgentType(supportedAgents[0]!);
        }
    }, [agentType, enabledAgentIds, profileMap, selectedProfileId, useProfiles]);

    const prevAgentTypeRef = React.useRef(agentType);

    // When agent type changes, keep the "permission level" consistent by mapping modes across backends.
    React.useEffect(() => {
        const prev = prevAgentTypeRef.current;
        if (prev === agentType) {
            return;
        }
        prevAgentTypeRef.current = agentType;

        // Defaults should only apply in the new-session flow (not in existing sessions),
        // and only if the user hasn't explicitly chosen a mode on this screen.
        if (!hasUserSelectedPermissionModeRef.current) {
            const profile = selectedProfileId ? (profileMap.get(selectedProfileId) || getBuiltInProfile(selectedProfileId)) : null;
            const accountDefaults = readAccountPermissionDefaults(sessionDefaultPermissionModeByAgent, enabledAgentIds);
            const nextMode = resolveNewSessionDefaultPermissionMode({
                agentType,
                accountDefaults,
                profileDefaults: profile ? profile.defaultPermissionModeByAgent : null,
                legacyProfileDefaultPermissionMode: (profile?.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
            });
            applyPermissionMode(nextMode, 'auto');
            return;
        }

        const current = permissionModeRef.current;
        const mapped = mapPermissionModeAcrossAgents(current, prev, agentType);
        applyPermissionMode(mapped, 'auto');
    }, [
        agentType,
        applyPermissionMode,
        profileMap,
        selectedProfileId,
        sessionDefaultPermissionModeByAgent,
    ]);

    // Reset model mode when agent type changes to appropriate default
    React.useEffect(() => {
        const core = getAgentCore(agentType);
        if ((core.model.allowedModes as readonly ModelMode[]).includes(modelMode)) return;
        setModelMode(core.model.defaultMode);
    }, [agentType, modelMode]);

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
                ? getProfileSupportedAgentIds(profile).filter((agentId) => enabledAgentIds.includes(agentId))
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
            setAgentType(supportedAgents[nextIndex] ?? supportedAgents[0] ?? DEFAULT_AGENT_ID);
            return;
        }

        handleAgentCycle();
    }, [
        agentType,
        enabledAgentIds,
        handleAgentCycle,
        handleProfileClick,
        profileMap,
        selectedProfileId,
        setAgentType,
        useProfiles,
    ]);

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

    const handleResumeClick = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/resume' as any,
            params: {
                currentResumeId: resumeSessionId,
                agentType,
            },
        });
    }, [router, resumeSessionId, agentType]);

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

    const agentOptionState = agentNewSessionOptionStateByAgentId[agentType] ?? null;
    const agentNewSessionOptions = React.useMemo(() => {
        return buildNewSessionOptionsFromUiState({ agentId: agentType, agentOptionState });
    }, [agentOptionState, agentType]);

    const { handleCreateSession } = useCreateNewSession({
        router,
        selectedMachineId,
        selectedPath,
        selectedMachine,
        setIsCreating,
        setIsResumeSupportChecking,
        sessionType,
        settings,
        useProfiles,
        selectedProfileId,
        profileMap,
        recentMachinePaths,
        agentType,
        permissionMode,
        modelMode,
        sessionPrompt,
        resumeSessionId,
        agentNewSessionOptions,
        machineEnvPresence,
        secrets,
        secretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        selectedMachineCapabilities,
    });

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

    const setAgentOptionStateForCurrentAgent = React.useCallback((key: string, value: unknown) => {
        setAgentNewSessionOptionStateByAgentId((prev) => {
            const nextForAgent = { ...(prev[agentType] ?? {}), [key]: value };
            return { ...prev, [agentType]: nextForAgent };
        });
    }, [agentType]);

    const agentInputExtraActionChips = React.useMemo(() => {
        return getNewSessionAgentInputExtraActionChips({
            agentId: agentType,
            agentOptionState,
            setAgentOptionState: setAgentOptionStateForCurrentAgent,
        });
    }, [agentOptionState, agentType, setAgentOptionStateForCurrentAgent]);

    const persistDraftNow = React.useCallback(() => {
        saveNewSessionDraft({
            input: sessionPrompt,
            selectedMachineId,
            selectedPath,
            selectedProfileId: useProfiles ? selectedProfileId : null,
            selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: getSessionOnlySecretValueEncByProfileIdByEnvVarName(),
            agentType,
            permissionMode,
            modelMode,
            sessionType,
            resumeSessionId,
            agentNewSessionOptionStateByAgentId,
            updatedAt: Date.now(),
        });
    }, [
        agentType,
        agentNewSessionOptionStateByAgentId,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        modelMode,
        permissionMode,
        resumeSessionId,
        selectedSecretId,
        selectedSecretIdByProfileIdByEnvVarName,
        selectedMachineId,
        selectedPath,
        selectedProfileId,
        sessionPrompt,
        sessionType,
        useProfiles,
    ]);

    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    useNewSessionDraftAutoPersist({ persistDraftNow });

    // ========================================================================
    // CONTROL A: Simpler AgentInput-driven layout (flag OFF)
    // Shows machine/path selection via chips that navigate to picker screens
    // ========================================================================
    if (!useEnhancedSessionWizard) {
        return {
            variant: 'simple',
            popoverBoundaryRef,
            simpleProps: {
                popoverBoundaryRef,
                headerHeight,
                safeAreaTop: safeArea.top,
                safeAreaBottom: safeArea.bottom,
                newSessionSidePadding,
                newSessionBottomPadding,
                containerStyle: styles.container as any,
                experimentsEnabled: experimentsEnabled === true,
                expSessionType: expSessionType === true,
                sessionType,
                setSessionType,
                sessionPrompt,
                setSessionPrompt,
                handleCreateSession,
                canCreate,
                isCreating,
                emptyAutocompletePrefixes,
                emptyAutocompleteSuggestions,
                sessionPromptInputMaxHeight,
                agentType,
                handleAgentClick,
                permissionMode,
                handlePermissionModeChange,
                modelMode,
                setModelMode,
                connectionStatus,
                machineName: selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host,
                handleMachineClick,
                selectedPath,
                handlePathClick,
                showResumePicker,
                resumeSessionId,
                handleResumeClick,
                isResumeSupportChecking,
                agentInputExtraActionChips,
                useProfiles,
                selectedProfileId,
                handleProfileClick,
                selectedProfileEnvVarsCount,
                handleEnvVarsClick,
            },
        };
    }

    // ========================================================================
    // VARIANT B: Enhanced profile-first wizard (flag ON)
    // Full wizard with numbered sections, profile management, CLI detection
    // ========================================================================

    const {
        layout: wizardLayoutProps,
        profiles: wizardProfilesProps,
        agent: wizardAgentProps,
        machine: wizardMachineProps,
        footer: wizardFooterProps,
    } = useNewSessionWizardProps({
        theme,
        styles,
        safeAreaBottom: safeArea.bottom,
        headerHeight,
        newSessionSidePadding,
        newSessionBottomPadding,

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
        suppressNextSecretAutoPromptKeyRef,
        openSecretRequirementModal,
        profilesGroupTitles,

        machineEnvPresence,
        secrets,
        secretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,

        wizardInstallableDeps,
        selectedMachineCapabilities,

        cliAvailability,
        tmuxRequested,
        enabledAgentIds,
        isCliBannerDismissed,
        dismissCliBanner,
        agentType,
        setAgentType,
        modelOptions,
        modelMode,
        setModelMode,
        selectedIndicatorColor,
        profileMap,
        permissionMode,
        handlePermissionModeChange,
        sessionType,
        setSessionType,

        machines,
        selectedMachine: selectedMachine ?? null,
        recentMachines,
        favoriteMachineItems,
        useMachinePickerSearch,
        refreshMachineData,
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

        sessionPrompt,
        setSessionPrompt,
        handleCreateSession,
        canCreate,
        isCreating,
        emptyAutocompletePrefixes,
        emptyAutocompleteSuggestions,
        connectionStatus,
        selectedProfileEnvVarsCount,
        handleEnvVarsClick,
        resumeSessionId,
        showResumePicker,
        handleResumeClick,
        isResumeSupportChecking,
        sessionPromptInputMaxHeight,
        agentInputExtraActionChips,
    });

    return {
        variant: 'wizard',
        popoverBoundaryRef,
        wizardProps: {
            layout: wizardLayoutProps,
            profiles: wizardProfilesProps,
            agent: wizardAgentProps,
            machine: wizardMachineProps,
            footer: wizardFooterProps,
        },
    };
}
