import type {
    PluginCatalogItem,
    PluginConnectionTestFailureCode,
    PluginConnectionTestResult,
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
import { installPlugin, testPluginConnection, uninstallPlugin } from '@/sync/plugins';
import { t } from '@/text';
import { resolvePluginText } from './pluginText';

type Props = {
    plugin: PluginCatalogItem;
    onInstalled?: () => void;
    onOpen?: () => void;
    onStatusChanged?: () => void | Promise<void>;
};

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

export const DynamicPluginConfiguration = React.memo(function DynamicPluginConfiguration({
    plugin,
    onInstalled,
    onOpen,
    onStatusChanged,
}: Props) {
    const { theme } = useUnistyles();
    const [values, setValues] = React.useState<Record<string, string>>({});
    const [connectionResult, setConnectionResult] = React.useState<PluginConnectionTestResult | null>(null);
    const connectionTestVersion = React.useRef(0);
    const { manifest, status } = plugin;
    const installed = status.installed;
    const currentVersionInstalled = status.installed && status.version === manifest.version;

    React.useEffect(() => {
        connectionTestVersion.current += 1;
        setValues(status.installed ? { ...status.configuration } : {});
        setConnectionResult(null);
        return () => {
            connectionTestVersion.current += 1;
        };
    }, [manifest.id, status]);

    const install = React.useCallback(async () => {
        await installPlugin(manifest.id, manifest.version, values);
        await onStatusChanged?.();
        onInstalled?.();
    }, [manifest.id, manifest.version, onInstalled, onStatusChanged, values]);
    const [installing, performInstall] = useHappyAction(install);

    const uninstall = React.useCallback(async () => {
        await uninstallPlugin(manifest.id);
        setValues({});
        await onStatusChanged?.();
    }, [manifest.id, onStatusChanged]);
    const [uninstalling, performUninstall] = useHappyAction(uninstall);

    const testConnection = React.useCallback(async () => {
        const requestVersion = connectionTestVersion.current + 1;
        connectionTestVersion.current = requestVersion;
        setConnectionResult(null);
        const result = await testPluginConnection(manifest.id, manifest.version, values);
        if (connectionTestVersion.current === requestVersion) setConnectionResult(result);
    }, [manifest.id, manifest.version, values]);
    const [testingConnection, performConnectionTest] = useHappyAction(testConnection);

    const updateValue = React.useCallback((key: string, value: string) => {
        connectionTestVersion.current += 1;
        setConnectionResult(null);
        setValues((current) => ({ ...current, [key]: value }));
    }, []);

    const canInstall = manifest.configuration.fields.every((field) => {
        if (!field.required) return true;
        if (values[field.key]?.trim()) return true;
        return field.type === 'secret' && status.installed && Boolean(status.secretHints[field.key]);
    }) && !installing && !testingConnection && !uninstalling;
    const canTestConnection = canInstall && manifest.permissions.includes('paws.ai.provider.invoke');

    return (
        <ItemList style={styles.list}>
            {manifest.configuration.fields.length > 0 ? (
                <ItemGroup
                    title={t('relationshipAdvisorPlugin.configuration')}
                    footer={manifest.configuration.notice
                        ? resolvePluginText(manifest.configuration.notice)
                        : undefined}
                >
                    {manifest.configuration.fields.map((field) => {
                        const label = resolvePluginText(field.label);
                        const secretHint = status.installed ? status.secretHints[field.key] : undefined;
                        const placeholder = secretHint
                            ? `•••• ${secretHint}`
                            : field.placeholder
                                ? resolvePluginText(field.placeholder)
                                : undefined;
                        return (
                            <View key={field.key} style={styles.fieldRow}>
                                <Text style={styles.fieldLabel}>{label}</Text>
                                {field.type === 'secret' ? (
                                    <SecureTextInput
                                        accessibilityLabel={label}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        emptyValueAccessibilityLabel={`${label} · ${t('relationshipAdvisorPlugin.encryptionNotice')}`}
                                        hideValueAccessibilityLabel={`${label} · ${t('settingsAccount.tapToHide')}`}
                                        onChangeText={(value) => updateValue(field.key, value)}
                                        placeholder={placeholder}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        showValueAccessibilityLabel={`${label} · ${t('settingsAccount.tapToReveal')}`}
                                        testID={fieldTestId(manifest.id, field.key)}
                                        textContentType="password"
                                        value={values[field.key] ?? ''}
                                        visibilityButtonTestID={`${fieldTestId(manifest.id, field.key)}-visibility-toggle`}
                                    />
                                ) : (
                                    <TextInput
                                        accessibilityLabel={label}
                                        autoCapitalize="none"
                                        autoCorrect={false}
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
                            </View>
                        );
                    })}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('relationshipAdvisorPlugin.status')}>
                <Item
                    icon={<Ionicons
                        color={theme.colors.accent}
                        name={installed ? 'checkmark-circle-outline' : 'download-outline'}
                        size={29}
                    />}
                    showChevron={false}
                    subtitle={installed
                        ? t('relationshipAdvisorPlugin.installedSubtitle')
                        : t('relationshipAdvisorPlugin.notInstalledSubtitle')}
                    title={installed
                        ? t('relationshipAdvisorPlugin.installed')
                        : t('relationshipAdvisorPlugin.notInstalled')}
                />
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
                {currentVersionInstalled && manifest.installedAction === 'open' ? (
                    <Item
                        disabled={installing || testingConnection || uninstalling || !onOpen}
                        icon={<Ionicons color={theme.colors.accent} name="open-outline" size={29} />}
                        onPress={onOpen}
                        showChevron={false}
                        testID={`${manifest.id}-plugin-open`}
                        title={t('relationshipAdvisorPlugin.openPlugin')}
                    />
                ) : (
                    <Item
                        disabled={!canInstall}
                        icon={<Ionicons color={theme.colors.accent} name="cloud-download-outline" size={29} />}
                        loading={installing}
                        onPress={performInstall}
                        showChevron={false}
                        testID={`${manifest.id}-plugin-install`}
                        title={installed
                            ? t('relationshipAdvisorPlugin.update')
                            : t('relationshipAdvisorPlugin.install')}
                    />
                )}
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
