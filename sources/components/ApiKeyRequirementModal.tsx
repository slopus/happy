import React from 'react';
import { View, Text, Pressable, TextInput, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AIBackendProfile, SavedApiKey } from '@/sync/settings';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { getRequiredSecretEnvVarName } from '@/sync/profileSecrets';
import { useProfileEnvRequirements } from '@/hooks/useProfileEnvRequirements';
import { ApiKeysList } from '@/components/apiKeys/ApiKeysList';
import { ItemListStatic } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { OptionTiles } from '@/components/OptionTiles';

const apiKeyRequirementSelectionMemory = new Map<string, 'machine' | 'saved' | 'once'>();

export type ApiKeyRequirementModalResult =
    | { action: 'cancel' }
    | { action: 'useMachine' }
    | { action: 'selectSaved'; apiKeyId: string; setDefault: boolean }
    | { action: 'enterOnce'; value: string };

export interface ApiKeyRequirementModalProps {
    profile: AIBackendProfile;
    machineId: string | null;
    apiKeys: SavedApiKey[];
    defaultApiKeyId: string | null;
    onChangeApiKeys?: (next: SavedApiKey[]) => void;
    onResolve: (result: ApiKeyRequirementModalResult) => void;
    onClose: () => void;
    /**
     * Optional hook invoked when the modal is dismissed (e.g. backdrop tap).
     * Used by the modal host to route dismiss -> cancel.
     */
    onRequestClose?: () => void;
    allowSessionOnly?: boolean;
}

