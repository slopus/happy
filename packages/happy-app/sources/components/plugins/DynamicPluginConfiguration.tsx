import type {
    PluginCatalogItem,
    PluginConnectionTestFailureCode,
    PluginConnectionTestResult,
    PluginInstallationStatus,
    PluginPermission,
} from '@slopus/happy-wire';
import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { SecureTextInput } from '@/components/SecureTextInput';
import { Typography } from '@/constants/Typography';
import { useHappyAction } from '@/hooks/useHappyAction';
import { installPlugin, revealPluginSecret, testPluginConnection, uninstallPlugin } from '@/sync/plugins';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { resolvePluginText } from './pluginText';
import { isCurrentPluginInstallation } from './pluginInstallation';

type Props = {
    plugin: PluginCatalogItem;
    onInstalled?: (status: PluginInstallationStatus) => void | Promise<void>;
    onOpen?: () => void;
    onStatusChanged?: () => void | Promise<void>;
};

type ConnectionFeedback = {
    installationFingerprint: string | null;
    result: PluginConnectionTestResult;
};

function storedConfiguration(status: PluginInstallationStatus): Record<string, string> {
    return status.installed ? { ...status.configuration } : {};
}

function configurationValues(plugin: PluginCatalogItem, draftScope: number): Record<string, string> {
    return {
        ...storedConfiguration(plugin.status),
        ...sync.getPluginConfigurationDraft(plugin.manifest.id, plugin.manifest.version, draftScope),
    };
}

function nonSecretDraft(
    plugin: PluginCatalogItem,
    savedConfiguration: Record<string, string>,
    values: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(plugin.manifest.configuration.fields
        .filter((field) => field.type !== 'secret')
        .map((field) => [field.key, values[field.key] ?? ''] as const)
        .filter(([key, value]) => value !== (savedConfiguration[key] ?? '')));
}

function updateTransientDraft(
    plugin: PluginCatalogItem,
    savedConfiguration: Record<string, string>,
    values: Record<string, string>,
    draftScope: number,
): void {
    sync.setPluginConfigurationDraft(
        plugin.manifest.id,
        plugin.manifest.version,
        nonSecretDraft(plugin, savedConfiguration, values),
        draftScope,
    );
}

function installationFingerprint(plugin: PluginCatalogItem, status: PluginInstallationStatus): string {
    if (!status.installed) return JSON.stringify({ installed: false });
    return JSON.stringify({
        configuration: plugin.manifest.configuration.fields
            .filter((field) => field.type !== 'secret')
            .map((field) => [field.key, status.configuration[field.key] ?? '']),
        grantedPermissions: [...status.grantedPermissions].sort(),
        installed: true,
        secretHints: plugin.manifest.configuration.fields
            .filter((field) => field.type === 'secret')
            .map((field) => [field.key, status.secretHints[field.key] ?? '']),
        version: status.version,
    });
}

