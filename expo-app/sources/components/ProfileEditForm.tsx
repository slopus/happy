import React from 'react';
import { View, Text, TextInput, ViewStyle, Linking, Platform, Pressable, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AIBackendProfile } from '@/sync/settings';
import { normalizeProfileDefaultPermissionMode, type PermissionMode } from '@/sync/permissionTypes';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Switch } from '@/components/Switch';
import { getBuiltInProfileDocumentation } from '@/sync/profileUtils';
import { EnvironmentVariablesList } from '@/components/EnvironmentVariablesList';
import { useSetting, useAllMachines, useMachine, useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { MachineSelector } from '@/components/newSession/MachineSelector';
import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline } from '@/utils/machineUtils';
import { OptionTiles } from '@/components/OptionTiles';
import { useCLIDetection } from '@/hooks/useCLIDetection';
import { layout } from '@/components/layout';
import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/SecretRequirementModal';
import { parseEnvVarTemplate } from '@/utils/envVarTemplate';

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

interface MachinePreviewModalProps {
    machines: Machine[];
    favoriteMachineIds: string[];
    selectedMachineId: string | null;
    onSelect: (machineId: string) => void;
    onToggleFavorite: (machineId: string) => void;
    onClose: () => void;
}

function MachinePreviewModal(props: MachinePreviewModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { height: windowHeight } = useWindowDimensions();

    const selectedMachine = React.useMemo(() => {
        if (!props.selectedMachineId) return null;
        return props.machines.find((m) => m.id === props.selectedMachineId) ?? null;
    }, [props.machines, props.selectedMachineId]);

    const favoriteMachines = React.useMemo(() => {
        const byId = new Map(props.machines.map((m) => [m.id, m] as const));
        return props.favoriteMachineIds.map((id) => byId.get(id)).filter(Boolean) as Machine[];
    }, [props.favoriteMachineIds, props.machines]);

    const maxHeight = Math.min(720, Math.max(420, Math.floor(windowHeight * 0.85)));

    return (
        <View style={[styles.machinePreviewModalContainer, { height: maxHeight, maxHeight }]}>
            <View style={styles.machinePreviewModalHeader}>
                <Text style={styles.machinePreviewModalTitle}>
                    {t('profiles.previewMachine.title')}
                </Text>

                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={{ flex: 1 }}>
                <MachineSelector
                    machines={props.machines}
                    selectedMachine={selectedMachine}
                    favoriteMachines={favoriteMachines}
                    showRecent={false}
                    showFavorites={favoriteMachines.length > 0}
                    showSearch
                    searchPlacement={favoriteMachines.length > 0 ? 'favorites' : 'all'}
                    onSelect={(machine) => {
                        props.onSelect(machine.id);
                        props.onClose();
                    }}
                    onToggleFavorite={(machine) => props.onToggleFavorite(machine.id)}
                />
            </View>
        </View>
    );
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
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;
    const styles = stylesheet;
    const experimentsEnabled = useSetting('experiments');
    const expGemini = useSetting('expGemini');
    const allowGemini = experimentsEnabled && expGemini;
    const machines = useAllMachines();
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');
    const routeMachine = machineId;
    const [previewMachineId, setPreviewMachineId] = React.useState<string | null>(routeMachine);

    React.useEffect(() => {
        setPreviewMachineId(routeMachine);
    }, [routeMachine]);

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
        Modal.show({
            component: MachinePreviewModalWrapper,
            props: {},
        });
    }, [MachinePreviewModalWrapper]);

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
    const [defaultPermissionMode, setDefaultPermissionMode] = React.useState<PermissionMode>(
        normalizeProfileDefaultPermissionMode(profile.defaultPermissionMode as PermissionMode),
    );
    const [compatibility, setCompatibility] = React.useState<NonNullable<AIBackendProfile['compatibility']>>(
        profile.compatibility || { claude: true, codex: true, gemini: true },
    );

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
        const options: Array<'claude-code' | 'codex' | 'gemini-cli'> = [];
        if (compatibility.claude) options.push('claude-code');
        if (compatibility.codex) options.push('codex');
        if (allowGemini && compatibility.gemini) options.push('gemini-cli');
        return options;
    }, [allowGemini, compatibility.claude, compatibility.codex, compatibility.gemini]);

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
            defaultPermissionMode,
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
            defaultPermissionMode,
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
        defaultPermissionMode,
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

    const toggleCompatibility = React.useCallback((key: keyof AIBackendProfile['compatibility']) => {
        setCompatibility((prev) => {
            const next = { ...prev, [key]: !prev[key] };
            const enabledCount = Object.values(next).filter(Boolean).length;
            if (enabledCount === 0) {
                Modal.alert(t('common.error'), t('profiles.aiBackend.selectAtLeastOneError'));
                return prev;
            }
            return next;
        });
    }, []);

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

        return onSave({
            ...profile,
            name: name.trim(),
            environmentVariables,
            authMode,
            requiresMachineLogin: authMode === 'machineLogin' && allowedMachineLoginOptions.length === 1
                ? allowedMachineLoginOptions[0]
                : undefined,
            envVarRequirements: derivedEnvVarRequirements,
            defaultSessionType,
            defaultPermissionMode,
            compatibility,
            updatedAt: Date.now(),
        });
    }, [
        allowedMachineLoginOptions,
        derivedEnvVarRequirements,
        compatibility,
        defaultPermissionMode,
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
        <ItemList style={containerStyle} keyboardShouldPersistTaps="handled">
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

                    const claudeDefaultSubtitle = t('profiles.aiBackend.claudeSubtitle');
                    const codexDefaultSubtitle = t('profiles.aiBackend.codexSubtitle');
                    const geminiDefaultSubtitle = t('profiles.aiBackend.geminiSubtitleExperimental');

                    const claudeSubtitle = shouldShowLoginStatus
                        ? (typeof cliDetection.login.claude === 'boolean' ? renderLoginStatus(cliDetection.login.claude) : claudeDefaultSubtitle)
                        : claudeDefaultSubtitle;
                    const codexSubtitle = shouldShowLoginStatus
                        ? (typeof cliDetection.login.codex === 'boolean' ? renderLoginStatus(cliDetection.login.codex) : codexDefaultSubtitle)
                        : codexDefaultSubtitle;
                    const geminiSubtitle = shouldShowLoginStatus
                        ? (typeof cliDetection.login.gemini === 'boolean' ? renderLoginStatus(cliDetection.login.gemini) : geminiDefaultSubtitle)
                        : geminiDefaultSubtitle;

                    return (
                        <>
                            <Item
                                title={t('agentInput.agent.claude')}
                                subtitle={claudeSubtitle}
                                leftElement={<Ionicons name="sparkles-outline" size={24} color={theme.colors.textSecondary} />}
                                rightElement={<Switch value={compatibility.claude} onValueChange={() => toggleCompatibility('claude')} />}
                                showChevron={false}
                                onPress={() => toggleCompatibility('claude')}
                            />
                            <Item
                                title={t('agentInput.agent.codex')}
                                subtitle={codexSubtitle}
                                leftElement={<Ionicons name="terminal-outline" size={24} color={theme.colors.textSecondary} />}
                                rightElement={<Switch value={compatibility.codex} onValueChange={() => toggleCompatibility('codex')} />}
                                showChevron={false}
                                onPress={() => toggleCompatibility('codex')}
                            />
                            {allowGemini && (
                                <Item
                                    title={t('agentInput.agent.gemini')}
                                    subtitle={geminiSubtitle}
                                    leftElement={<Ionicons name="planet-outline" size={24} color={theme.colors.textSecondary} />}
                                    rightElement={<Switch value={compatibility.gemini} onValueChange={() => toggleCompatibility('gemini')} />}
                                    showChevron={false}
                                    onPress={() => toggleCompatibility('gemini')}
                                    showDivider={false}
                                />
                            )}
                        </>
                    );
                })()}
            </ItemGroup>

            <ItemGroup title={t('profiles.defaultSessionType')}>
                <SessionTypeSelector value={defaultSessionType} onChange={setDefaultSessionType} title={null} />
            </ItemGroup>

            <ItemGroup title={t('profiles.defaultPermissionMode.title')}>
                {[
                    {
                        value: 'default' as PermissionMode,
                        label: t('agentInput.permissionMode.default'),
                        description: t('profiles.defaultPermissionMode.descriptions.default'),
                        icon: 'shield-outline'
                    },
                    {
                        value: 'acceptEdits' as PermissionMode,
                        label: t('agentInput.permissionMode.acceptEdits'),
                        description: t('profiles.defaultPermissionMode.descriptions.acceptEdits'),
                        icon: 'checkmark-outline'
                    },
                    {
                        value: 'plan' as PermissionMode,
                        label: t('agentInput.permissionMode.plan'),
                        description: t('profiles.defaultPermissionMode.descriptions.plan'),
                        icon: 'list-outline'
                    },
                    {
                        value: 'bypassPermissions' as PermissionMode,
                        label: t('agentInput.permissionMode.bypassPermissions'),
                        description: t('profiles.defaultPermissionMode.descriptions.bypassPermissions'),
                        icon: 'flash-outline'
                    },
                ].map((option, index, array) => (
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
                        rightElement={
                            defaultPermissionMode === option.value ? (
                                <Ionicons name="checkmark-circle" size={24} color={selectedIndicatorColor} />
                            ) : null
                        }
                        onPress={() => setDefaultPermissionMode(option.value)}
                        showChevron={false}
                        selected={defaultPermissionMode === option.value}
                        showDivider={index < array.length - 1}
                    />
                ))}
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
    machinePreviewModalContainer: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
    },
    machinePreviewModalHeader: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    machinePreviewModalTitle: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
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
