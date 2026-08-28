import * as React from 'react';
import type { PluginCatalogItem } from '@slopus/happy-wire';
import {
    Modal,
    Platform,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    View,
    useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { usePlugins } from '@/hooks/usePlugins';
import { t } from '@/text';
import { DynamicPluginConfiguration } from './DynamicPluginConfiguration';
import { PluginModalSlot } from './PluginModalSlot';
import { resolveInstalledPluginEntrypoint, resolveInstalledPluginView } from './pluginClientAdapters';
import { resolvePluginText } from './pluginText';

type Props = {
    visible: boolean;
    initialPluginId?: string | null;
    onClose: () => void;
};

function PluginRow({
    installed,
    loading,
    onPress,
    plugin,
}: {
    installed: boolean;
    loading: boolean;
    onPress: () => void;
    plugin: PluginCatalogItem;
}) {
    const { theme } = useUnistyles();
    const currentVersionInstalled = plugin.status.installed
        && plugin.status.version === plugin.manifest.version;
    return (
        <Pressable
            accessibilityRole="button"
            disabled={loading}
            onPress={onPress}
            style={({ pressed }) => [styles.pluginRow, pressed && styles.pressed]}
            testID={`plugin-marketplace-plugin-${plugin.manifest.id}`}
        >
            <View style={styles.pluginIcon}>
                <Ionicons color={theme.colors.accent} name={plugin.manifest.icon as any} size={21} />
            </View>
            <View style={styles.pluginCopy}>
                <Text numberOfLines={1} style={styles.pluginTitle}>{resolvePluginText(plugin.manifest.title)}</Text>
                <Text numberOfLines={2} style={styles.pluginDescription}>{resolvePluginText(plugin.manifest.description)}</Text>
            </View>
            <View style={[styles.actionPill, installed && styles.actionPillInstalled]}>
                <Text style={[styles.actionText, installed && styles.actionTextInstalled]}>
                    {installed
                        ? t(!currentVersionInstalled
                            ? 'relationshipAdvisorPlugin.update'
                            : plugin.manifest.installedAction === 'open'
                                ? 'relationshipAdvisorPlugin.openPlugin'
                                : 'relationshipAdvisorPlugin.configure')
                        : t('relationshipAdvisorPlugin.install')}
                </Text>
            </View>
        </Pressable>
    );
}

export const PluginMarketplaceModal = React.memo(function PluginMarketplaceModal({
    visible,
    initialPluginId = null,
    onClose,
}: Props) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const windowDimensions = useWindowDimensions();
    const router = useRouter();
    const isDesktop = Platform.OS === 'web' && windowDimensions.width >= 900;
    const [activePluginId, setActivePluginId] = React.useState<string | null>(initialPluginId);
    const [query, setQuery] = React.useState('');
    const { loading, plugins, refresh } = usePlugins(visible);

    React.useEffect(() => {
        if (!visible) return;
        setActivePluginId(initialPluginId);
        setQuery('');
    }, [initialPluginId, visible]);

    const close = React.useCallback(() => {
        setActivePluginId(null);
        setQuery('');
        onClose();
    }, [onClose]);

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filteredPlugins = React.useMemo(() => plugins.filter((plugin) => {
        if (!normalizedQuery) return true;
        return `${resolvePluginText(plugin.manifest.title)} ${resolvePluginText(plugin.manifest.description)}`
            .toLocaleLowerCase()
            .includes(normalizedQuery);
    }), [normalizedQuery, plugins]);
    const activePlugin = plugins.find((plugin) => plugin.manifest.id === activePluginId);
    const activeModalContribution = activePlugin?.manifest.contributes.views.find((view) => (
        view.surface === 'modal'
    ));
    const activeInstalledModal = activePlugin && activeModalContribution
        ? resolveInstalledPluginView(activePlugin, activeModalContribution.id, 'modal')
        : null;
    const installedPlugins = plugins.filter((plugin) => plugin.status.installed);

    const openPlugin = React.useCallback((plugin: PluginCatalogItem) => {
        const entrypoint = resolveInstalledPluginEntrypoint(plugin);
        if (!entrypoint?.path) return;
        close();
        router.navigate(entrypoint.path as any);
    }, [close, router]);

    return (
        <Modal
            animationType={isDesktop ? 'fade' : 'slide'}
            onRequestClose={close}
            transparent
            visible={visible}
        >
            <View
                style={[
                    styles.modalRoot,
                    isDesktop ? styles.modalRootDesktop : styles.modalRootMobile,
                    { paddingBottom: isDesktop ? 24 : safeArea.bottom },
                ]}
                testID="plugin-marketplace-modal-root"
            >
                <Pressable
                    accessible={false}
                    onPress={close}
                    style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: theme.colors.shadow.color, opacity: 0.42 },
                    ]}
                    testID="plugin-marketplace-backdrop"
                />
                <View
                    accessibilityLabel={activePlugin
                        ? resolvePluginText(activePlugin.manifest.title)
                        : t('relationshipAdvisorPlugin.marketTitle')}
                    accessibilityViewIsModal
                    style={[styles.panel, isDesktop ? styles.panelDesktop : styles.panelMobile]}
                    testID={isDesktop ? 'plugin-marketplace-desktop-dialog' : 'plugin-marketplace-mobile-drawer'}
                    {...({ 'aria-modal': true, role: 'dialog' } as any)}
                >
                    <View style={styles.header}>
                        {activePluginId ? (
                            <Pressable
                                accessibilityLabel={t('common.back')}
                                accessibilityRole="button"
                                hitSlop={8}
                                onPress={() => setActivePluginId(null)}
                                style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
                                testID="plugin-marketplace-back"
                            >
                                <Ionicons color={theme.colors.text} name="chevron-back" size={21} />
                            </Pressable>
                        ) : <View style={styles.headerPlaceholder} />}
                        <Text numberOfLines={1} style={styles.headerTitle}>
                            {activePlugin
                                ? resolvePluginText(activePlugin.manifest.title)
                                : t('relationshipAdvisorPlugin.marketTitle')}
                        </Text>
                        <Pressable
                            accessibilityLabel={t('common.cancel')}
                            accessibilityRole="button"
                            hitSlop={8}
                            onPress={close}
                            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
                            testID="plugin-marketplace-close"
                        >
                            <Ionicons color={theme.colors.text} name="close" size={21} />
                        </Pressable>
                    </View>

                    {activePlugin ? (
                        <View style={styles.configurationContent}>
                            {activeInstalledModal?.componentId === 'plugin-configuration' ? (
                                <PluginModalSlot
                                    onInstalled={activePlugin.manifest.installedAction === 'open'
                                        ? () => openPlugin(activePlugin)
                                        : undefined}
                                    onOpen={() => openPlugin(activePlugin)}
                                    onStatusChanged={async () => { await refresh(); }}
                                    plugin={activePlugin}
                                />
                            ) : (
                                <DynamicPluginConfiguration
                                    onInstalled={activePlugin.manifest.installedAction === 'open'
                                        ? () => openPlugin(activePlugin)
                                        : undefined}
                                    onOpen={() => openPlugin(activePlugin)}
                                    onStatusChanged={async () => { await refresh(); }}
                                    plugin={activePlugin}
                                />
                            )}
                        </View>
                    ) : (
                        <View style={styles.marketContent}>
                            <View style={styles.intro}>
                                <Text style={styles.marketSubtitle}>{t('relationshipAdvisorPlugin.marketSubtitle')}</Text>
                            </View>
                            <View style={styles.searchField}>
                                <Ionicons color={theme.colors.textSecondary} name="search-outline" size={18} />
                                <TextInput
                                    accessibilityLabel={t('relationshipAdvisorPlugin.searchPlaceholder')}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    onChangeText={setQuery}
                                    placeholder={t('relationshipAdvisorPlugin.searchPlaceholder')}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    style={styles.searchInput}
                                    testID="plugin-marketplace-search"
                                    value={query}
                                />
                            </View>

                            <ScrollView
                                contentContainerStyle={styles.sections}
                                keyboardShouldPersistTaps="handled"
                                style={styles.scroll}
                            >
                                {installedPlugins.length > 0 && normalizedQuery.length === 0 ? (
                                    <View testID="plugin-marketplace-installed-section">
                                        <Text style={styles.sectionTitle}>{t('relationshipAdvisorPlugin.installedSection')}</Text>
                                        <View style={styles.installedStrip}>
                                            {installedPlugins.map((plugin) => (
                                                <Pressable
                                                    accessibilityRole="button"
                                                    key={plugin.manifest.id}
                                                    onPress={() => setActivePluginId(plugin.manifest.id)}
                                                    style={({ pressed }) => [styles.installedPlugin, pressed && styles.pressed]}
                                                    testID={`plugin-marketplace-installed-${plugin.manifest.id}`}
                                                >
                                                    <View style={styles.installedIcon}>
                                                        <Ionicons color={theme.colors.accent} name={plugin.manifest.icon as any} size={20} />
                                                    </View>
                                                    <Text numberOfLines={1} style={styles.installedLabel}>
                                                        {resolvePluginText(plugin.manifest.title)}
                                                    </Text>
                                                </Pressable>
                                            ))}
                                        </View>
                                    </View>
                                ) : null}

                                {filteredPlugins.length > 0 ? (
                                    <View testID="plugin-marketplace-featured-section">
                                        <Text style={styles.sectionTitle}>{t('relationshipAdvisorPlugin.featuredSection')}</Text>
                                        <View style={styles.pluginList}>
                                            {filteredPlugins.map((plugin) => (
                                                <PluginRow
                                                    installed={plugin.status.installed}
                                                    key={plugin.manifest.id}
                                                    loading={loading}
                                                    onPress={() => setActivePluginId(plugin.manifest.id)}
                                                    plugin={plugin}
                                                />
                                            ))}
                                        </View>
                                    </View>
                                ) : (
                                    <View style={styles.empty} testID="plugin-marketplace-empty">
                                        <Ionicons color={theme.colors.textSecondary} name="search-outline" size={24} />
                                        <Text style={styles.emptyText}>{t('relationshipAdvisorPlugin.emptySearch')}</Text>
                                    </View>
                                )}
                            </ScrollView>
                        </View>
                    )}
                </View>
            </View>
        </Modal>
    );
});

