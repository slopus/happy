import * as React from 'react';
import { View, ActivityIndicator, Platform, Pressable, ScrollView } from 'react-native';
import { useRoute, useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { sessionListDirectory } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';
import { t } from '@/text';

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}

function formatFileSize(bytes?: number): string {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BrowserScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    const { theme } = useUnistyles();

    const session = storage.getState().sessions[sessionId];
    const rootPath = session?.metadata?.path || '';

    const [currentPath, setCurrentPath] = React.useState(rootPath);
    const [entries, setEntries] = React.useState<DirectoryEntry[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    const loadDirectory = React.useCallback(async (path: string, silent?: boolean) => {
        if (!silent) setIsLoading(true);
        setError(null);
        try {
            const response = await sessionListDirectory(sessionId, path);
            if (response.success && response.entries) {
                setEntries(response.entries);
                setCurrentPath(path);
            } else {
                setError(response.error || t('browser.failedToLoad'));
            }
        } catch (e) {
            setError(t('browser.failedToLoad'));
        } finally {
            if (!silent) setIsLoading(false);
        }
    }, [sessionId]);

    React.useEffect(() => {
        loadDirectory(rootPath);
    }, [rootPath, loadDirectory]);

    // Refresh silently when screen is focused (after returning from file view)
    useFocusEffect(
        React.useCallback(() => {
            if (entries.length > 0) {
                loadDirectory(currentPath, true);
            }
        }, [entries.length, currentPath, loadDirectory])
    );

    const navigateTo = React.useCallback((path: string) => {
        loadDirectory(path);
    }, [loadDirectory]);

    const handleEntryPress = React.useCallback((entry: DirectoryEntry) => {
        const fullPath = `${currentPath}/${entry.name}`;
        if (entry.type === 'directory') {
            navigateTo(fullPath);
        } else {
            const encodedPath = btoa(
                new TextEncoder().encode(fullPath).reduce((s, b) => s + String.fromCharCode(b), '')
            );
            router.push(`/session/${sessionId}/file?path=${encodedPath}`);
        }
    }, [currentPath, navigateTo, router, sessionId]);

    const handleNavigateUp = React.useCallback(() => {
        if (currentPath === rootPath) return;
        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || rootPath;
        navigateTo(parentPath);
    }, [currentPath, rootPath, navigateTo]);

    // Breadcrumb segments
    const breadcrumbs = React.useMemo(() => {
        if (!rootPath || !currentPath.startsWith(rootPath)) return [];
        const relativePath = currentPath.substring(rootPath.length);
        const projectName = rootPath.split('/').pop() || rootPath;
        const segments: { label: string; path: string }[] = [
            { label: projectName, path: rootPath },
        ];
        if (relativePath) {
            const parts = relativePath.split('/').filter(Boolean);
            let accumulated = rootPath;
            for (const part of parts) {
                accumulated += '/' + part;
                segments.push({ label: part, path: accumulated });
            }
        }
        return segments;
    }, [currentPath, rootPath]);

    const isAtRoot = currentPath === rootPath;
    const breadcrumbRef = React.useRef<ScrollView>(null);

    // Auto-scroll breadcrumb to end when path changes
    React.useEffect(() => {
        setTimeout(() => {
            breadcrumbRef.current?.scrollToEnd({ animated: true });
        }, 50);
    }, [currentPath]);

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            {/* Breadcrumb navigation */}
            <ScrollView
                ref={breadcrumbRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                    flexGrow: 0,
                }}
                contentContainerStyle={{
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    alignItems: 'center',
                }}
            >
                {breadcrumbs.map((segment, index) => (
                    <React.Fragment key={segment.path}>
                        {index > 0 && (
                            <Ionicons
                                name="chevron-forward"
                                size={14}
                                color={theme.colors.textSecondary}
                                style={{ marginHorizontal: 4 }}
                            />
                        )}
                        <Pressable onPress={() => navigateTo(segment.path)}>
                            <Text style={{
                                fontSize: 14,
                                color: index === breadcrumbs.length - 1
                                    ? theme.colors.text
                                    : theme.colors.textLink,
                                fontWeight: index === breadcrumbs.length - 1 ? '600' : '400',
                                ...Typography.default(),
                            }}>
                                {segment.label}
                            </Text>
                        </Pressable>
                    </React.Fragment>
                ))}
            </ScrollView>

            {/* Directory listing */}
            <ItemList style={{ flex: 1 }}>
                {isLoading ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : error ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40, paddingHorizontal: 20 }}>
                        <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                            {error}
                        </Text>
                    </View>
                ) : entries.length === 0 ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
                        <Ionicons name="folder-open-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                            {t('browser.emptyDirectory')}
                        </Text>
                    </View>
                ) : (
                    <>
                        {/* Parent directory entry */}
                        {!isAtRoot && (
                            <Item
                                title=".."
                                icon={<Ionicons name="return-up-back-outline" size={29} color={theme.colors.textSecondary} />}
                                onPress={handleNavigateUp}
                                showDivider={entries.length > 0}
                            />
                        )}

                        {/* Directory and file entries */}
                        {entries.map((entry, index) => (
                            <Item
                                key={entry.name}
                                title={entry.name}
                                subtitle={entry.type === 'file' ? formatFileSize(entry.size) : undefined}
                                icon={entry.type === 'directory'
                                    ? <Ionicons name="folder" size={29} color="#007AFF" />
                                    : <FileIcon fileName={entry.name} size={29} />
                                }
                                onPress={() => handleEntryPress(entry)}
                                showDivider={index < entries.length - 1}
                                showChevron={entry.type === 'directory'}
                            />
                        ))}
                    </>
                )}
            </ItemList>
        </View>
    );
}

const styles = StyleSheet.create((_theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center' as const,
        width: '100%',
    },
}));
