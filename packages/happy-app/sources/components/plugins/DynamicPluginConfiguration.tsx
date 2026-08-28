import type { PluginCatalogItem } from '@slopus/happy-wire';
import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useHappyAction } from '@/hooks/useHappyAction';
import { installPlugin, uninstallPlugin } from '@/sync/plugins';
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

export const DynamicPluginConfiguration = React.memo(function DynamicPluginConfiguration({
    plugin,
    onInstalled,
    onOpen,
    onStatusChanged,
}: Props) {
    const { theme } = useUnistyles();
    const [values, setValues] = React.useState<Record<string, string>>({});
    const { manifest, status } = plugin;
    const installed = status.installed;
    const currentVersionInstalled = status.installed && status.version === manifest.version;

    React.useEffect(() => {
        setValues(status.installed ? { ...status.configuration } : {});
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

    const canInstall = manifest.configuration.fields.every((field) => {
        if (!field.required) return true;
        if (values[field.key]?.trim()) return true;
        return field.type === 'secret' && status.installed && Boolean(status.secretHints[field.key]);
    }) && !installing && !uninstalling;

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
                        const secretHint = status.installed ? status.secretHints[field.key] : undefined;
                        const placeholder = secretHint
                            ? `•••• ${secretHint}`
                            : field.placeholder
                                ? resolvePluginText(field.placeholder)
                                : undefined;
                        return (
                            <View key={field.key} style={styles.fieldRow}>
                                <Text style={styles.fieldLabel}>{resolvePluginText(field.label)}</Text>
                                <TextInput
                                    accessibilityLabel={resolvePluginText(field.label)}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType={field.type === 'url' ? 'url' : 'default'}
                                    onChangeText={(value) => setValues((current) => ({
                                        ...current,
                                        [field.key]: value,
                                    }))}
                                    placeholder={placeholder}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    secureTextEntry={field.type === 'secret'}
                                    style={styles.textInput}
                                    testID={fieldTestId(manifest.id, field.key)}
                                    textContentType={field.type === 'secret'
                                        ? 'password'
                                        : field.type === 'url'
                                            ? 'URL'
                                            : 'none'}
                                    value={values[field.key] ?? ''}
                                />
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
                {currentVersionInstalled && manifest.installedAction === 'open' ? (
                    <Item
                        disabled={installing || uninstalling || !onOpen}
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
                        disabled={installing || uninstalling}
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
