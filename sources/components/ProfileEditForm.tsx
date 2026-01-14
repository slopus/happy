import React from 'react';
import { View, Text, TextInput, ViewStyle, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AIBackendProfile } from '@/sync/settings';
import { PermissionMode } from '@/components/PermissionModeSelector';
import { SessionTypeSelector } from '@/components/SessionTypeSelector';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Switch } from '@/components/Switch';
import { getBuiltInProfileDocumentation } from '@/sync/profileUtils';
import { EnvironmentVariablesList } from '@/components/EnvironmentVariablesList';
import { useSetting } from '@/sync/storage';
import { Modal } from '@/modal';
import { RoundButton } from '@/components/RoundButton';

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
    onDirtyChange?: (isDirty: boolean) => void;
    containerStyle?: ViewStyle;
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
            anthropicConfig: {},
            openaiConfig: {},
            azureOpenAIConfig: {},
            environmentVariables,
            tmuxConfig: useTmux
                ? {
                      sessionName: tmuxSession.trim() || '',
                      tmpDir: tmuxTmpDir.trim() || undefined,
                      updateEnvironment: undefined,
                  }
                : {
                      sessionName: undefined,
                      tmpDir: undefined,
                      updateEnvironment: undefined,
                  },
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
                    { value: 'default' as PermissionMode, label: 'Default', description: 'Ask for permissions', icon: 'shield-half-outline' },
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
                        pressableStyle={defaultPermissionMode === option.value ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
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
                                placeholder="Empty = first existing session"
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

            <View style={groupStyle}>
                <EnvironmentVariablesList
                    environmentVariables={environmentVariables}
                    machineId={machineId}
                    profileDocs={profileDocs}
                    onChange={setEnvironmentVariables}
                />
            </View>

            <View style={{ paddingHorizontal: Platform.select({ ios: 32, default: 24 }), paddingTop: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                        <RoundButton
                            size="normal"
                            display="inverted"
                            title={t('common.cancel')}
                            onPress={onCancel}
                            style={{ backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }}
                        />
                    </View>
                    <View style={{ flex: 1 }}>
                        <RoundButton
                            size="normal"
                            title={profile.isBuiltIn ? t('common.saveAs') : t('common.save')}
                            onPress={handleSave}
                        />
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
