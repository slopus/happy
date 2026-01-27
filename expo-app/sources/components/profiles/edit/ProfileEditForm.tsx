import React from 'react';
import { View, Text, TextInput, ViewStyle, Linking, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AIBackendProfile } from '@/sync/settings';
import { normalizeProfileDefaultPermissionMode, type PermissionMode } from '@/sync/permissionTypes';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType, normalizePermissionModeForAgentType } from '@/sync/permissionModeOptions';
import { inferSourceModeGroupForPermissionMode } from '@/sync/permissionDefaults';
import { mapPermissionModeAcrossAgents } from '@/sync/permissionMapping';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getBuiltInProfileDocumentation } from '@/sync/profileUtils';
import { EnvironmentVariablesList } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';
import { useSetting, useAllMachines, useMachine, useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { isMachineOnline } from '@/utils/machineUtils';
import { OptionTiles } from '@/components/ui/forms/OptionTiles';
import { useCLIDetection } from '@/hooks/useCLIDetection';
import { layout } from '@/components/layout';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { parseEnvVarTemplate } from '@/utils/profiles/envVarTemplate';
import { useEnabledAgentIds } from '@/agents/useEnabledAgentIds';
import { DEFAULT_AGENT_ID, getAgentCore, type AgentId, type MachineLoginKey } from '@/agents/catalog';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MachinePreviewModal } from './MachinePreviewModal';

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    /**
     * Return true when the profile was successfully saved.
     * Return false when saving failed (e.g. validation error).
     */
    onSave: (profile: AIBackendProfile) => boolean;
    onCancel: () => void;
    onDirtyChange?: (isDirty: boolean) => void;
    containerStyle?: ViewStyle;
    saveRef?: React.MutableRefObject<(() => boolean) | null>;
}

