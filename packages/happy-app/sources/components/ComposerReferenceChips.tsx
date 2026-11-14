import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComposerReference } from '@/sync/composerReferences';
import { usePlugins } from '@/hooks/usePlugins';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { t } from '@/text';
import { Modal } from '@/modal';
import { resolveInstalledPluginEntrypoint } from './plugins/pluginClientAdapters';
import { PluginMarketplaceModal } from './plugins/PluginMarketplaceModal';

export function ComposerReferenceChips({ references, onRemove }: { references: ComposerReference[]; onRemove: (item: ComposerReference) => void }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { plugins } = usePlugins(references.some(r => r.kind === 'plugin'));
    const [configure, setConfigure] = React.useState<string | null>(null);
    const open = (reference: ComposerReference) => {
        if (reference.kind === 'session') { router.push(`/session/${reference.id}`); return; }
        if (reference.kind === 'site') { void openExternalUrl(reference.url!); return; }
        const plugin = plugins.find(p => p.manifest.id === reference.id && p.status.installed);
        if (!plugin) { Modal.alert(t('composerContext.contextUnavailable')); return; }
        const entry = resolveInstalledPluginEntrypoint(plugin);
        if (entry?.path) router.navigate(entry.path as any);
        else setConfigure(reference.id);
    };
    return <>
        {references.length > 0 && <View style={styles.row} testID="composer-reference-chips">
            {references.map(reference => <View key={`${reference.kind}:${reference.id}`} style={styles.chip} testID={`composer-reference-${reference.kind}-${reference.id}`}>
                <Pressable accessibilityRole="link" accessibilityLabel={`${t('composerContext.openReference')}: ${reference.title}`} onPress={() => open(reference)} style={({ pressed }) => [styles.open, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
                    <Ionicons name={reference.kind === 'session' ? 'chatbubble-outline' : reference.kind === 'plugin' ? 'extension-puzzle-outline' : 'globe-outline'} size={15} color={theme.colors.textLink} />
                    <Text numberOfLines={1} style={styles.label}>{reference.title}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`${t('composerContext.removeReference')}: ${reference.title}`} onPress={() => onRemove(reference)} hitSlop={6} style={({ pressed }) => [styles.remove, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
                    <Ionicons name="close" size={13} color={theme.colors.textSecondary} />
                </Pressable>
            </View>)}
        </View>}
        {configure !== null && <PluginMarketplaceModal visible initialPluginId={configure} onClose={() => setConfigure(null)} />}
    </>;
}
const styles = StyleSheet.create(theme => ({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 2 },
    chip: { flexDirection: 'row', alignItems: 'center', maxWidth: '100%', borderRadius: 6 },
    open: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, paddingVertical: 3 },
    label: { fontSize: 14, color: theme.colors.textLink, flexShrink: 1, fontWeight: '500' },
    remove: { padding: 5 },
}));