function fieldTestId(pluginId: string, key: string): string {
    return `${pluginId}-plugin-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function connectionFailureTitle(code: PluginConnectionTestFailureCode): string {
    const keys = {
        invalid_configuration: 'relationshipAdvisorPlugin.connectionUnreachable',
        authentication_failed: 'relationshipAdvisorPlugin.connectionAuthenticationFailed',
        model_not_found: 'relationshipAdvisorPlugin.connectionModelNotFound',
        rate_limited: 'relationshipAdvisorPlugin.connectionRateLimited',
        timed_out: 'relationshipAdvisorPlugin.connectionTimedOut',
        provider_unreachable: 'relationshipAdvisorPlugin.connectionUnreachable',
        provider_error: 'relationshipAdvisorPlugin.connectionProviderError',
    } as const;
    return t(keys[code]);
}

const permissionPresentation = {
    'paws.ai.provider.invoke': {
        icon: 'sparkles-outline',
        title: 'relationshipAdvisorPlugin.permissionAiProviderInvoke',
        subtitle: 'relationshipAdvisorPlugin.permissionAiProviderInvokeDescription',
    },
    'paws.secrets.use': {
        icon: 'key-outline',
        title: 'relationshipAdvisorPlugin.permissionSecretsUse',
        subtitle: 'relationshipAdvisorPlugin.permissionSecretsUseDescription',
    },
    'paws.conversations.images.read': {
        icon: 'images-outline',
        title: 'relationshipAdvisorPlugin.permissionConversationImagesRead',
        subtitle: 'relationshipAdvisorPlugin.permissionConversationImagesReadDescription',
    },
    'paws.storage.images.write': {
        icon: 'cloud-upload-outline',
        title: 'relationshipAdvisorPlugin.permissionStorageImagesWrite',
        subtitle: 'relationshipAdvisorPlugin.permissionStorageImagesWriteDescription',
    },
} as const satisfies Record<PluginPermission, {
    icon: string;
    title: Parameters<typeof t>[0];
    subtitle: Parameters<typeof t>[0];
}>;

export const DynamicPluginConfiguration = React.memo(function DynamicPluginConfiguration({
    plugin,
    onInstalled,
    onOpen,
    onStatusChanged,
}: Props) {
    const { theme } = useUnistyles();
    const { manifest, status } = plugin;
    const draftScope = sync.getPluginConfigurationDraftScope();
    const [values, setValues] = React.useState<Record<string, string>>(() => configurationValues(plugin, draftScope));
    const [savedConfiguration, setSavedConfiguration] = React.useState<Record<string, string>>(
        () => storedConfiguration(status),
    );
    const [connectionFeedback, setConnectionFeedback] = React.useState<ConnectionFeedback | null>(null);
    const [revealedSecretKeys, setRevealedSecretKeys] = React.useState<Record<string, true>>({});
    const [revealingSecretKey, setRevealingSecretKey] = React.useState<string | null>(null);
    const connectionTestVersion = React.useRef(0);
    const secretRevealVersion = React.useRef(0);
    const configurationEditVersion = React.useRef(0);
    const activePluginKey = React.useRef(`${manifest.id}@${manifest.version}`);
    const installed = status.installed;
    const currentInstallation = isCurrentPluginInstallation(plugin);
    const reviewRequired = installed && !currentInstallation;
    const statusRevision = JSON.stringify(status);
    const latestStatusRef = React.useRef(status);
    const statusRevisionRef = React.useRef(statusRevision);
    latestStatusRef.current = status;
    statusRevisionRef.current = statusRevision;

    React.useEffect(() => {
        connectionTestVersion.current += 1;
        secretRevealVersion.current += 1;
        const pluginKey = `${manifest.id}@${manifest.version}`;
        const pluginChanged = activePluginKey.current !== pluginKey;
        activePluginKey.current = pluginKey;
        const nextSavedConfiguration = storedConfiguration(status);
        const nextValues = configurationValues(plugin, draftScope);
        updateTransientDraft(plugin, nextSavedConfiguration, nextValues, draftScope);
        setSavedConfiguration(nextSavedConfiguration);
        setValues(nextValues);
        setRevealedSecretKeys({});
        setRevealingSecretKey(null);
        setConnectionFeedback((current) => {
            if (pluginChanged || !current?.result.success || !status.installed) return null;
            if (status.version !== manifest.version) return null;
            return installationFingerprint(plugin, status) === current.installationFingerprint
                ? current
                : null;
        });
        return () => {
            connectionTestVersion.current += 1;
            secretRevealVersion.current += 1;
        };
        // statusRevision prevents equivalent catalog snapshots from erasing an active draft.
    }, [draftScope, manifest.id, manifest.version, statusRevision]);

    React.useEffect(() => {
        connectionTestVersion.current += 1;
        secretRevealVersion.current += 1;
        setRevealedSecretKeys({});
        setRevealingSecretKey(null);
        setValues((current) => Object.fromEntries(manifest.configuration.fields.map((field) => [
            field.key,
            field.type === 'secret' ? '' : current[field.key] ?? '',
        ])));
    }, [manifest.configuration.fields, status]);

    const saveConfiguration = React.useCallback(async (
        configuration: Record<string, string>,
        expectedVersion: number,
        notifyInstalled: boolean,
    ) => {
        const submittedDraft = nonSecretDraft(plugin, savedConfiguration, configuration);
        const installedStatus = await installPlugin(
            manifest.id,
            manifest.version,
            configuration,
            [...manifest.permissions],
        );
        if (!sync.isPluginConfigurationDraftScopeCurrent(draftScope)) return installedStatus;
        sync.setPluginInstallationStatus(manifest.id, installedStatus, draftScope);
        sync.clearPluginConfigurationDraft(manifest.id, manifest.version, submittedDraft, draftScope);
        if (connectionTestVersion.current === expectedVersion) {
            const saved = storedConfiguration(installedStatus);
            setSavedConfiguration(saved);
            setValues(saved);
            setRevealedSecretKeys({});
        }
        await onStatusChanged?.();
        if (notifyInstalled && sync.isPluginConfigurationDraftScopeCurrent(draftScope)) {
            await onInstalled?.(installedStatus);
        }
        return installedStatus;
    }, [draftScope, manifest.id, manifest.permissions, manifest.version, onInstalled, onStatusChanged, plugin, savedConfiguration]);

    const install = React.useCallback(async () => {
        await saveConfiguration(values, connectionTestVersion.current, true);
    }, [saveConfiguration, values]);
    const [installing, performInstall] = useHappyAction(install);

    const uninstall = React.useCallback(async () => {
        const uninstalledStatus = await uninstallPlugin(manifest.id);
        if (!sync.isPluginConfigurationDraftScopeCurrent(draftScope)) return;
        sync.setPluginInstallationStatus(manifest.id, uninstalledStatus, draftScope);
        sync.clearPluginConfigurationDraft(manifest.id, manifest.version, undefined, draftScope);
        setSavedConfiguration({});
        setValues({});
        setRevealedSecretKeys({});
        setConnectionFeedback(null);
        await onStatusChanged?.();
    }, [draftScope, manifest.id, manifest.version, onStatusChanged]);
    const [uninstalling, performUninstall] = useHappyAction(uninstall);

    const testConnection = React.useCallback(async () => {
        const requestVersion = connectionTestVersion.current + 1;
        const editVersion = configurationEditVersion.current;
        const catalogRevisionAtStart = statusRevisionRef.current;
        connectionTestVersion.current = requestVersion;
        setConnectionFeedback(null);
        const result = await testPluginConnection(
            manifest.id,
            manifest.version,
            values,
            [...manifest.permissions],
        );
        if (connectionTestVersion.current !== requestVersion) return;
        if (!result.success) {
            setConnectionFeedback({ installationFingerprint: null, result });
            return;
        }
        const installedStatus = await saveConfiguration(values, requestVersion, false);
        if (!sync.isPluginConfigurationDraftScopeCurrent(draftScope)) return;
        const savedFingerprint = installationFingerprint(plugin, installedStatus);
        const catalogChangedDuringSave = statusRevisionRef.current !== catalogRevisionAtStart;
        const latestCatalogMatchesSave = installationFingerprint(plugin, latestStatusRef.current) === savedFingerprint;
        if (configurationEditVersion.current === editVersion
            && (!catalogChangedDuringSave || latestCatalogMatchesSave)) {
            setConnectionFeedback({ installationFingerprint: savedFingerprint, result });
        }
    }, [draftScope, manifest.id, manifest.permissions, manifest.version, plugin, saveConfiguration, values]);
    const [testingConnection, performConnectionTest] = useHappyAction(testConnection);

    const revealStoredSecret = React.useCallback(async (fieldKey: string) => {
        const requestVersion = secretRevealVersion.current + 1;
        secretRevealVersion.current = requestVersion;
        try {
            const value = await revealPluginSecret(manifest.id, fieldKey);
            if (secretRevealVersion.current !== requestVersion) return;
            if (!sync.isPluginConfigurationDraftScopeCurrent(draftScope)) return;
            setRevealedSecretKeys((current) => ({ ...current, [fieldKey]: true }));
            setValues((current) => ({ ...current, [fieldKey]: value }));
        } catch {
            if (secretRevealVersion.current === requestVersion
                && sync.isPluginConfigurationDraftScopeCurrent(draftScope)) {
                throw new HappyError(t('relationshipAdvisorPlugin.secretRevealFailed'), true);
            }
        } finally {
            if (secretRevealVersion.current === requestVersion) {
                setRevealingSecretKey((current) => current === fieldKey ? null : current);
            }
        }
    }, [draftScope, manifest.id]);
    const [revealingSecret, performRevealStoredSecret] = useHappyAction(revealStoredSecret);

    const requestStoredSecretReveal = React.useCallback((fieldKey: string) => {
        if (revealingSecret) return;
        setRevealingSecretKey(fieldKey);
        performRevealStoredSecret(fieldKey);
    }, [performRevealStoredSecret, revealingSecret]);

    const hideStoredSecret = React.useCallback((fieldKey: string) => {
        if (revealedSecretKeys[fieldKey]) {
            setValues((current) => ({ ...current, [fieldKey]: '' }));
        }
        setRevealedSecretKeys((current) => {
            const next = { ...current };
            delete next[fieldKey];
            return next;
        });
    }, [revealedSecretKeys]);

    const updateValue = React.useCallback((key: string, value: string) => {
        connectionTestVersion.current += 1;
        configurationEditVersion.current += 1;
        setConnectionFeedback(null);
        setRevealedSecretKeys((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
        });
        setValues((current) => {
            const next = { ...current, [key]: value };
            updateTransientDraft(plugin, savedConfiguration, next, draftScope);
            return next;
        });
    }, [draftScope, plugin, savedConfiguration]);

    const hasUnsavedChanges = manifest.configuration.fields.some((field) => {
        const value = values[field.key] ?? '';
        if (field.type === 'secret') {
            if (revealedSecretKeys[field.key]) return false;
            return value.length > 0;
        }
        return value !== (savedConfiguration[field.key] ?? '');
    });

    const canInstall = manifest.configuration.fields.every((field) => {
        if (!field.required) return true;
        if (values[field.key]?.trim()) return true;
        return field.type === 'secret' && status.installed && Boolean(status.secretHints[field.key]);
    }) && !installing && !testingConnection && !uninstalling && !revealingSecret;
    const canTestConnection = canInstall && manifest.permissions.includes('paws.ai.provider.invoke');
    const configurationFieldsEditable = !installing && !testingConnection && !uninstalling && !revealingSecret;
    const connectionResult = connectionFeedback?.result ?? null;

    return (
        <ItemList style={styles.list}>
            {manifest.configuration.fields.length > 0 ? (
                <ItemGroup
                    title={t('relationshipAdvisorPlugin.configuration')}
                    footer={manifest.id === 'relationship-advisor'
                        ? t('relationshipAdvisorPlugin.encryptionNotice')
                        : manifest.configuration.notice
                            ? resolvePluginText(manifest.configuration.notice)
                            : undefined}
                >
                    {manifest.configuration.fields.map((field) => {
                        const label = resolvePluginText(field.label);
                        const secretHint = status.installed ? status.secretHints[field.key] : undefined;
                        const manifestPlaceholder = field.placeholder
                            ? resolvePluginText(field.placeholder)
                            : undefined;
                        const relationshipAdvisorPlaceholder = manifest.id === 'relationship-advisor'
                            ? field.key === 'apiKey'
                                ? t('relationshipAdvisorPlugin.apiKeyPlaceholder')
                                : field.key === 'baseUrl'
                                    ? t('relationshipAdvisorPlugin.baseUrlPlaceholder')
                                    : field.key === 'model'
                                        ? t('relationshipAdvisorPlugin.modelPlaceholder')
                                        : undefined
                            : undefined;
                        const placeholder = secretHint
                            ? `•••• ${secretHint}`
                            : relationshipAdvisorPlaceholder ?? manifestPlaceholder;
                        return (
                            <View key={field.key} style={styles.fieldRow}>
                                <Text style={styles.fieldLabel}>{label}</Text>
                                {field.type === 'secret' ? (
                                    <SecureTextInput
                                        accessibilityLabel={label}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        emptyValueAccessibilityLabel={`${label} · ${t('relationshipAdvisorPlugin.encryptionNotice')}`}
                                        editable={configurationFieldsEditable}
                                        hideValueAccessibilityLabel={`${label} · ${t('settingsAccount.tapToHide')}`}
                                        onHideStoredValue={() => hideStoredSecret(field.key)}
                                        onChangeText={(value) => updateValue(field.key, value)}
                                        onRevealStoredValue={() => requestStoredSecretReveal(field.key)}
                                        placeholder={placeholder}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        showValueAccessibilityLabel={`${label} · ${t('settingsAccount.tapToReveal')}`}
                                        storedValueAvailable={Boolean(secretHint)}
                                        storedValueRevealed={Boolean(revealedSecretKeys[field.key])}
                                        testID={fieldTestId(manifest.id, field.key)}
                                        textContentType="password"
                                        value={values[field.key] ?? ''}
                                        visibilityButtonLoading={revealingSecret && revealingSecretKey === field.key}
                                        visibilityButtonTestID={`${fieldTestId(manifest.id, field.key)}-visibility-toggle`}
                                    />
                                ) : (
                                    <TextInput
                                        accessibilityLabel={label}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        editable={configurationFieldsEditable}
                                        keyboardType={field.type === 'url' ? 'url' : 'default'}
                                        onChangeText={(value) => updateValue(field.key, value)}
                                        placeholder={placeholder}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        style={styles.textInput}
                                        testID={fieldTestId(manifest.id, field.key)}
                                        textContentType={field.type === 'url' ? 'URL' : 'none'}
                                        value={values[field.key] ?? ''}
                                    />
                                )}
                                {manifest.id === 'relationship-advisor' && field.key === 'model' ? (
                                    <Text
                                        style={styles.fieldHint}
                                        testID={`${manifest.id}-plugin-model-recommendation`}
                                    >
                                        {t('relationshipAdvisorPlugin.modelRecommendation')}
                                    </Text>
                                ) : null}
                            </View>
                        );
                    })}
                </ItemGroup>
            ) : null}

            <View testID={`${manifest.id}-plugin-actions`}>
                <ItemGroup>
                    {hasUnsavedChanges ? (
                        <Item
                            icon={<Ionicons color={theme.colors.accent} name="alert-circle-outline" size={29} />}
                            showChevron={false}
                            subtitle={t('relationshipAdvisorPlugin.unsavedChangesSubtitle')}
                            testID={`${manifest.id}-plugin-unsaved-changes`}
                            title={t('relationshipAdvisorPlugin.unsavedChangesTitle')}
                        />
                    ) : null}
                    {manifest.permissions.includes('paws.ai.provider.invoke') ? (
                        <Item
                            disabled={!canTestConnection}
                            icon={<Ionicons color={theme.colors.accent} name="pulse-outline" size={29} />}
                            loading={testingConnection}
                            onPress={performConnectionTest}
                            showChevron={false}
                            subtitle={t('relationshipAdvisorPlugin.testConnectionSubtitle')}
                            testID={`${manifest.id}-plugin-test-connection`}
                            title={t('relationshipAdvisorPlugin.testConnection')}
                        />
                    ) : null}
                    {currentInstallation && manifest.installedAction === 'open' ? null : (
                        <Item
                            disabled={!canInstall}
                            icon={<Ionicons color={theme.colors.accent} name="cloud-download-outline" size={29} />}
                            loading={installing}
                            onPress={performInstall}
                            showChevron={false}
                            testID={`${manifest.id}-plugin-install`}
                            title={reviewRequired
                                ? t('relationshipAdvisorPlugin.reviewAndUpdate')
                                : installed
                                    ? t('relationshipAdvisorPlugin.update')
                                : t('relationshipAdvisorPlugin.install')}
                        />
                    )}
                    {connectionResult ? (
                        <Item
                            icon={<Ionicons
                                color={connectionResult.success ? theme.colors.accent : theme.colors.textDestructive}
                                name={connectionResult.success ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                                size={29}
                            />}
                            showChevron={false}
                            subtitle={connectionResult.success
                                ? t('relationshipAdvisorPlugin.connectionSuccessSubtitle')
                                : undefined}
                            testID={`${manifest.id}-plugin-test-connection-result`}
                            title={connectionResult.success
                                ? t('relationshipAdvisorPlugin.connectionSuccess')
                                : connectionFailureTitle(connectionResult.code)}
                        />
                    ) : null}
                </ItemGroup>
            </View>

            <View testID={`${manifest.id}-plugin-permissions`}>
                <ItemGroup
                    footer={t('relationshipAdvisorPlugin.permissionGrantNotice')}
                    title={t('relationshipAdvisorPlugin.permissions')}
                >
                    <Item
                        icon={<Ionicons color={theme.colors.accent} name="cube-outline" size={29} />}
                        showChevron={false}
                        subtitle={t('relationshipAdvisorPlugin.builtInCodeNotice')}
                        testID={`${manifest.id}-built-in-code`}
                        title={t('relationshipAdvisorPlugin.builtInCode')}
                    />
                    {manifest.permissions.map((permission) => {
                        const presentation = permissionPresentation[permission];
                        return (
                            <Item
                                icon={<Ionicons
                                    color={theme.colors.accent}
                                    name={presentation.icon as any}
                                    size={29}
                                />}
                                key={permission}
                                showChevron={false}
                                subtitle={t(presentation.subtitle)}
                                testID={`${manifest.id}-permission-${permission}`}
                                title={t(presentation.title)}
                            />
                        );
                    })}
                </ItemGroup>
            </View>

            <View testID={`${manifest.id}-plugin-status-section`}>
                <ItemGroup title={t('relationshipAdvisorPlugin.status')}>
                    <Item
                        icon={<Ionicons
                            color={theme.colors.accent}
                            name={currentInstallation
                                ? 'checkmark-circle-outline'
                                : reviewRequired
                                    ? 'alert-circle-outline'
                                    : 'download-outline'}
                            size={29}
                        />}
                        showChevron={false}
                        subtitle={currentInstallation
                            ? t('relationshipAdvisorPlugin.installedSubtitle')
                            : reviewRequired
                                ? t('relationshipAdvisorPlugin.reviewRequiredSubtitle')
                                : t('relationshipAdvisorPlugin.notInstalledSubtitle')}
                        testID={`${manifest.id}-plugin-status`}
                        title={currentInstallation
                            ? t('relationshipAdvisorPlugin.installed')
                            : reviewRequired
                                ? t('relationshipAdvisorPlugin.reviewRequired')
                                : t('relationshipAdvisorPlugin.notInstalled')}
                    />
                    {currentInstallation && manifest.installedAction === 'open' ? (
                        <Item
                            disabled={installing || testingConnection || uninstalling || !onOpen}
                            icon={<Ionicons color={theme.colors.accent} name="open-outline" size={29} />}
                            onPress={onOpen}
                            showChevron={false}
                            testID={`${manifest.id}-plugin-open`}
                            title={t('relationshipAdvisorPlugin.openPlugin')}
                        />
                    ) : null}
                    {installed ? (
                        <Item
                            destructive
                            disabled={installing || testingConnection || uninstalling}
                            icon={<Ionicons color={theme.colors.textDestructive} name="trash-outline" size={29} />}
                            loading={uninstalling}
                            onPress={performUninstall}
                            showChevron={false}
                            testID={`${manifest.id}-plugin-uninstall`}
                            title={t('relationshipAdvisorPlugin.uninstall')}
                        />
                    ) : null}
                </ItemGroup>
            </View>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    list: { paddingTop: 0 },
    fieldRow: { gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
    fieldLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 15,
    },
    fieldHint: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    textInput: {
        ...Typography.default(),
        backgroundColor: theme.colors.input.background,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        color: theme.colors.text,
        fontSize: 15,
        minHeight: 44,
        paddingHorizontal: 12,
    },
}));