const styles = StyleSheet.create((theme) => ({
    modalRoot: { flex: 1 },
    modalRootDesktop: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingTop: 24,
    },
    modalRootMobile: { justifyContent: 'flex-end' },
    panel: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
    },
    panelDesktop: {
        borderRadius: 14,
        height: '82%',
        maxHeight: 760,
        maxWidth: 720,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 32,
        width: '100%',
    },
    panelMobile: {
        borderTopLeftRadius: 18,
        borderTopRightRadius: 18,
        height: '88%',
        width: '100%',
    },
    header: {
        alignItems: 'center',
        borderBottomColor: theme.colors.divider,
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        minHeight: 54,
        paddingHorizontal: 12,
    },
    headerButton: {
        alignItems: 'center',
        borderRadius: 8,
        height: 34,
        justifyContent: 'center',
        width: 34,
    },
    headerPlaceholder: { height: 34, width: 34 },
    headerTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        flex: 1,
        fontSize: 16,
        textAlign: 'center',
    },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    configurationContent: { flex: 1, minHeight: 0 },
    marketContent: { flex: 1, minHeight: 0, paddingTop: 22 },
    intro: { paddingHorizontal: 24 },
    marketSubtitle: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
    },
    searchField: {
        alignItems: 'center',
        backgroundColor: theme.colors.input.background,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 8,
        marginHorizontal: 24,
        marginTop: 18,
        minHeight: 42,
        paddingHorizontal: 12,
    },
    searchInput: {
        ...Typography.default(),
        color: theme.colors.text,
        flex: 1,
        fontSize: 15,
        minHeight: 40,
        paddingVertical: 8,
    },
    scroll: { flexGrow: 0, marginTop: 10 },
    sections: {
        gap: 24,
        paddingBottom: 28,
        paddingHorizontal: 24,
        paddingTop: 12,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        fontSize: 12,
        letterSpacing: 0.3,
        marginBottom: 8,
        textTransform: 'uppercase',
    },
    installedStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    installedPlugin: {
        alignItems: 'center',
        borderRadius: 10,
        gap: 7,
        padding: 7,
        width: 88,
    },
    installedIcon: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceSelected,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        height: 42,
        justifyContent: 'center',
        width: 42,
    },
    installedLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 12,
        textAlign: 'center',
        width: '100%',
    },
    pluginList: {
        borderColor: theme.colors.divider,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
    },
    pluginRow: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        flexDirection: 'row',
        gap: 11,
        minHeight: 68,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    pluginIcon: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceSelected,
        borderRadius: 9,
        height: 38,
        justifyContent: 'center',
        width: 38,
    },
    pluginCopy: { flex: 1, minWidth: 0 },
    pluginTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 19,
    },
    pluginDescription: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
        marginTop: 2,
    },
    actionPill: {
        backgroundColor: theme.colors.surfacePressed,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 11,
        paddingVertical: 6,
    },
    actionPillInstalled: { backgroundColor: theme.colors.surfaceSelected },
    actionText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 12,
    },
    actionTextInstalled: { color: theme.colors.accent },
    empty: {
        alignItems: 'center',
        gap: 8,
        justifyContent: 'center',
        minHeight: 180,
    },
    emptyText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
}));
