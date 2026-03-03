import * as React from 'react';
import { View, ActivityIndicator, Platform, Pressable, ScrollView, TextInput } from 'react-native';
import { useRoute, useFocusEffect } from '@react-navigation/native';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { sessionListDirectory, sessionBash } from '@/sync/ops';
import { getSession } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';
import { t } from '@/text';
import { loadBrowserLastPath, saveBrowserLastPath } from '@/sync/persistence';

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}

interface SearchResult {
    relativePath: string;
    fileName: string;
    dirPath: string;
}

function formatFileSize(bytes?: number): string {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseGlobalResults(stdout: string): SearchResult[] {
    return stdout.trim().split('\n').filter(Boolean).slice(0, 100).map(line => {
        const relativePath = line.startsWith('./') ? line.substring(2) : line;
        const fileName = relativePath.split('/').pop() || relativePath;
        const dirPath = relativePath.includes('/')
            ? relativePath.substring(0, relativePath.lastIndexOf('/'))
            : '';
        return { relativePath, fileName, dirPath };
    });
}

export default function BrowserScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    const { theme } = useUnistyles();

    const session = getSession(sessionId);
    const rootPath = session?.metadata?.path || '';

    const [currentPath, setCurrentPath] = React.useState(rootPath);
    const [entries, setEntries] = React.useState<DirectoryEntry[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    // Search state
    const [searchActive, setSearchActive] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [globalResults, setGlobalResults] = React.useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const searchInputRef = React.useRef<TextInput>(null);

    const loadDirectory = React.useCallback(async (path: string, silent?: boolean): Promise<boolean> => {
        if (!silent) setIsLoading(true);
        setError(null);
        try {
            const response = await sessionListDirectory(sessionId, path);
            if (response.success && response.entries) {
                setEntries(response.entries);
                setCurrentPath(path);
                if (rootPath && path.startsWith(rootPath)) {
                    saveBrowserLastPath(rootPath, path);
                }
                return true;
            } else {
                setError(response.error || t('browser.failedToLoad'));
                return false;
            }
        } catch (e) {
            setError(t('browser.failedToLoad'));
            return false;
        } finally {
            if (!silent) setIsLoading(false);
        }
    }, [sessionId, rootPath]);

    React.useEffect(() => {
        let cancelled = false;

        const loadInitialDirectory = async () => {
            if (!rootPath) return;

            const cachedPath = loadBrowserLastPath(rootPath);
            const initialPath = cachedPath && cachedPath.startsWith(rootPath) ? cachedPath : rootPath;
            const ok = await loadDirectory(initialPath);
            if (!ok && !cancelled && initialPath !== rootPath) {
                await loadDirectory(rootPath);
            }
        };

        loadInitialDirectory();

        return () => {
            cancelled = true;
        };
    }, [rootPath, loadDirectory]);

    // Refresh silently when screen is focused (after returning from file view)
    useFocusEffect(
        React.useCallback(() => {
            if (entries.length > 0) {
                loadDirectory(currentPath, true);
            }
        }, [entries.length, currentPath, loadDirectory])
    );

    // Global file search with debounce
    React.useEffect(() => {
        if (!searchQuery || searchQuery.length < 2 || !rootPath) {
            setGlobalResults([]);
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        const timer = setTimeout(async () => {
            try {
                const response = await sessionBash(sessionId, {
                    command: `find . -type f -iname "*${searchQuery.replace(/"/g, '')}*" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -100`,
                    cwd: rootPath,
                    timeout: 10000,
                });
                if (response.success && response.stdout) {
                    setGlobalResults(parseGlobalResults(response.stdout));
                } else {
                    setGlobalResults([]);
                }
            } catch {
                setGlobalResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [searchQuery, sessionId, rootPath]);

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
            router.push(`/session/${sessionId}/file?path=${encodeURIComponent(encodedPath)}`);
        }
    }, [currentPath, navigateTo, router, sessionId]);

    const handleSearchResultPress = React.useCallback((result: SearchResult) => {
        const fullPath = `${rootPath}/${result.relativePath}`;
        const encodedPath = btoa(
            new TextEncoder().encode(fullPath).reduce((s, b) => s + String.fromCharCode(b), '')
        );
        router.push(`/session/${sessionId}/file?path=${encodeURIComponent(encodedPath)}`);
    }, [rootPath, router, sessionId]);

    const handleNavigateUp = React.useCallback(() => {
        if (currentPath === rootPath) return;
        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || rootPath;
        navigateTo(parentPath);
    }, [currentPath, rootPath, navigateTo]);

    const toggleSearch = React.useCallback(() => {
        if (searchActive) {
            setSearchActive(false);
            setSearchQuery('');
            setGlobalResults([]);
        } else {
            setSearchActive(true);
            setTimeout(() => searchInputRef.current?.focus(), 100);
        }
    }, [searchActive]);

    // Filter current directory entries by search query
    const filteredEntries = React.useMemo(() => {
        if (!searchQuery) return entries;
        const q = searchQuery.toLowerCase();
        return entries.filter(e => e.name.toLowerCase().includes(q));
    }, [entries, searchQuery]);

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
            <Stack.Screen
                options={{
                    headerRight: () => (
                        <Pressable
                            onPress={toggleSearch}
                            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                        >
                            <Ionicons
                                name={searchActive ? 'close' : 'search'}
                                size={22}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    ),
                }}
            />

            {/* Search bar */}
            {searchActive && (
                <View style={{
                    padding: 12,
                    paddingTop: 8,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 10,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                    }}>
                        <Ionicons name="search" size={16} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
                        <TextInput
                            ref={searchInputRef}
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            placeholder={t('browser.searchPlaceholder')}
                            style={{
                                flex: 1,
                                fontSize: 16,
                                color: theme.colors.text,
                                ...Typography.default(),
                            }}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="search"
                        />
                        {searchQuery.length > 0 && (
                            <Pressable onPress={() => setSearchQuery('')}>
                                <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
                            </Pressable>
                        )}
                    </View>
                </View>
            )}

            {/* Breadcrumb navigation - hidden during search */}
            {!searchActive && (
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
            )}

            {/* Directory listing / Search results */}
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
                ) : searchActive && searchQuery.length > 0 ? (
                    <>
                        {/* Local filtered results */}
                        {filteredEntries.length > 0 && filteredEntries.map((entry, index) => (
                            <Item
                                key={entry.name}
                                title={entry.name}
                                subtitle={entry.type === 'file' ? formatFileSize(entry.size) : undefined}
                                icon={entry.type === 'directory'
                                    ? <Ionicons name="folder" size={29} color="#007AFF" />
                                    : <FileIcon fileName={entry.name} size={29} />
                                }
                                onPress={() => handleEntryPress(entry)}
                                showDivider={index < filteredEntries.length - 1 || globalResults.length > 0}
                                showChevron={entry.type === 'directory'}
                            />
                        ))}

                        {/* Global search results section */}
                        {searchQuery.length >= 2 && (
                            <>
                                {isSearching ? (
                                    <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    </View>
                                ) : globalResults.length > 0 ? (
                                    <>
                                        <View style={{
                                            paddingHorizontal: 16,
                                            paddingTop: 16,
                                            paddingBottom: 8,
                                        }}>
                                            <Text style={{
                                                fontSize: 13,
                                                color: theme.colors.textSecondary,
                                                textTransform: 'uppercase',
                                                letterSpacing: 0.5,
                                                ...Typography.default('semiBold'),
                                            }}>
                                                {t('browser.globalResults')}
                                            </Text>
                                        </View>
                                        {globalResults.map((result, index) => (
                                            <Item
                                                key={result.relativePath}
                                                title={result.fileName}
                                                subtitle={result.dirPath}
                                                icon={<FileIcon fileName={result.fileName} size={29} />}
                                                onPress={() => handleSearchResultPress(result)}
                                                showDivider={index < globalResults.length - 1}
                                            />
                                        ))}
                                    </>
                                ) : null}
                            </>
                        )}

                        {/* No results at all */}
                        {filteredEntries.length === 0 && globalResults.length === 0 && !isSearching && (
                            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
                                <Ionicons name="search-outline" size={48} color={theme.colors.textSecondary} />
                                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                                    {t('browser.noResults')}
                                </Text>
                            </View>
                        )}
                    </>
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
                                title=""
                                icon={<Text style={{ fontSize: 22, color: theme.colors.textSecondary, fontWeight: '800', width: 29, textAlign: 'center' }}>..</Text>}
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
