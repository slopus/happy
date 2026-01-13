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

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
    containerStyle?: ViewStyle;
}

export function ProfileEditForm({
    profile,
    machineId,
    onSave,
    onCancel,
    containerStyle,
}: ProfileEditFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

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
            updatedAt: Date.now(),
        });
    }, [
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
                <ItemGroup title="Setup Instructions" footer={profileDocs.description}>
                    <Item
                        title="View Official Setup Guide"
                        icon={<Ionicons name="book-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={() => void openSetupGuide()}
                    />
                </ItemGroup>
            )}

            <ItemGroup title="Default Session Type">
                <React.Fragment>
                    <View style={styles.selectorContainer}>
                        <SessionTypeSelector value={defaultSessionType} onChange={setDefaultSessionType} />
                    </View>
                </React.Fragment>
            </ItemGroup>

            <ItemGroup title="Default Permission Mode">
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

            <ItemGroup title="Tmux">
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

            <EnvironmentVariablesList
                environmentVariables={environmentVariables}
                machineId={machineId}
                profileDocs={profileDocs}
                onChange={setEnvironmentVariables}
            />

            <ItemGroup>
                <Item title={t('common.cancel')} onPress={onCancel} showChevron={false} />
                <Item
                    title={profile.isBuiltIn ? t('common.saveAs') : t('common.save')}
                    onPress={handleSave}
                    showChevron={false}
                />
            </ItemGroup>
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
    },
}));