export function ApiKeyRequirementModal(props: ApiKeyRequirementModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const requiredSecretName = React.useMemo(() => getRequiredSecretEnvVarName(props.profile), [props.profile]);
    const requirements = useProfileEnvRequirements(props.machineId, props.machineId ? props.profile : null);
    const machine = useMachine(props.machineId ?? '');

    const [sessionOnlyValue, setSessionOnlyValue] = React.useState('');
    const selectionKey = `${props.profile.id}:${props.machineId ?? 'no-machine'}`;
    const [selectedSource, setSelectedSource] = React.useState<'machine' | 'saved' | 'once' | null>(() => {
        return apiKeyRequirementSelectionMemory.get(selectionKey) ?? null;
    });

    const machineIsConfigured = requirements.isLoading ? null : requirements.isReady;

    const machineName = React.useMemo(() => {
        if (!props.machineId) return null;
        if (!machine) return props.machineId;
        return machine.metadata?.displayName || machine.metadata?.host || machine.id;
    }, [machine, props.machineId]);

    const machineNameColor = React.useMemo(() => {
        if (!props.machineId) return theme.colors.textSecondary;
        if (!machine) return theme.colors.textSecondary;
        return isMachineOnline(machine) ? theme.colors.status.connected : theme.colors.status.disconnected;
    }, [machine, props.machineId, theme.colors.status.connected, theme.colors.status.disconnected, theme.colors.textSecondary]);

    const allowedSources = React.useMemo(() => {
        const sources: Array<'machine' | 'saved' | 'once'> = [];
        if (props.machineId) sources.push('machine');
        sources.push('saved');
        if (props.allowSessionOnly !== false) sources.push('once');
        return sources;
    }, [props.allowSessionOnly, props.machineId]);

    React.useEffect(() => {
        if (selectedSource && allowedSources.includes(selectedSource)) return;
        // Default selection:
        // - If we have a machine, recommend machine env first.
        // - Otherwise, default to saved keys.
        setSelectedSource(props.machineId ? 'machine' : 'saved');
    }, [allowedSources, props.machineId, selectedSource]);

    React.useEffect(() => {
        if (!selectedSource) return;
        apiKeyRequirementSelectionMemory.set(selectionKey, selectedSource);
    }, [selectionKey, selectedSource]);

    const machineEnvTitle = React.useMemo(() => {
        const envName = requiredSecretName ?? t('profiles.requirements.apiKeyRequired');
        if (!props.machineId) return t('profiles.requirements.machineEnvStatus.checkFor', { env: envName });
        const target = machineName ?? t('profiles.requirements.machineEnvStatus.theMachine');
        if (requirements.isLoading) return t('profiles.requirements.machineEnvStatus.checking', { env: envName });
        if (machineIsConfigured) return t('profiles.requirements.machineEnvStatus.found', { env: envName, machine: target });
        return t('profiles.requirements.machineEnvStatus.notFound', { env: envName, machine: target });
    }, [machineIsConfigured, machineName, props.machineId, requirements.isLoading, requiredSecretName]);

    const machineEnvSubtitle = React.useMemo(() => {
        if (!props.machineId) return undefined;
        if (requirements.isLoading) return t('profiles.requirements.machineEnvSubtitle.checking');
        if (machineIsConfigured) return t('profiles.requirements.machineEnvSubtitle.found');
        return t('profiles.requirements.machineEnvSubtitle.notFound');
    }, [machineIsConfigured, props.machineId, requirements.isLoading]);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.headerTitle}>
                        {t('profiles.requirements.modalTitle')}
                    </Text>
                    <Text style={styles.headerSubtitle} numberOfLines={1}>
                        {props.profile.name}
                    </Text>
                </View>
                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={styles.body}>
                <View style={styles.helpContainer}>
                    <Text style={styles.helpText}>
                        {requiredSecretName
                            ? t('profiles.requirements.modalHelpWithEnv', { env: requiredSecretName })
                            : t('profiles.requirements.modalHelpGeneric')}
                    </Text>
                    <Text style={[styles.helpText, { marginTop: 8 }]}>
                        {t('profiles.requirements.modalRecommendation')}
                    </Text>
                </View>

                <ItemListStatic style={{ backgroundColor: 'transparent' }} containerStyle={{ paddingTop: 0 }}>
                    <ItemGroup title={t('profiles.requirements.chooseOptionTitle')} containerStyle={{ backgroundColor: 'transparent' }}>
                        <OptionTiles
                            options={[
                                ...(props.machineId
                                    ? [{
                                        id: 'machine' as const,
                                        title: t('profiles.requirements.options.useMachineEnvironment.title'),
                                        subtitle: requiredSecretName
                                            ? t('profiles.requirements.options.useMachineEnvironment.subtitleWithEnv', { env: requiredSecretName })
                                            : t('profiles.requirements.options.useMachineEnvironment.subtitleGeneric'),
                                        icon: 'desktop-outline' as const,
                                    }]
                                    : []),
                                {
                                    id: 'saved' as const,
                                    title: t('profiles.requirements.options.useSavedApiKey.title'),
                                    subtitle: t('profiles.requirements.options.useSavedApiKey.subtitle'),
                                    icon: 'key-outline' as const,
                                },
                                ...(props.allowSessionOnly !== false
                                    ? [{
                                        id: 'once' as const,
                                        title: t('profiles.requirements.options.enterOnce.title'),
                                        subtitle: t('profiles.requirements.options.enterOnce.subtitle'),
                                        icon: 'flash-outline' as const,
                                    }]
                                    : []),
                            ]}
                            value={selectedSource}
                            onChange={(next) => setSelectedSource(next)}
                        />
                    </ItemGroup>

                    {selectedSource === 'machine' && props.machineId && (
                        <ItemGroup title={t('profiles.requirements.sections.machineEnvironment')}>
                            <Item
                                title={machineEnvTitle}
                                subtitle={machineEnvSubtitle}
                                icon={
                                    <Ionicons
                                        name={requirements.isLoading ? 'time-outline' : (machineIsConfigured ? 'checkmark-circle-outline' : 'close-circle-outline')}
                                        size={29}
                                        color={requirements.isLoading ? theme.colors.textSecondary : (machineIsConfigured ? theme.colors.status.connected : theme.colors.status.disconnected)}
                                    />
                                }
                                showChevron={false}
                                showDivider={machineIsConfigured === true}
                            />
                            {machineIsConfigured === true && (
                                <Item
                                    title={t('profiles.requirements.options.useMachineEnvironment.title')}
                                    subtitle={t('profiles.requirements.actions.useMachineEnvironment.subtitle')}
                                    icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.button.secondary.tint} />}
                                    onPress={() => {
                                        props.onResolve({ action: 'useMachine' });
                                        props.onClose();
                                    }}
                                    showChevron={false}
                                    showDivider={false}
                                />
                            )}
                        </ItemGroup>
                    )}

                    {selectedSource === 'saved' && (
                        <ApiKeysList
                            wrapInItemList={false}
                            apiKeys={props.apiKeys}
                            onChangeApiKeys={(next) => props.onChangeApiKeys?.(next)}
                            allowAdd={Boolean(props.onChangeApiKeys)}
                            allowEdit
                            title={t('apiKeys.savedTitle')}
                            footer={null}
                            defaultId={props.defaultApiKeyId}
                            onSetDefaultId={(id) => {
                                if (!id) return;
                                props.onResolve({ action: 'selectSaved', apiKeyId: id, setDefault: true });
                                props.onClose();
                            }}
                            selectedId={''}
                            onSelectId={(id) => {
                                if (!id) return;
                                props.onResolve({ action: 'selectSaved', apiKeyId: id, setDefault: false });
                                props.onClose();
                            }}
                            onAfterAddSelectId={(id) => {
                                props.onResolve({ action: 'selectSaved', apiKeyId: id, setDefault: false });
                                props.onClose();
                            }}
                        />
                    )}

                    {selectedSource === 'once' && props.allowSessionOnly !== false && (
                        <ItemGroup title={t('profiles.requirements.sections.useOnceTitle')} footer={t('profiles.requirements.sections.useOnceFooter')}>
                            <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 }}>
                                <TextInput
                                    style={styles.textInput}
                                    placeholder="sk-..."
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    value={sessionOnlyValue}
                                    onChangeText={setSessionOnlyValue}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    secureTextEntry
                                    textContentType={Platform.OS === 'ios' ? 'password' : undefined}
                                />
                                <View style={{ height: 10 }} />
                                <Pressable
                                    disabled={!sessionOnlyValue.trim()}
                                    onPress={() => {
                                        const v = sessionOnlyValue.trim();
                                        if (!v) return;
                                        props.onResolve({ action: 'enterOnce', value: v });
                                        props.onClose();
                                    }}
                                    style={({ pressed }) => [
                                        styles.primaryButton,
                                        {
                                            opacity: !sessionOnlyValue.trim() ? 0.5 : (pressed ? 0.85 : 1),
                                            backgroundColor: theme.colors.button.primary.background,
                                        },
                                    ]}
                                >
                                    <Text style={[styles.primaryButtonText, { color: theme.colors.button.primary.tint }]}>
                                        {t('profiles.requirements.actions.useOnceButton')}
                                    </Text>
                                </Pressable>
                            </View>
                        </ItemGroup>
                    )}
                </ItemListStatic>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
        paddingBottom: 18,
    },
    header: {
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 14,
        paddingBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    headerSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    body: {
        // Don't use flex here: in portal-mode the modal should size to content.
    },
    helpContainer: {
        width: '100%',
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 14,
        paddingBottom: 8,
        alignSelf: 'center',
    },
    helpText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        lineHeight: 18,
        ...Typography.default(),
    },
    primaryButton: {
        borderRadius: 10,
        paddingVertical: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    primaryButtonText: {
        fontSize: 13,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: theme.colors.text,
        ...Typography.default(),
    },
}));
