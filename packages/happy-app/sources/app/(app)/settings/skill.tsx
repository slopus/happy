import * as React from 'react';
import { ScrollView, View, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { layout } from '@/components/layout';
import { readSkillFileBase64 } from '@/sync/skills';
import { decodeBase64 } from '@/encryption/base64';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useSettingsSearchParams } from '@/components/DesktopSettingsNavigation';

export default React.memo(function SkillDetailScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { path, machineId, name } = useSettingsSearchParams<{ path: string; machineId: string; name: string }>();

    const [text, setText] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    // Bump to retry the load.
    const [reloadToken, setReloadToken] = React.useState(0);

    React.useEffect(() => {
        if (!path || !machineId) {
            setLoading(false);
            setError(t('settingsSkills.missingPath'));
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const base64 = await readSkillFileBase64(machineId, path);
                if (cancelled) return;
                const decoded = new TextDecoder().decode(decodeBase64(base64));
                setText(decoded);
            } catch (e) {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : t('settingsSkills.loadFailed'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [path, machineId, reloadToken]);

    return (
        <>
            <Stack.Screen options={{ headerTitle: name || t('settingsSkills.detailTitle') }} />
            {loading ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : error ? (
                <ScrollView style={styles.container} contentContainerStyle={styles.errorContent}>
                    <ItemGroup title={t('common.error')} footer={error}>
                        <Item
                            title={t('settingsSkills.loadFailed')}
                            subtitle={error}
                            subtitleLines={3}
                            icon={<Ionicons name="alert-circle-outline" size={29} color="#FF3B30" />}
                            showChevron={false}
                        />
                        <Item
                            title={t('common.retry')}
                            icon={<Ionicons name="refresh" size={29} color={theme.colors.button.primary.background} />}
                            onPress={() => setReloadToken((t) => t + 1)}
                            showChevron={false}
                        />
                    </ItemGroup>
                </ScrollView>
            ) : (
                <ScrollView
                    style={styles.container}
                    contentContainerStyle={[
                        styles.content,
                        { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' },
                    ]}
                >
                    <MarkdownView markdown={text} />
                </ScrollView>
            )}
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        padding: 16,
    },
    errorContent: {
        paddingTop: 16,
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.groupped.background,
    },
}));
