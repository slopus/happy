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
    const [useTmux, setUseTmux] = React.useState(profile.tmuxConfig?.sessionName !== undefined);
    const [tmuxSession, setTmuxSession] = React.useState(profile.tmuxConfig?.sessionName || '');
    const [tmuxTmpDir, setTmuxTmpDir] = React.useState(profile.tmuxConfig?.tmpDir || '');
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
    const [requiredEnvVars, setRequiredEnvVars] = React.useState<NonNullable<AIBackendProfile['requiredEnvVars']>>(profile.requiredEnvVars ?? []);

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
            useTmux,
            tmuxSession,
            tmuxTmpDir,
            defaultSessionType,
            defaultPermissionMode,
            compatibility,
            authMode,
            requiresMachineLogin,
            requiredEnvVars,
        });
    }

    const isDirty = React.useMemo(() => {
        const currentSnapshot = JSON.stringify({
            name,
            environmentVariables,
            useTmux,
            tmuxSession,
            tmuxTmpDir,
            defaultSessionType,
            defaultPermissionMode,
            compatibility,
            authMode,
            requiresMachineLogin,
            requiredEnvVars,
        });
        return currentSnapshot !== initialSnapshotRef.current;
    }, [
        authMode,
        compatibility,
        defaultPermissionMode,
        defaultSessionType,
        environmentVariables,
        name,
        requiredEnvVars,
        requiresMachineLogin,
        tmuxSession,
        tmuxTmpDir,
        useTmux,
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
            requiredEnvVars: authMode === 'apiKeyEnv' ? requiredEnvVars : undefined,
            tmuxConfig: useTmux
                ? {
                      ...(profile.tmuxConfig ?? {}),
                      sessionName: tmuxSession.trim() || '',
                      tmpDir: tmuxTmpDir.trim() || undefined,
                  }
                : undefined,
            defaultSessionType,
            defaultPermissionMode,
            compatibility,
            updatedAt: Date.now(),
        });
    }, [
        allowedMachineLoginOptions,
        compatibility,
        defaultPermissionMode,
        defaultSessionType,
        environmentVariables,
        name,
        onSave,
        profile,
        authMode,
        requiredEnvVars,
        tmuxSession,
        tmuxTmpDir,
        useTmux,
    ]);

    const editRequiredSecretEnvVar = React.useCallback(async () => {
        const current = requiredEnvVars.find((v) => (v?.kind ?? 'secret') === 'secret')?.name ?? '';
        const name = await Modal.prompt(
            t('profiles.requirements.modalTitle'),
            t('profiles.requirements.secretEnvVarPromptDescription'),
            { defaultValue: current, placeholder: 'OPENAI_API_KEY', cancelText: t('common.cancel'), confirmText: t('common.save') },
        );
        if (name === null) return;
        const normalized = name.trim().toUpperCase();
        if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
            Modal.alert(t('common.error'), t('profiles.environmentVariables.validation.invalidNameFormat'));
            return;
        }

        setRequiredEnvVars((prev) => {
            const withoutSecret = prev.filter((v) => (v?.kind ?? 'secret') !== 'secret');
            return [{ name: normalized, kind: 'secret' }, ...withoutSecret];
        });
    }, [requiredEnvVars]);

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

            <View style={styles.requirementsHeader}>
                <Text style={styles.requirementsTitle}>{t('profiles.requirements.sectionTitle')}</Text>
                <Text style={styles.requirementsSubtitle}>
                    {t('profiles.requirements.sectionSubtitle')}
                </Text>
            </View>

            <View style={styles.requirementsTilesContainer}>
                <OptionTiles
                    options={[
                        {
                            id: 'none',
                            title: t('profiles.requirements.options.none.title'),
                            subtitle: t('profiles.requirements.options.none.subtitle'),
                            icon: 'remove-circle-outline',
                        },
                        {
                            id: 'apiKeyEnv',
                            title: t('profiles.requirements.apiKeyRequired'),
                            subtitle: t('profiles.requirements.options.apiKeyEnv.subtitle'),
                            icon: 'key-outline',
                        },
                        {
                            id: 'machineLogin',
                            title: t('profiles.machineLogin.title'),
                            subtitle: t('profiles.requirements.options.machineLogin.subtitle'),
                            icon: 'terminal-outline',
                        },
                    ]}
                    value={(authMode ?? 'none') as 'none' | 'apiKeyEnv' | 'machineLogin'}
                    onChange={(next) => {
                        if (next === 'none') {
                            setAuthMode(undefined);
                            setRequiresMachineLogin(undefined);
                            setRequiredEnvVars([]);
                            return;
                        }
                        if (next === 'apiKeyEnv') {
                            setAuthMode('apiKeyEnv');
                            setRequiresMachineLogin(undefined);
                            return;
                        }
                        setAuthMode('machineLogin');
                        setRequiresMachineLogin(undefined);
                        setRequiredEnvVars([]);
                    }}
                />
            </View>

            {authMode === 'apiKeyEnv' && (
                <ItemGroup>
                    <Item
                        title={t('profiles.requirements.apiKeyEnvVar.title')}
                        subtitle={t('profiles.requirements.apiKeyEnvVar.subtitle')}
                        icon={<Ionicons name="key-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        showChevron={false}
                    />
                    <View style={[styles.inputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                        <Text style={styles.fieldLabel}>{t('profiles.requirements.apiKeyEnvVar.label')}</Text>
                        <TextInput
                            value={requiredEnvVars.find((v) => (v?.kind ?? 'secret') === 'secret')?.name ?? ''}
                            onChangeText={(value) => {
                                const normalized = value.trim().toUpperCase();
                                setRequiredEnvVars((prev) => {
                                    const withoutSecret = prev.filter((v) => (v?.kind ?? 'secret') !== 'secret');
                                    if (!normalized) return withoutSecret;
                                    return [{ name: normalized, kind: 'secret' }, ...withoutSecret];
                                });
                            }}
                            placeholder="OPENAI_API_KEY"
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            style={styles.textInput}
                        />
                    </View>
                </ItemGroup>
            )}

            {authMode === 'machineLogin' && (
                <ItemGroup>
                    <Item
                        title={t('profiles.machineLogin.title')}
                        subtitle={
                            t('profiles.requirements.options.machineLogin.longSubtitle')
                        }
                        icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        showChevron={false}
                        showDivider={false}
                    />
                </ItemGroup>
            )}

            <ItemGroup title={t('profiles.aiBackend.title')}>
                {(() => {
                    const shouldShowLoginStatus = authMode === 'machineLogin' && Boolean(resolvedMachineId);

                    const renderLoginStatus = (status: boolean) => (
                        <Text style={[styles.aiBackendStatus, { color: status ? theme.colors.status.connected : theme.colors.status.disconnected }]}>
                            {status ? 'Logged in' : 'Not logged in'}
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

            <ItemGroup title={t('profiles.tmux.title')}>
                <Item
                    title={t('profiles.tmux.spawnSessionsTitle')}
                    subtitle={useTmux ? t('profiles.tmux.spawnSessionsEnabledSubtitle') : t('profiles.tmux.spawnSessionsDisabledSubtitle')}
                    rightElement={<Switch value={useTmux} onValueChange={setUseTmux} />}
                    showChevron={false}
                    onPress={() => setUseTmux((v) => !v)}
                />
                {useTmux && (
                    <React.Fragment>
                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>{t('profiles.tmuxSession')} ({t('common.optional')})</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={tmuxSession}
                                onChangeText={setTmuxSession}
                            />
                        </View>
                        <View style={[styles.inputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                            <Text style={styles.fieldLabel}>{t('profiles.tmuxTempDir')} ({t('common.optional')})</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={tmuxTmpDir}
                                onChangeText={setTmuxTmpDir}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                        </View>
                    </React.Fragment>
                )}
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
