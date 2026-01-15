import React from 'react';
import { View, Text, TextInput, ViewStyle, Linking, Platform, Pressable, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AIBackendProfile } from '@/sync/settings';
import type { PermissionMode } from '@/sync/permissionTypes';
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

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
    onDirtyChange?: (isDirty: boolean) => void;
    containerStyle?: ViewStyle;
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
        <View style={{
            width: '92%',
            maxWidth: 560,
            height: maxHeight,
            maxHeight,
            backgroundColor: theme.colors.groupped.background,
            borderRadius: 16,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: theme.colors.divider,
            flexShrink: 1,
        }}>
            <View style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.divider,
            }}>
                <Text style={{
                    fontSize: 17,
                    color: theme.colors.text,
                    ...Typography.default('semiBold'),
                }}>
                    Preview Machine
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
}: ProfileEditFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const groupStyle = React.useMemo(() => ({ marginBottom: 12 }), []);
    const experimentsEnabled = useSetting('experiments');
    const machines = useAllMachines();
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const routeMachine = machineId;
    const [previewMachineId, setPreviewMachineId] = React.useState<string | null>(routeMachine);

    React.useEffect(() => {
        setPreviewMachineId(routeMachine);
    }, [routeMachine]);

    const resolvedMachineId = routeMachine ?? previewMachineId;
    const resolvedMachine = useMachine(resolvedMachineId ?? '');

    const toggleFavoriteMachineId = React.useCallback((machineIdToToggle: string) => {
        if (favoriteMachines.includes(machineIdToToggle)) {
            setFavoriteMachines(favoriteMachines.filter((id) => id !== machineIdToToggle));
        } else {
            setFavoriteMachines([machineIdToToggle, ...favoriteMachines]);
        }
    }, [favoriteMachines, setFavoriteMachines]);

    const showMachinePreviewPicker = React.useCallback(() => {
        Modal.show({
            component: MachinePreviewModal,
            props: {
                machines,
                favoriteMachineIds: favoriteMachines,
                selectedMachineId: previewMachineId,
                onSelect: setPreviewMachineId,
                onToggleFavorite: toggleFavoriteMachineId,
            },
        } as any);
    }, [favoriteMachines, machines, previewMachineId, toggleFavoriteMachineId]);

    const profileDocs = React.useMemo(() => {
        if (!profile.isBuiltIn) return null;
        return getBuiltInProfileDocumentation(profile.id);
    }, [profile.id, profile.isBuiltIn]);

    const [environmentVariables, setEnvironmentVariables] = React.useState<Array<{ name: string; value: string }>>(
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
        (profile.defaultPermissionMode as PermissionMode) || 'default',
    );
    const [compatibility, setCompatibility] = React.useState<NonNullable<AIBackendProfile['compatibility']>>(
        profile.compatibility || { claude: true, codex: true, gemini: true },
    );

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
        });
        return currentSnapshot !== initialSnapshotRef.current;
    }, [
        compatibility,
        defaultPermissionMode,
        defaultSessionType,
        environmentVariables,
        name,
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
                Modal.alert(t('common.error'), 'Select at least one AI backend.');
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

    const handleSave = React.useCallback(() => {
        if (!name.trim()) {
            Modal.alert(t('common.error'), 'Enter a profile name.');
            return;
        }

        onSave({
            ...profile,
            name: name.trim(),
            environmentVariables,
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
        compatibility,
        defaultPermissionMode,
        defaultSessionType,
        environmentVariables,
        name,
        onSave,
        profile,
        tmuxSession,
        tmuxTmpDir,
        useTmux,
    ]);

    return (
        <ItemList style={containerStyle} keyboardShouldPersistTaps="handled">
            <ItemGroup title={t('profiles.profileName')} style={groupStyle}>
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
                <ItemGroup title="Setup Instructions" footer={profileDocs.description} style={groupStyle}>
                    <Item
                        title="View Official Setup Guide"
                        icon={<Ionicons name="book-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={() => void openSetupGuide()}
                    />
                </ItemGroup>
            )}

            <ItemGroup title="Default Session Type" style={groupStyle}>
                <SessionTypeSelector value={defaultSessionType} onChange={setDefaultSessionType} title={null} />
            </ItemGroup>

            <ItemGroup title="Default Permission Mode" style={groupStyle}>
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
                                color={theme.colors.textSecondary}
                            />
                        }
                        rightElement={
                            defaultPermissionMode === option.value ? (
                                <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} />
                            ) : null
                        }
                        onPress={() => setDefaultPermissionMode(option.value)}
                        showChevron={false}
                        selected={defaultPermissionMode === option.value}
                        showDivider={index < array.length - 1}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title="AI Backend" style={groupStyle}>
                <Item
                    title="Claude"
                    subtitle="Claude CLI"
                    leftElement={<Ionicons name="sparkles-outline" size={24} color={theme.colors.textSecondary} />}
                    rightElement={<Switch value={compatibility.claude} onValueChange={() => toggleCompatibility('claude')} />}
                    showChevron={false}
                    onPress={() => toggleCompatibility('claude')}
                />
                <Item
                    title="Codex"
                    subtitle="Codex CLI"
                    leftElement={<Ionicons name="terminal-outline" size={24} color={theme.colors.textSecondary} />}
                    rightElement={<Switch value={compatibility.codex} onValueChange={() => toggleCompatibility('codex')} />}
                    showChevron={false}
                    onPress={() => toggleCompatibility('codex')}
                />
                {experimentsEnabled && (
                    <Item
                        title="Gemini"
                        subtitle="Gemini CLI (experimental)"
                        leftElement={<Ionicons name="planet-outline" size={24} color={theme.colors.textSecondary} />}
                        rightElement={<Switch value={compatibility.gemini} onValueChange={() => toggleCompatibility('gemini')} />}
                        showChevron={false}
                        onPress={() => toggleCompatibility('gemini')}
                        showDivider={false}
                    />
                )}
            </ItemGroup>

            <ItemGroup title="Tmux" style={groupStyle}>
                <Item
                    title="Spawn Sessions in Tmux"
                    subtitle={useTmux ? 'Sessions spawn in new tmux windows.' : 'Sessions spawn in regular shell (no tmux integration)'}
                    rightElement={<Switch value={useTmux} onValueChange={setUseTmux} />}
                    showChevron={false}
                    onPress={() => setUseTmux((v) => !v)}
                />
                {useTmux && (
                    <React.Fragment>
                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>Tmux Session Name ({t('common.optional')})</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder="Empty = current/most recent session"
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={tmuxSession}
                                onChangeText={setTmuxSession}
                            />
                        </View>
                        <View style={[styles.inputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                            <Text style={styles.fieldLabel}>Tmux Temp Directory ({t('common.optional')})</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder="/tmp (optional)"
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
                <ItemGroup title="Preview Machine" style={groupStyle}>
                    <Item
                        title={resolvedMachine ? (resolvedMachine.metadata?.displayName || resolvedMachine.metadata?.host || resolvedMachine.id) : 'Select machine'}
                        subtitle={resolvedMachine ? 'Resolve machine environment variables for this profile.' : 'Select a machine to preview resolved values.'}
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={showMachinePreviewPicker}
                    />
                </ItemGroup>
            )}

            <View style={groupStyle}>
                <EnvironmentVariablesList
                    environmentVariables={environmentVariables}
                    machineId={resolvedMachineId}
                    machineName={resolvedMachine ? (resolvedMachine.metadata?.displayName || resolvedMachine.metadata?.host || resolvedMachine.id) : null}
                    profileDocs={profileDocs}
                    onChange={setEnvironmentVariables}
                />
            </View>

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
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 8,
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
