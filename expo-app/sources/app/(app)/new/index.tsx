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
import { machineCapabilitiesInvoke, machineSpawnNewSession } from '@/sync/ops';
import { Modal } from '@/modal';
import { BaseModal } from '@/modal/components/BaseModal';
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
import { getRequiredSecretEnvVarNames } from '@/sync/profileSecrets';

import { isMachineOnline } from '@/utils/machineUtils';
import { StatusDot } from '@/components/StatusDot';
import { clearNewSessionDraft, loadNewSessionDraft, saveNewSessionDraft } from '@/sync/persistence';
import { MachineSelector } from '@/components/newSession/MachineSelector';
import { PathSelector } from '@/components/newSession/PathSelector';
import { SearchHeader } from '@/components/SearchHeader';
import { ProfileCompatibilityIcon } from '@/components/newSession/ProfileCompatibilityIcon';
import { EnvironmentVariablesPreviewModal } from '@/components/newSession/EnvironmentVariablesPreviewModal';
import { consumeProfileIdParam, consumeSecretIdParam } from '@/profileRouteParams';
import { getModelOptionsForAgentType } from '@/sync/modelOptions';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/SecretRequirementModal';
import { useFocusEffect } from '@react-navigation/native';
import { getRecentPathsForMachine } from '@/utils/recentPaths';
import { useMachineEnvPresence } from '@/hooks/useMachineEnvPresence';
import { getSecretSatisfaction } from '@/utils/secretSatisfaction';
import { InteractionManager } from 'react-native';
import { NewSessionWizard } from './NewSessionWizard';
import { prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale, useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import { PopoverBoundaryProvider } from '@/components/PopoverBoundary';
import { resolveTerminalSpawnOptions } from '@/sync/terminalSettings';
import { canAgentResume } from '@/utils/agentCapabilities';

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
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
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
    } = useLocalSearchParams<{
        prompt?: string;
        dataId?: string;
        machineId?: string;
        path?: string;
        profileId?: string;
        resumeSessionId?: string;
        secretId?: string;
        secretSessionOnlyId?: string;
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

    // Settings and state
    const recentMachinePaths = useSetting('recentMachinePaths');
    const lastUsedAgent = useSetting('lastUsedAgent');

    // A/B Test Flag - determines which wizard UI to show
    // Control A (false): Simpler AgentInput-driven layout
    // Variant B (true): Enhanced profile-first wizard with sections
    const useEnhancedSessionWizard = useSetting('useEnhancedSessionWizard');
    const useProfiles = useSetting('useProfiles');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');
    const experimentsEnabled = useSetting('experiments');
    const expGemini = useSetting('expGemini');
    const expSessionType = useSetting('expSessionType');
    const expCodexResume = useSetting('expCodexResume');
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
    const [selectedSecretIdByProfileIdByEnvVarName, setSelectedSecretIdByProfileIdByEnvVarName] = React.useState<Record<string, Record<string, string | null>>>(() => {
        const raw = persistedDraft?.selectedSecretIdByProfileIdByEnvVarName;
        if (!raw || typeof raw !== 'object') return {};
        const out: Record<string, Record<string, string | null>> = {};
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
    const [sessionOnlySecretValueByProfileIdByEnvVarName, setSessionOnlySecretValueByProfileIdByEnvVarName] = React.useState<Record<string, Record<string, string | null>>>(() => {
        const raw = persistedDraft?.sessionOnlySecretValueEncByProfileIdByEnvVarName;
        if (!raw || typeof raw !== 'object') return {};
        const out: Record<string, Record<string, string | null>> = {};
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

    // Persist agent selection changes, but avoid no-op writes (especially on initial mount).
    // `sync.applySettings()` triggers a server POST, so only write when it actually changed.
    React.useEffect(() => {
        if (lastUsedAgent === agentType) return;
        sync.applySettings({ lastUsedAgent: agentType });
    }, [agentType, lastUsedAgent]);

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

    const openSecretRequirementModal = React.useCallback((profile: AIBackendProfile, options: { revertOnCancel: boolean }) => {
        const selectedSecretIdByEnvVarName = selectedSecretIdByProfileIdByEnvVarName[profile.id] ?? {};
        const sessionOnlySecretValueByEnvVarName = sessionOnlySecretValueByProfileIdByEnvVarName[profile.id] ?? {};

        const satisfaction = getSecretSatisfaction({
            profile,
            secrets,
            defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
            selectedSecretIds: selectedSecretIdByEnvVarName,
            sessionOnlyValues: sessionOnlySecretValueByEnvVarName,
            machineEnvReadyByName: Object.fromEntries(
                Object.entries(machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
            ),
        });

        const targetEnvVarName =
            satisfaction.items.find((i) => i.required && !i.isSatisfied)?.envVarName ??
            satisfaction.items[0]?.envVarName ??
            null;
        if (!targetEnvVarName) {
            isSecretRequirementModalOpenRef.current = false;
            return;
        }
        isSecretRequirementModalOpenRef.current = true;

        const selectedRaw = selectedSecretIdByEnvVarName[targetEnvVarName];
        const selectedSavedSecretIdForProfile =
            typeof selectedRaw === 'string' && selectedRaw.length > 0 && selectedRaw !== ''
                ? selectedRaw
                : null;

        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action === 'cancel') {
                isSecretRequirementModalOpenRef.current = false;
                // Always allow future prompts for this profile.
                lastSecretPromptKeyRef.current = null;
                suppressNextSecretAutoPromptKeyRef.current = null;
                if (options.revertOnCancel) {
                    const prev = prevProfileIdBeforeSecretPromptRef.current;
                    setSelectedProfileId(prev);
                }
                return;
            }

            isSecretRequirementModalOpenRef.current = false;

            if (result.action === 'useMachine') {
                setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: '',
                    },
                }));
                setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: null,
                    },
                }));
                return;
            }

            if (result.action === 'enterOnce') {
                setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: '',
                    },
                }));
                setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: result.value,
                    },
                }));
                return;
            }

            if (result.action === 'selectSaved') {
                setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: null,
                    },
                }));
                setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
                    ...prev,
                    [profile.id]: {
                        ...(prev[profile.id] ?? {}),
                        [result.envVarName]: result.secretId,
                    },
                }));
                if (result.setDefault) {
                    setSecretBindingsByProfileId({
                        ...secretBindingsByProfileId,
                        [profile.id]: {
                            ...(secretBindingsByProfileId[profile.id] ?? {}),
                            [result.envVarName]: result.secretId,
                        },
                    });
                }
            }
        };

        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile,
                secretEnvVarName: targetEnvVarName,
                secretEnvVarNames: satisfaction.items.map((i) => i.envVarName),
                machineId: selectedMachineId ?? null,
                secrets,
                defaultSecretId: secretBindingsByProfileId[profile.id]?.[targetEnvVarName] ?? null,
                selectedSavedSecretId: selectedSavedSecretIdForProfile,
                selectedSecretIdByEnvVarName: selectedSecretIdByEnvVarName,
                sessionOnlySecretValueByEnvVarName: sessionOnlySecretValueByEnvVarName,
                defaultSecretIdByEnvVarName: secretBindingsByProfileId[profile.id] ?? null,
                onSetDefaultSecretId: (id) => {
                    if (!id) return;
                    setSecretBindingsByProfileId({
                        ...secretBindingsByProfileId,
                        [profile.id]: {
                            ...(secretBindingsByProfileId[profile.id] ?? {}),
                            [targetEnvVarName]: id,
                        },
                    });
                },
                onChangeSecrets: setSecrets,
                allowSessionOnly: true,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' }),
            },
            closeOnBackdrop: true,
        });
    }, [
        machineEnvPresence.meta,
        secrets,
        secretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        selectedMachineId,
        selectedProfileId,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        setSecretBindingsByProfileId,
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
        request: { checklistId: 'new-session' },
    });

    const tmuxRequested = React.useMemo(() => {
        return Boolean(resolveTerminalSpawnOptions({
            settings: storage.getState().settings,
            machineId: selectedMachineId,
        }));
    }, [selectedMachineId, terminalTmuxByMachineId, terminalUseTmux]);

    const wantsCodexResume = React.useMemo(() => {
        return (
            experimentsEnabled &&
            expCodexResume &&
            agentType === 'codex' &&
            resumeSessionId.trim().length > 0 &&
            canAgentResume(agentType, { allowCodexResume: true })
        );
    }, [agentType, canAgentResume, expCodexResume, experimentsEnabled, resumeSessionId]);

    const [isInstallingCodexResume, setIsInstallingCodexResume] = React.useState(false);

    const selectedMachineCapabilitiesSnapshot = React.useMemo(() => {
        return selectedMachineCapabilities.status === 'loaded'
            ? selectedMachineCapabilities.snapshot
            : selectedMachineCapabilities.status === 'loading'
                ? selectedMachineCapabilities.snapshot
                : selectedMachineCapabilities.status === 'error'
                    ? selectedMachineCapabilities.snapshot
                    : undefined;
    }, [selectedMachineCapabilities]);

    const systemCodexVersion = React.useMemo(() => {
        const result = selectedMachineCapabilitiesSnapshot?.response.results['cli.codex'];
        if (!result || !result.ok) return null;
        const data = result.data as any;
        if (data?.available !== true) return null;
        return typeof data.version === 'string' ? data.version : null;
    }, [selectedMachineCapabilitiesSnapshot]);

    const codexResumeDep = React.useMemo(() => {
        const result = selectedMachineCapabilitiesSnapshot?.response.results['dep.codex-mcp-resume'];
        if (!result || !result.ok) return null;
        const data = result.data as any;
        return data && typeof data === 'object' ? data : null;
    }, [selectedMachineCapabilitiesSnapshot]);

    const codexResumeLatestVersion = React.useMemo(() => {
        const registry = codexResumeDep?.registry;
        if (!registry || typeof registry !== 'object') return null;
        if (registry.ok !== true) return null;
        return typeof registry.latestVersion === 'string' ? registry.latestVersion : null;
    }, [codexResumeDep]);

    const codexResumeUpdateAvailable = React.useMemo(() => {
        if (codexResumeDep?.installed !== true) return false;
        const installed = typeof codexResumeDep.installedVersion === 'string' ? codexResumeDep.installedVersion : null;
        const latest = codexResumeLatestVersion;
        if (!installed || !latest) return false;
        return installed !== latest;
    }, [codexResumeDep, codexResumeLatestVersion]);

    const checkCodexResumeUpdates = React.useCallback(() => {
        if (!selectedMachineId) return;
        void prefetchMachineCapabilities({
            machineId: selectedMachineId,
            request: { checklistId: 'resume.codex' },
            timeoutMs: 12_000,
        });
    }, [selectedMachineId]);

    React.useEffect(() => {
        if (!wantsCodexResume) return;
        if (!selectedMachineId) return;
        const machine = machines.find((m) => m.id === selectedMachineId);
        if (!machine || !isMachineOnline(machine)) return;

        InteractionManager.runAfterInteractions(() => {
            checkCodexResumeUpdates();
        });
    }, [checkCodexResumeUpdates, machines, selectedMachineId, wantsCodexResume]);

    const handleInstallOrUpdateCodexResume = React.useCallback(() => {
        if (!selectedMachineId) return;
        if (!wantsCodexResume) return;

        Modal.alert(
            codexResumeDep?.installed ? (codexResumeUpdateAvailable ? 'Update Codex resume?' : 'Reinstall Codex resume?') : 'Install Codex resume?',
            'This installs an experimental Codex MCP server wrapper used only for resume operations.',
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: codexResumeDep?.installed ? (codexResumeUpdateAvailable ? 'Update' : 'Reinstall') : 'Install',
                    onPress: async () => {
                        setIsInstallingCodexResume(true);
                        try {
                            const method = codexResumeDep?.installed ? (codexResumeUpdateAvailable ? 'upgrade' : 'install') : 'install';
                            const invoke = await machineCapabilitiesInvoke(
                                selectedMachineId,
                                { id: 'dep.codex-mcp-resume', method },
                                { timeoutMs: 5 * 60_000 },
                            );
                            if (!invoke.supported) {
                                Modal.alert('Error', invoke.reason === 'not-supported' ? 'Update Happy CLI to install this dependency.' : 'Install failed');
                                return;
                            }
                            if (!invoke.response.ok) {
                                Modal.alert('Error', invoke.response.error.message);
                                return;
                            }
                            const logPath = (invoke.response.result as any)?.logPath;
                            Modal.alert('Success', typeof logPath === 'string' ? `Install log: ${logPath}` : 'Installed');
                            checkCodexResumeUpdates();
                        } catch (e) {
                            Modal.alert('Error', e instanceof Error ? e.message : 'Install failed');
                        } finally {
                            setIsInstallingCodexResume(false);
                        }
                    },
                },
            ],
        );
    }, [
        checkCodexResumeUpdates,
        codexResumeDep,
        codexResumeUpdateAvailable,
        selectedMachineId,
        t,
        wantsCodexResume,
    ]);

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
            void prefetchMachineCapabilities({ machineId: selectedMachineId, request: { checklistId: 'new-session' } });
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

    // One-time prefetch of machine capabilities for the wizard machine list.
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
                    void prefetchMachineCapabilitiesIfStale({
                        machineId,
                        staleMs: CLI_DETECT_REVALIDATE_STALE_MS,
                        request: { checklistId: 'new-session' },
                    });
                }
            } catch {
                // best-effort prefetch only
            }
        });
    }, [favoriteMachineItems, machines, recentMachines, useEnhancedSessionWizard]);

    // Cache-first + background refresh: for the actively selected machine, prefetch capabilities
    // if missing or stale. This updates the banners/agent availability on screen open, but avoids
    // any fetches on tap handlers.
    React.useEffect(() => {
        if (!selectedMachineId) return;
        const machine = machines.find((m) => m.id === selectedMachineId);
        if (!machine) return;
        if (!isMachineOnline(machine)) return;

        InteractionManager.runAfterInteractions(() => {
            void prefetchMachineCapabilitiesIfStale({
                machineId: selectedMachineId,
                staleMs: CLI_DETECT_REVALIDATE_STALE_MS,
                request: { checklistId: 'new-session' },
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
        if (!shouldShowSecretSection) return;
        if (!selectedProfileId) return;
        if (isSecretRequirementModalOpenRef.current) return;

        // Wait for the machine env check to complete. Otherwise we can briefly treat
        // a configured machine as "missing" and incorrectly pop the modal.
        if (machineEnvPresence.isLoading) return;

        const selectedSecretIdByEnvVarName = selectedSecretIdByProfileIdByEnvVarName[selectedProfileId] ?? {};
        const sessionOnlySecretValueByEnvVarName = sessionOnlySecretValueByProfileIdByEnvVarName[selectedProfileId] ?? {};

        const satisfaction = getSecretSatisfaction({
            profile: selectedProfile ?? null,
            secrets,
            defaultBindings: secretBindingsByProfileId[selectedProfileId] ?? null,
            selectedSecretIds: selectedSecretIdByEnvVarName,
            sessionOnlyValues: sessionOnlySecretValueByEnvVarName,
            machineEnvReadyByName: Object.fromEntries(
                Object.entries(machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
            ),
        });

        if (satisfaction.isSatisfied) {
            // Reset prompt key when requirements are satisfied so future selections can prompt again if needed.
            lastSecretPromptKeyRef.current = null;
            return;
        }

        const missing = satisfaction.items.find((i) => i.required && !i.isSatisfied) ?? null;
        const promptKey = `${selectedMachineId}:${selectedProfileId}:${missing?.envVarName ?? 'unknown'}`;
        if (suppressNextSecretAutoPromptKeyRef.current === promptKey) {
            // One-shot suppression (used when the user explicitly opened the modal via the badge).
            suppressNextSecretAutoPromptKeyRef.current = null;
            return;
        }
        if (lastSecretPromptKeyRef.current === promptKey) {
            return;
        }
        lastSecretPromptKeyRef.current = promptKey;
        if (!selectedProfile) {
            return;
        }
        openSecretRequirementModal(selectedProfile, { revertOnCancel: true });
    }, [
        secrets,
        secretBindingsByProfileId,
        machineEnvPresence.isLoading,
        machineEnvPresence.meta,
        openSecretRequirementModal,
        selectedSecretIdByProfileIdByEnvVarName,
        selectedMachineId,
        selectedProfileId,
        selectedProfile,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        shouldShowSecretSection,
        suppressNextSecretAutoPromptKeyRef,
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
                    const selectedSecretIdByEnvVarName = selectedSecretIdByProfileIdByEnvVarName[selectedProfileId] ?? {};
                    const sessionOnlySecretValueByEnvVarName = sessionOnlySecretValueByProfileIdByEnvVarName[selectedProfileId] ?? {};
                    const machineEnvReadyByName = Object.fromEntries(
                        Object.entries(machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
                    );
                    const satisfaction = getSecretSatisfaction({
                        profile: selectedProfile,
                        secrets,
                        defaultBindings: secretBindingsByProfileId[selectedProfile.id] ?? null,
                        selectedSecretIds: selectedSecretIdByEnvVarName,
                        sessionOnlyValues: sessionOnlySecretValueByEnvVarName,
                        machineEnvReadyByName,
                    });

                    if (satisfaction.hasSecretRequirements && !satisfaction.isSatisfied) {
                        const missing = satisfaction.items.find((i) => i.required && !i.isSatisfied)?.envVarName ?? null;
                        Modal.alert(
                            t('common.error'),
                            t('secrets.missingForProfile', { env: missing ?? t('profiles.requirements.secretRequired') }),
                        );
                        setIsCreating(false);
                        return;
                    }

                    // Inject any secrets that were satisfied via saved key or session-only.
                    // Machine-env satisfied secrets are not injected (daemon will resolve from its env).
                    for (const item of satisfaction.items) {
                        if (!item.isSatisfied) continue;
                        let injected: string | null = null;

                        if (item.satisfiedBy === 'sessionOnly') {
                            injected = sessionOnlySecretValueByEnvVarName[item.envVarName] ?? null;
                        } else if (
                            item.satisfiedBy === 'selectedSaved' ||
                            item.satisfiedBy === 'rememberedSaved' ||
                            item.satisfiedBy === 'defaultSaved'
                        ) {
                            const id = item.savedSecretId;
                            const secret = id ? (secrets.find((k) => k.id === id) ?? null) : null;
                            injected = sync.decryptSecretValue(secret?.encryptedValue ?? null);
                        }

                        if (typeof injected === 'string' && injected.length > 0) {
                            environmentVariables = {
                                ...environmentVariables,
                                [item.envVarName]: injected,
                            };
                        }
                    }
                }
            }

            const terminal = resolveTerminalSpawnOptions({
                settings: storage.getState().settings,
                machineId: selectedMachineId,
            });

            const wantsCodexResume =
                experimentsEnabled &&
                expCodexResume &&
                agentType === 'codex' &&
                resumeSessionId.trim().length > 0 &&
                canAgentResume(agentType, { allowCodexResume: true });

            if (wantsCodexResume) {
                const installed =
                    (() => {
                        const snapshot =
                            selectedMachineCapabilities.status === 'loaded'
                                ? selectedMachineCapabilities.snapshot
                                : selectedMachineCapabilities.status === 'loading'
                                    ? selectedMachineCapabilities.snapshot
                                    : selectedMachineCapabilities.status === 'error'
                                        ? selectedMachineCapabilities.snapshot
                                        : undefined;
                        const dep = snapshot?.response.results['dep.codex-mcp-resume'];
                        if (!dep || !dep.ok) return null;
                        const data = dep.data as any;
                        return typeof data?.installed === 'boolean' ? data.installed : null;
                    })();

                if (installed === false) {
                    const openMachine = await Modal.confirm(
                        t('errors.codexResumeNotInstalledTitle'),
                        t('errors.codexResumeNotInstalledMessage'),
                        { confirmText: t('connect.openMachine') }
                    );
                    if (openMachine) {
                        router.push(`/machine/${selectedMachineId}` as any);
                    }
                    setIsCreating(false);
                    return;
                }
            }

            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: actualPath,
                approvedNewDirectoryCreation: true,
                agent: agentType,
                profileId: profilesActive ? (selectedProfileId ?? '') : undefined,
                environmentVariables,
                resume: canAgentResume(agentType, { allowCodexResume: experimentsEnabled && expCodexResume })
                    ? (resumeSessionId.trim() || undefined)
                    : undefined,
                experimentalCodexResume: experimentsEnabled && expCodexResume && agentType === 'codex' && resumeSessionId.trim().length > 0,
                terminal,
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
        experimentsEnabled,
        expCodexResume,
        machineEnvPresence.meta,
        modelMode,
        permissionMode,
        profileMap,
        recentMachinePaths,
        resumeSessionId,
        router,
        secretBindingsByProfileId,
        secrets,
        selectedMachineCapabilities,
        selectedSecretIdByProfileIdByEnvVarName,
        selectedMachineId,
        selectedPath,
        selectedProfileId,
        sessionOnlySecretValueByProfileIdByEnvVarName,
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
            selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: getSessionOnlySecretValueEncByProfileIdByEnvVarName(),
            agentType,
            permissionMode,
            modelMode,
            sessionType,
            resumeSessionId,
            updatedAt: Date.now(),
        });
    }, [
        agentType,
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
                <View
                    ref={popoverBoundaryRef}
                    style={{
                        flex: 1,
                        width: '100%',
                        // Keep the content centered on web. Without this, the boundary wrapper (flex:1)
                        // can cause the inner content to stick to the top even when the modal is centered.
                        justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
                    }}
                >
                    <PopoverBoundaryProvider boundaryRef={popoverBoundaryRef}>
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
                                            resumeSessionId={canAgentResume(agentType, { allowCodexResume: experimentsEnabled && expCodexResume }) ? resumeSessionId : undefined}
                                            onResumeClick={canAgentResume(agentType, { allowCodexResume: experimentsEnabled && expCodexResume }) ? handleResumeClick : undefined}
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
                    </PopoverBoundaryProvider>
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
        };
    }, [headerHeight, newSessionBottomPadding, newSessionSidePadding, safeArea.bottom, theme]);

    const getSecretSatisfactionForProfile = React.useCallback((profile: AIBackendProfile) => {
        const selectedSecretIds = selectedSecretIdByProfileIdByEnvVarName[profile.id] ?? null;
        const sessionOnlyValues = sessionOnlySecretValueByProfileIdByEnvVarName[profile.id] ?? null;
        const machineEnvReadyByName = Object.fromEntries(
            Object.entries(machineEnvPresence.meta ?? {}).map(([k, v]) => [k, Boolean(v?.isSet)]),
        );
        return getSecretSatisfaction({
            profile,
            secrets,
            defaultBindings: secretBindingsByProfileId[profile.id] ?? null,
            selectedSecretIds,
            sessionOnlyValues,
            machineEnvReadyByName,
        });
    }, [
        machineEnvPresence.meta,
        secrets,
        secretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
    ]);

    const getSecretOverrideReady = React.useCallback((profile: AIBackendProfile): boolean => {
        const satisfaction = getSecretSatisfactionForProfile(profile);
        // Override should only represent non-machine satisfaction (defaults / saved / session-only).
        if (!satisfaction.hasSecretRequirements) return false;
        const required = satisfaction.items.filter((i) => i.required);
        if (required.length === 0) return false;
        if (!required.every((i) => i.isSatisfied)) return false;
        return required.some((i) => i.satisfiedBy !== 'machineEnv');
    }, [getSecretSatisfactionForProfile]);

    const getSecretMachineEnvOverride = React.useCallback((profile: AIBackendProfile) => {
        if (!selectedMachineId) return null;
        if (!machineEnvPresence.isPreviewEnvSupported) return null;
        const requiredNames = getRequiredSecretEnvVarNames(profile);
        if (requiredNames.length === 0) return null;
        return {
            isReady: requiredNames.every((name) => Boolean(machineEnvPresence.meta[name]?.isSet)),
            isLoading: machineEnvPresence.isLoading,
        };
    }, [
        machineEnvPresence.isLoading,
        machineEnvPresence.isPreviewEnvSupported,
        machineEnvPresence.meta,
        selectedMachineId,
    ]);

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
            suppressNextSecretAutoPromptKeyRef,
            openSecretRequirementModal,
            profilesGroupTitles,
            getSecretOverrideReady,
            getSecretSatisfactionForProfile,
            getSecretMachineEnvOverride,
        };
    }, [
        experimentsEnabled,
        favoriteProfileIds,
        getSecretOverrideReady,
        getProfileDisabled,
        getProfileSubtitleExtra,
        getSecretSatisfactionForProfile,
        getSecretMachineEnvOverride,
        handleAddProfile,
        handleDeleteProfile,
        handleDuplicateProfile,
        onPressDefaultEnvironment,
        onPressProfile,
        openSecretRequirementModal,
        openProfileEdit,
        openProfileEnvVarsPreview,
        profiles,
        profilesGroupTitles,
        selectedMachineId,
        selectedProfileId,
        setFavoriteProfileIds,
        suppressNextSecretAutoPromptKeyRef,
        useProfiles,
    ]);

    const codexResumeBanner = React.useMemo(() => {
        if (!selectedMachineId) return null;
        if (!wantsCodexResume) return null;
        if (cliAvailability.codex !== true) return null;

        const installed = typeof codexResumeDep?.installed === 'boolean' ? codexResumeDep.installed : null;
        const installedVersion = typeof codexResumeDep?.installedVersion === 'string' ? codexResumeDep.installedVersion : null;
        const registry = codexResumeDep?.registry;
        const registryError =
            registry && typeof registry === 'object' && registry.ok === false && typeof (registry as any).errorMessage === 'string'
                ? String((registry as any).errorMessage)
                : null;

        return {
            installed,
            installedVersion,
            latestVersion: codexResumeLatestVersion,
            updateAvailable: codexResumeUpdateAvailable,
            systemCodexVersion,
            registryError,
            isChecking: selectedMachineCapabilities.status === 'loading',
            isInstalling: isInstallingCodexResume,
            onCheckUpdates: checkCodexResumeUpdates,
            onInstallOrUpdate: handleInstallOrUpdateCodexResume,
        };
    }, [
        checkCodexResumeUpdates,
        cliAvailability.codex,
        codexResumeDep,
        codexResumeLatestVersion,
        codexResumeUpdateAvailable,
        handleInstallOrUpdateCodexResume,
        isInstallingCodexResume,
        selectedMachineCapabilities.status,
        selectedMachineId,
        systemCodexVersion,
        wantsCodexResume,
    ]);

    const wizardAgentProps = React.useMemo(() => {
        return {
            cliAvailability,
            tmuxRequested,
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
            permissionMode,
            handlePermissionModeChange,
            sessionType,
            setSessionType,
            codexResumeBanner,
        };
    }, [
        agentType,
        allowGemini,
        cliAvailability,
        codexResumeBanner,
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
        tmuxRequested,
    ]);

    const wizardMachineProps = React.useMemo(() => {
        return {
            machines,
            selectedMachine: selectedMachine || null,
            recentMachines,
            favoriteMachineItems,
            useMachinePickerSearch,
            onRefreshMachines: refreshMachineData,
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
        refreshMachineData,
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
            connectionStatus,
            selectedProfileEnvVarsCount,
            handleEnvVarsClick,
            resumeSessionId,
            onResumeClick: canAgentResume(agentType, { allowCodexResume: experimentsEnabled && expCodexResume }) ? handleResumeClick : undefined,
        };
    }, [
        agentType,
        canCreate,
        connectionStatus,
        expCodexResume,
        experimentsEnabled,
        emptyAutocompletePrefixes,
        emptyAutocompleteSuggestions,
        handleCreateSession,
        handleEnvVarsClick,
        handleResumeClick,
        isCreating,
        resumeSessionId,
        selectedProfileEnvVarsCount,
        sessionPrompt,
        setSessionPrompt,
    ]);

    return (
        Platform.OS === 'web' ? (
            <BaseModal
                visible={true}
                onClose={() => router.back()}
                closeOnBackdrop={true}
                showBackdrop={true}
            >
                <View
                    style={[
                        {
                            width: '100%',
                            maxWidth: Math.min(layout.maxWidth ?? 920, screenWidth - 24),
                            maxHeight: screenHeight - 24,
                            borderRadius: 16,
                            overflow: 'hidden',
                            backgroundColor: theme.colors.surface,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: theme.colors.divider,
                        } as any,
                    ]}
                >
                    <View
                        style={{
                            height: 52,
                            paddingHorizontal: 16,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            borderBottomWidth: StyleSheet.hairlineWidth,
                            borderBottomColor: theme.colors.divider,
                            backgroundColor: theme.colors.surface,
                        }}
                    >
                        <Text style={{ fontSize: 17, fontWeight: '600', color: theme.colors.text, ...Typography.default('semiBold') }}>
                            {t('newSession.title')}
                        </Text>
                        <Pressable
                            onPress={() => router.back()}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                        >
                            <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>

                    <View
                        ref={popoverBoundaryRef}
                        style={{ flex: 1, width: '100%', minHeight: 0 } as any}
                    >
                        <PopoverBoundaryProvider boundaryRef={popoverBoundaryRef}>
                            <NewSessionWizard
                                layout={wizardLayoutProps}
                                profiles={wizardProfilesProps}
                                agent={wizardAgentProps}
                                machine={wizardMachineProps}
                                footer={wizardFooterProps}
                            />
                        </PopoverBoundaryProvider>
                    </View>
                </View>
            </BaseModal>
        ) : (
            <View ref={popoverBoundaryRef} style={{ flex: 1, width: '100%' }}>
                <PopoverBoundaryProvider boundaryRef={popoverBoundaryRef}>
                    <NewSessionWizard
                        layout={wizardLayoutProps}
                        profiles={wizardProfilesProps}
                        agent={wizardAgentProps}
                        machine={wizardMachineProps}
                        footer={wizardFooterProps}
                    />
                </PopoverBoundaryProvider>
            </View>
        )
    );
}

export default React.memo(NewSessionScreen);