export function ProfileEditForm({
    profile,
    machineId,
    onSave,
    onCancel,
    onDirtyChange,
    containerStyle,
    saveRef,
}: ProfileEditFormProps) {
    const { theme, rt } = useUnistyles();
    const router = useRouter();
    const routeParams = useLocalSearchParams<{ previewMachineId?: string | string[] }>();
    const previewMachineIdParam = Array.isArray(routeParams.previewMachineId) ? routeParams.previewMachineId[0] : routeParams.previewMachineId;
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;
    const styles = stylesheet;
    const popoverBoundaryRef = React.useRef<any>(null);
    const enabledAgentIds = useEnabledAgentIds();
    const machines = useAllMachines();
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const routeMachine = machineId;
    const [previewMachineId, setPreviewMachineId] = React.useState<string | null>(routeMachine);

    React.useEffect(() => {
        setPreviewMachineId(routeMachine);
    }, [routeMachine]);

    React.useEffect(() => {
        if (routeMachine) return;
        if (typeof previewMachineIdParam !== 'string') return;
        const trimmed = previewMachineIdParam.trim();
        if (trimmed.length === 0) {
            setPreviewMachineId(null);
            return;
        }
        setPreviewMachineId(trimmed);
    }, [previewMachineIdParam, routeMachine]);

    const resolvedMachineId = routeMachine ?? previewMachineId;
    const resolvedMachine = useMachine(resolvedMachineId ?? '');
    const cliDetection = useCLIDetection(resolvedMachineId, { includeLoginStatus: Boolean(resolvedMachineId) });

    const toggleFavoriteMachineId = React.useCallback((machineIdToToggle: string) => {
        if (favoriteMachines.includes(machineIdToToggle)) {
            setFavoriteMachines(favoriteMachines.filter((id) => id !== machineIdToToggle));
        } else {
            setFavoriteMachines([machineIdToToggle, ...favoriteMachines]);
        }
    }, [favoriteMachines, setFavoriteMachines]);

    const MachinePreviewModalWrapper = React.useCallback(({ onClose }: { onClose: () => void }) => {
        return (
            <MachinePreviewModal
                machines={machines}
                favoriteMachineIds={favoriteMachines}
                selectedMachineId={previewMachineId}
                onSelect={setPreviewMachineId}
                onToggleFavorite={toggleFavoriteMachineId}
                onClose={onClose}
            />
        );
    }, [favoriteMachines, machines, previewMachineId, toggleFavoriteMachineId]);

    const showMachinePreviewPicker = React.useCallback(() => {
        if (Platform.OS !== 'web') {
            const params = previewMachineId ? { selectedId: previewMachineId } : {};
            router.push({ pathname: '/new/pick/preview-machine', params } as any);
            return;
        }
        Modal.show({
            component: MachinePreviewModalWrapper,
            props: {},
        });
    }, [MachinePreviewModalWrapper, previewMachineId, router]);

    const profileDocs = React.useMemo(() => {
        if (!profile.isBuiltIn) return null;
        return getBuiltInProfileDocumentation(profile.id);
    }, [profile.id, profile.isBuiltIn]);

    const [environmentVariables, setEnvironmentVariables] = React.useState<Array<{ name: string; value: string; isSecret?: boolean }>>(
        profile.environmentVariables || [],
    );

    const [name, setName] = React.useState(profile.name || '');
    const [defaultSessionType, setDefaultSessionType] = React.useState<'simple' | 'worktree'>(
        profile.defaultSessionType || 'simple',
    );
    const sessionDefaultPermissionModeByAgent = useSetting('sessionDefaultPermissionModeByAgent');

    const [defaultPermissionModes, setDefaultPermissionModes] = React.useState<Partial<Record<AgentId, PermissionMode | null>>>(() => {
        const explicitByAgent = (profile.defaultPermissionModeByAgent as Record<string, PermissionMode | undefined>) ?? {};
        const out: Partial<Record<AgentId, PermissionMode | null>> = {};

        for (const agentId of enabledAgentIds) {
            const explicit = explicitByAgent[agentId];
            out[agentId] = explicit ? normalizePermissionModeForAgentType(explicit, agentId) : null;
        }

        const hasAnyExplicit = enabledAgentIds.some((agentId) => Boolean(out[agentId]));
        if (hasAnyExplicit) return out;

        const legacyRaw = profile.defaultPermissionMode as PermissionMode | undefined;
        const legacy = legacyRaw ? normalizeProfileDefaultPermissionMode(legacyRaw) : undefined;
        if (!legacy) return out;

        const fromGroup = inferSourceModeGroupForPermissionMode(legacy);
        const from =
            enabledAgentIds.find((id) => getAgentCore(id).permissions.modeGroup === fromGroup) ??
            enabledAgentIds[0] ??
            DEFAULT_AGENT_ID;
        const compat = profile.compatibility ?? {};

        for (const agentId of enabledAgentIds) {
            const explicitCompat = compat[agentId];
            const isCompat = typeof explicitCompat === 'boolean' ? explicitCompat : (profile.isBuiltIn ? false : true);
            if (!isCompat) continue;
            out[agentId] = normalizePermissionModeForAgentType(mapPermissionModeAcrossAgents(legacy, from, agentId), agentId);
        }

        return out;
    });

    const [compatibility, setCompatibility] = React.useState<NonNullable<AIBackendProfile['compatibility']>>(() => {
        const base: NonNullable<AIBackendProfile['compatibility']> = { ...(profile.compatibility ?? {}) };
        for (const agentId of enabledAgentIds) {
            if (typeof base[agentId] !== 'boolean') {
                base[agentId] = profile.isBuiltIn ? false : true;
            }
        }
        if (enabledAgentIds.length > 0 && enabledAgentIds.every((agentId) => base[agentId] !== true)) {
            base[enabledAgentIds[0]] = true;
        }
        return base;
    });

    React.useEffect(() => {
        setCompatibility((prev) => {
            let changed = false;
            const next: NonNullable<AIBackendProfile['compatibility']> = { ...prev };
            for (const agentId of enabledAgentIds) {
                if (typeof next[agentId] !== 'boolean') {
                    next[agentId] = profile.isBuiltIn ? false : true;
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [enabledAgentIds, profile.isBuiltIn]);

    const [authMode, setAuthMode] = React.useState<AIBackendProfile['authMode']>(profile.authMode);
    const [requiresMachineLogin, setRequiresMachineLogin] = React.useState<AIBackendProfile['requiresMachineLogin']>(profile.requiresMachineLogin);
    /**
     * Requirements live in the env-var editor UI, but are persisted in `profile.envVarRequirements`
     * (derived) and `secretBindingsByProfileId` (per-profile default saved secret choice).
     *
     * Attachment model:
     * - When a row uses `${SOURCE_VAR}`, requirements attach to `SOURCE_VAR`
     * - Otherwise, requirements attach to the env var name itself (e.g. `OPENAI_API_KEY`)
     */
    const [sourceRequirementsByName, setSourceRequirementsByName] = React.useState<Record<string, { required: boolean; useSecretVault: boolean }>>(() => {
        const map: Record<string, { required: boolean; useSecretVault: boolean }> = {};
        for (const req of profile.envVarRequirements ?? []) {
            if (!req || typeof (req as any).name !== 'string') continue;
            const name = String((req as any).name).trim().toUpperCase();
            if (!name) continue;
            const kind = ((req as any).kind ?? 'secret') as 'secret' | 'config';
            map[name] = {
                required: Boolean((req as any).required),
                useSecretVault: kind === 'secret',
            };
        }
        return map;
    });

    const usedRequirementVarNames = React.useMemo(() => {
        const set = new Set<string>();
        for (const v of environmentVariables) {
            const tpl = parseEnvVarTemplate(v.value);
            const name = (tpl?.sourceVar ? tpl.sourceVar : v.name).trim().toUpperCase();
            if (name) set.add(name);
        }
        return set;
    }, [environmentVariables]);

    // Prune requirements that no longer correspond to any referenced requirement var name.
    React.useEffect(() => {
        setSourceRequirementsByName((prev) => {
            let changed = false;
            const next: Record<string, { required: boolean; useSecretVault: boolean }> = {};
            for (const [name, state] of Object.entries(prev)) {
                if (usedRequirementVarNames.has(name)) {
                    next[name] = state;
                } else {
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [usedRequirementVarNames]);

    // Prune default secret bindings when the requirement var name is no longer used or no longer uses the vault.
    React.useEffect(() => {
        const existing = secretBindingsByProfileId[profile.id];
        if (!existing) return;

        let changed = false;
        const nextBindings: Record<string, string> = {};
        for (const [envVarName, secretId] of Object.entries(existing)) {
            const req = sourceRequirementsByName[envVarName];
            const keep = usedRequirementVarNames.has(envVarName) && Boolean(req?.useSecretVault);
            if (keep) {
                nextBindings[envVarName] = secretId;
            } else {
                changed = true;
            }
        }
        if (!changed) return;

        const out = { ...secretBindingsByProfileId };
        if (Object.keys(nextBindings).length === 0) {
            delete out[profile.id];
        } else {
            out[profile.id] = nextBindings;
        }
        setSecretBindingsByProfileId(out);
    }, [profile.id, secretBindingsByProfileId, setSecretBindingsByProfileId, sourceRequirementsByName, usedRequirementVarNames]);

    const derivedEnvVarRequirements = React.useMemo<NonNullable<AIBackendProfile['envVarRequirements']>>(() => {
        const out = Object.entries(sourceRequirementsByName)
            .filter(([name]) => usedRequirementVarNames.has(name))
            .map(([name, state]) => ({
                name,
                kind: state.useSecretVault ? 'secret' as const : 'config' as const,
                required: Boolean(state.required),
            }));
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }, [sourceRequirementsByName, usedRequirementVarNames]);

    const getDefaultSecretNameForSourceVar = React.useCallback((sourceVarName: string): string | null => {
        const id = secretBindingsByProfileId[profile.id]?.[sourceVarName] ?? null;
        if (!id) return null;
        return secrets.find((s) => s.id === id)?.name ?? null;
    }, [profile.id, secretBindingsByProfileId, secrets]);

    const openDefaultSecretModalForSourceVar = React.useCallback((sourceVarName: string) => {
        const normalized = sourceVarName.trim().toUpperCase();
        if (!normalized) return;

        // Use derived requirements so the modal reflects the current editor state.
        const previewProfile: AIBackendProfile = {
            ...profile,
            name,
            envVarRequirements: derivedEnvVarRequirements,
        };

        const defaultSecretId = secretBindingsByProfileId[profile.id]?.[normalized] ?? null;

        const setDefaultSecretId = (id: string | null) => {
            const existing = secretBindingsByProfileId[profile.id] ?? {};
            const nextBindings = { ...existing };
            if (!id) {
                delete nextBindings[normalized];
            } else {
                nextBindings[normalized] = id;
            }
            const out = { ...secretBindingsByProfileId };
            if (Object.keys(nextBindings).length === 0) {
                delete out[profile.id];
            } else {
                out[profile.id] = nextBindings;
            }
            setSecretBindingsByProfileId(out);
        };

        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action !== 'selectSaved') return;
            setDefaultSecretId(result.secretId);
        };

        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile: previewProfile,
                secretEnvVarName: normalized,
                machineId: null,
                secrets,
                defaultSecretId,
                selectedSavedSecretId: defaultSecretId,
                onSetDefaultSecretId: setDefaultSecretId,
                variant: 'defaultForProfile',
                titleOverride: t('secrets.defineDefaultForProfileTitle'),
                onChangeSecrets: setSecrets,
                allowSessionOnly: false,
                onResolve: handleResolve,
                onRequestClose: () => handleResolve({ action: 'cancel' } as SecretRequirementModalResult),
            },
            closeOnBackdrop: true,
        });
    }, [derivedEnvVarRequirements, name, profile, secretBindingsByProfileId, secrets, setSecretBindingsByProfileId, setSecrets]);

    const updateSourceRequirement = React.useCallback((
        sourceVarName: string,
        next: { required: boolean; useSecretVault: boolean } | null
    ) => {
        const normalized = sourceVarName.trim().toUpperCase();
        if (!normalized) return;

        setSourceRequirementsByName((prev) => {
            const out = { ...prev };
            if (next === null) {
                delete out[normalized];
            } else {
                out[normalized] = { required: Boolean(next.required), useSecretVault: Boolean(next.useSecretVault) };
            }
            return out;
        });

        // If the vault is disabled (or requirement removed), drop any default secret binding immediately.
        if (next === null || next.useSecretVault !== true) {
            const existing = secretBindingsByProfileId[profile.id];
            if (existing && (normalized in existing)) {
                const nextBindings = { ...existing };
                delete nextBindings[normalized];
                const out = { ...secretBindingsByProfileId };
                if (Object.keys(nextBindings).length === 0) {
                    delete out[profile.id];
                } else {
                    out[profile.id] = nextBindings;
                }
                setSecretBindingsByProfileId(out);
            }
        }
    }, [profile.id, secretBindingsByProfileId, setSecretBindingsByProfileId]);

    const allowedMachineLoginOptions = React.useMemo(() => {
        const options: MachineLoginKey[] = [];
        for (const agentId of enabledAgentIds) {
            if (compatibility[agentId] !== true) continue;
            options.push(getAgentCore(agentId).cli.machineLoginKey);
        }
        return options;
    }, [compatibility, enabledAgentIds]);

    const [openPermissionProvider, setOpenPermissionProvider] = React.useState<null | AgentId>(null);

    const setDefaultPermissionModeForProvider = React.useCallback((provider: AgentId, next: PermissionMode | null) => {
        setDefaultPermissionModes((prev) => {
            if (prev[provider] === next) return prev;
            return { ...prev, [provider]: next };
        });
    }, []);

    const accountDefaultPermissionModes = React.useMemo(() => {
        const out: Partial<Record<AgentId, PermissionMode>> = {};
        for (const agentId of enabledAgentIds) {
            const raw = (sessionDefaultPermissionModeByAgent as any)?.[agentId] as PermissionMode | undefined;
            out[agentId] = normalizePermissionModeForAgentType((raw ?? 'default') as PermissionMode, agentId);
        }
        return out;
    }, [enabledAgentIds, sessionDefaultPermissionModeByAgent]);

    const getPermissionIconNameForAgent = React.useCallback((agent: AgentId, mode: PermissionMode) => {
        return getPermissionModeOptionsForAgentType(agent).find((opt) => opt.value === mode)?.icon ?? 'shield-outline';
    }, []);

    React.useEffect(() => {
        if (authMode !== 'machineLogin') return;
        // If exactly one backend is enabled, we can persist the explicit CLI requirement.
        // If multiple are enabled, the required CLI is derived at session-start from the selected backend.
        if (allowedMachineLoginOptions.length === 1) {
            const only = allowedMachineLoginOptions[0];
            if (requiresMachineLogin !== only) {
                setRequiresMachineLogin(only);
            }
            return;
        }
        if (requiresMachineLogin) {
            setRequiresMachineLogin(undefined);
        }
    }, [allowedMachineLoginOptions, authMode, requiresMachineLogin]);

    const initialSnapshotRef = React.useRef<string | null>(null);
    if (initialSnapshotRef.current === null) {
        initialSnapshotRef.current = JSON.stringify({
            name,
            environmentVariables,
            defaultSessionType,
            defaultPermissionModes,
            compatibility,
            authMode,
            requiresMachineLogin,
            derivedEnvVarRequirements,
            // Bindings are settings-level but edited here; include for dirty tracking.
            secretBindings: secretBindingsByProfileId[profile.id] ?? null,
        });
    }

    const isDirty = React.useMemo(() => {
        const currentSnapshot = JSON.stringify({
            name,
            environmentVariables,
            defaultSessionType,
            defaultPermissionModes,
            compatibility,
            authMode,
            requiresMachineLogin,
            derivedEnvVarRequirements,
            secretBindings: secretBindingsByProfileId[profile.id] ?? null,
        });
        return currentSnapshot !== initialSnapshotRef.current;
    }, [
        authMode,
        compatibility,
        defaultPermissionModes,
        defaultSessionType,
        environmentVariables,
        name,
        derivedEnvVarRequirements,
        requiresMachineLogin,
        secretBindingsByProfileId,
        profile.id,
    ]);

    React.useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    const toggleCompatibility = React.useCallback((agentId: AgentId) => {
        setCompatibility((prev) => {
            const next = { ...prev, [agentId]: !prev[agentId] };
            const enabledCount = enabledAgentIds.filter((id) => next[id] === true).length;
            if (enabledCount === 0) {
                Modal.alert(t('common.error'), t('profiles.aiBackend.selectAtLeastOneError'));
                return prev;
            }
            return next;
        });
    }, [enabledAgentIds]);

    const openSetupGuide = React.useCallback(async () => {
        const url = profileDocs?.setupGuideUrl;
        if (!url) return;
        try {
            if (Platform.OS === 'web') {
                window.open(url, '_blank');
            } else {
                await Linking.openURL(url);
            }
        } catch (error) {
            console.error('Failed to open URL:', error);
        }
    }, [profileDocs?.setupGuideUrl]);

    const handleSave = React.useCallback((): boolean => {
        if (!name.trim()) {
            Modal.alert(t('common.error'), t('profiles.nameRequired'));
            return false;
        }

        const { defaultPermissionModeClaude, defaultPermissionModeCodex, defaultPermissionModeGemini, ...profileBase } = profile as any;
        const defaultPermissionModeByAgent: Record<string, PermissionMode> = {};
        for (const agentId of enabledAgentIds) {
            const mode = (defaultPermissionModes as any)?.[agentId] as PermissionMode | null | undefined;
            if (mode) defaultPermissionModeByAgent[agentId] = mode;
        }

        return onSave({
            ...profileBase,
            name: name.trim(),
            environmentVariables,
            authMode,
            requiresMachineLogin: authMode === 'machineLogin' && allowedMachineLoginOptions.length === 1
                ? allowedMachineLoginOptions[0]
                : undefined,
            envVarRequirements: derivedEnvVarRequirements,
            defaultSessionType,
            // Prefer provider-specific defaults; clear legacy field on save.
            defaultPermissionMode: undefined,
            defaultPermissionModeByAgent,
            compatibility,
            updatedAt: Date.now(),
        });
    }, [
        allowedMachineLoginOptions,
        enabledAgentIds,
        derivedEnvVarRequirements,
        compatibility,
        defaultPermissionModes,
        defaultSessionType,
        environmentVariables,
        name,
        onSave,
        profile,
        authMode,
    ]);

    React.useEffect(() => {
        if (!saveRef) {
            return;
        }
        saveRef.current = handleSave;
        return () => {
            saveRef.current = null;
        };
    }, [handleSave, saveRef]);

    return (
        <ItemList ref={popoverBoundaryRef} style={containerStyle} keyboardShouldPersistTaps="handled">
            <ItemGroup title={t('profiles.profileName')}>
                <React.Fragment>
                    <View style={styles.inputContainer}>
                        <TextInput
                            style={styles.textInput}
                            placeholder={t('profiles.enterName')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={name}
                            onChangeText={setName}
                        />
                    </View>
                </React.Fragment>
            </ItemGroup>

            {profile.isBuiltIn && profileDocs?.setupGuideUrl && (
                <ItemGroup title={t('profiles.setupInstructions.title')} footer={profileDocs.description}>
                    <Item
                        title={t('profiles.setupInstructions.viewOfficialGuide')}
                        icon={<Ionicons name="book-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={() => void openSetupGuide()}
                    />
                </ItemGroup>
            )}

            <ItemGroup title={t('profiles.requirements.sectionTitle')} footer={t('profiles.requirements.sectionSubtitle')}>
                <Item
                    title={t('profiles.machineLogin.title')}
                    subtitle={t('profiles.machineLogin.subtitle')}
                    leftElement={<Ionicons name="terminal-outline" size={24} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={authMode === 'machineLogin'}
                            onValueChange={(next) => {
                                if (!next) {
                                    setAuthMode(undefined);
                                    setRequiresMachineLogin(undefined);
                                    return;
                                }
                                setAuthMode('machineLogin');
                                setRequiresMachineLogin(undefined);
                            }}
                        />
                    )}
                    showChevron={false}
                    onPress={() => {
                        const next = authMode !== 'machineLogin';
                        if (!next) {
                            setAuthMode(undefined);
                            setRequiresMachineLogin(undefined);
                            return;
                        }
                        setAuthMode('machineLogin');
                        setRequiresMachineLogin(undefined);
                    }}
                    showDivider={false}
                />
            </ItemGroup>

            <ItemGroup title={t('profiles.aiBackend.title')}>
                {(() => {
                    const shouldShowLoginStatus = authMode === 'machineLogin' && Boolean(resolvedMachineId);

                    const renderLoginStatus = (status: boolean) => (
                        <Text style={[styles.aiBackendStatus, { color: status ? theme.colors.status.connected : theme.colors.status.disconnected }]}>
                            {status ? t('profiles.machineLogin.status.loggedIn') : t('profiles.machineLogin.status.notLoggedIn')}
                        </Text>
                    );

                    return (
                        <>
                            {enabledAgentIds.map((agentId, index) => {
                                const core = getAgentCore(agentId);
                                const defaultSubtitle = t(core.subtitleKey);
                                const loginStatus = shouldShowLoginStatus ? cliDetection.login[agentId] : null;
                                const subtitle = shouldShowLoginStatus && typeof loginStatus === 'boolean'
                                    ? renderLoginStatus(loginStatus)
                                    : defaultSubtitle;
                                const enabled = compatibility[agentId] === true;
                                const showDivider = index < enabledAgentIds.length - 1;
                                return (
                                    <Item
                                        key={agentId}
                                        title={t(core.displayNameKey)}
                                        subtitle={subtitle}
                                        leftElement={<Ionicons name={core.ui.agentPickerIconName as any} size={24} color={theme.colors.textSecondary} />}
                                        rightElement={<Switch value={enabled} onValueChange={() => toggleCompatibility(agentId)} />}
                                        showChevron={false}
                                        onPress={() => toggleCompatibility(agentId)}
                                        showDivider={showDivider}
                                    />
                                );
                            })}
                        </>
                    );
                })()}
            </ItemGroup>

            <ItemGroup title={t('profiles.defaultSessionType')}>
                <SessionTypeSelector value={defaultSessionType} onChange={setDefaultSessionType} title={null} />
            </ItemGroup>

            <ItemGroup
                title="Default permissions"
                footer="Overrides the account-level default permissions for new sessions when this profile is selected."
            >
                {enabledAgentIds
                    .filter((agentId) => compatibility[agentId] === true)
                    .map((agentId, index, items) => {
                        const core = getAgentCore(agentId);
                        const override = (defaultPermissionModes as any)?.[agentId] as PermissionMode | null | undefined;
                        const accountDefault = ((accountDefaultPermissionModes as any)?.[agentId] ?? 'default') as PermissionMode;
                        const effectiveMode = (override ?? accountDefault) as PermissionMode;
                        const showDivider = index < items.length - 1;

                        return (
                            <DropdownMenu
                                key={agentId}
                                open={openPermissionProvider === agentId}
                                onOpenChange={(next) => setOpenPermissionProvider(next ? agentId : null)}
                                popoverBoundaryRef={popoverBoundaryRef}
                                variant="selectable"
                                search={false}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                selectedId={override ?? '__account__'}
                                trigger={({ open, toggle }) => (
                                    <Item
                                        selected={false}
                                        title={t(core.displayNameKey)}
                                        subtitle={override
                                            ? getPermissionModeLabelForAgentType(agentId, override)
                                            : `Account default: ${getPermissionModeLabelForAgentType(agentId, accountDefault)}`
                                        }
                                        icon={<Ionicons name={core.ui.agentPickerIconName as any} size={29} color={theme.colors.textSecondary} />}
                                        rightElement={(
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                <Ionicons
                                                    name={getPermissionIconNameForAgent(agentId, effectiveMode) as any}
                                                    size={22}
                                                    color={theme.colors.textSecondary}
                                                />
                                                <Ionicons
                                                    name={open ? 'chevron-up' : 'chevron-down'}
                                                    size={20}
                                                    color={theme.colors.textSecondary}
                                                />
                                            </View>
                                        )}
                                        showChevron={false}
                                        onPress={toggle}
                                        showDivider={showDivider}
                                    />
                                )}
                                items={[
                                    {
                                        id: '__account__',
                                        title: 'Use account default',
                                        subtitle: `Currently: ${getPermissionModeLabelForAgentType(agentId, accountDefault)}`,
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name="settings-outline" size={22} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    },
                                    ...getPermissionModeOptionsForAgentType(agentId).map((opt) => ({
                                        id: opt.value,
                                        title: opt.label,
                                        subtitle: opt.description,
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name={opt.icon as any} size={22} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    })),
                                ]}
                                onSelect={(id) => {
                                    if (id === '__account__') {
                                        setDefaultPermissionModeForProvider(agentId, null);
                                    } else {
                                        setDefaultPermissionModeForProvider(agentId, id as any);
                                    }
                                    setOpenPermissionProvider(null);
                                }}
                            />
                        );
                    })}
            </ItemGroup>

            {!routeMachine && (
                <ItemGroup title={t('profiles.previewMachine.title')}>
                    <Item
                        title={t('profiles.previewMachine.itemTitle')}
                        subtitle={resolvedMachine ? t('profiles.previewMachine.resolveSubtitle') : t('profiles.previewMachine.selectSubtitle')}
                        detail={resolvedMachine ? (resolvedMachine.metadata?.displayName || resolvedMachine.metadata?.host || resolvedMachine.id) : undefined}
                        detailStyle={resolvedMachine
                            ? { color: isMachineOnline(resolvedMachine) ? theme.colors.status.connected : theme.colors.status.disconnected }
                            : undefined}
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={showMachinePreviewPicker}
                    />
                </ItemGroup>
            )}

            <EnvironmentVariablesList
                environmentVariables={environmentVariables}
                machineId={resolvedMachineId}
                machineName={resolvedMachine ? (resolvedMachine.metadata?.displayName || resolvedMachine.metadata?.host || resolvedMachine.id) : null}
                profileDocs={profileDocs}
                onChange={setEnvironmentVariables}
                sourceRequirementsByName={sourceRequirementsByName}
                onUpdateSourceRequirement={updateSourceRequirement}
                getDefaultSecretNameForSourceVar={getDefaultSecretNameForSourceVar}
                onPickDefaultSecretForSourceVar={openDefaultSecretModalForSourceVar}
            />

            <View style={{ paddingHorizontal: Platform.select({ ios: 16, default: 12 }), paddingTop: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                        <Pressable
                            onPress={onCancel}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.surface,
                                borderRadius: 10,
                                paddingVertical: 12,
                                alignItems: 'center',
                                opacity: pressed ? 0.85 : 1,
                            })}
                        >
                            <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>
                                {t('common.cancel')}
                            </Text>
                        </Pressable>
                    </View>
                    <View style={{ flex: 1 }}>
                        <Pressable
                            onPress={handleSave}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.button.primary.background,
                                borderRadius: 10,
                                paddingVertical: 12,
                                alignItems: 'center',
                                opacity: pressed ? 0.85 : 1,
                            })}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                                {profile.isBuiltIn ? t('common.saveAs') : t('common.save')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </ItemList>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    selectorContainer: {
        paddingHorizontal: 12,
        paddingBottom: 4,
    },
    requirementsHeader: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingTop: Platform.select({ ios: 26, default: 20 }),
        paddingBottom: Platform.select({ ios: 8, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    requirementsTitle: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        textTransform: 'uppercase',
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
    },
    requirementsSubtitle: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0 }),
        marginTop: Platform.select({ ios: 6, default: 8 }),
    },
    requirementsTilesContainer: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: Platform.select({ ios: 16, default: 12 }),
        paddingBottom: 8,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 4,
    },
    aiBackendStatus: {
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
    multilineInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.input.text,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        minHeight: 120,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
}));
