import * as React from 'react';
import { View, Text, TextInput, ActivityIndicator, Platform, Pressable } from 'react-native';
import { BottomSheetModal, BottomSheetFlatList, BottomSheetTextInput, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { machineBash } from '@/sync/ops';
import * as Clipboard from 'expo-clipboard';
import { hapticsLight } from '@/components/haptics';
import { showCopiedToast } from '@/components/Toast';

const SheetTextInput = Platform.OS === 'web' ? TextInput : BottomSheetTextInput;

interface FolderPickerSheetProps {
    machineId: string;
    homeDir?: string;
    /** 'directory' (default) picks folders; 'file' picks individual files. */
    mode?: 'directory' | 'file';
    onSelect: (path: string) => void;
    /** Multi-select callback for file mode. When provided, files are toggled instead of immediately selected. */
    onFileSelect?: (paths: string[]) => void;
    /** Initial selection of absolute file paths for multi-select mode. */
    initialSelection?: string[];
}

interface DirEntry {
    name: string;
    isGitRepo: boolean;
    isDir: boolean;
}

/**
 * BottomSheet-based directory browser for picking folders on a remote machine.
 *
 * Behaviour:
 *  - Lists only directories (hidden files excluded).
 *  - Detects git repos up to 2 levels deep and shows a badge.
 *  - Search field filters entries by name; typing an absolute or ~/… path
 *    and pressing Enter navigates to that path.
 *  - "Select" button in nav bar confirms the current directory.
 *  - ".." entry navigates to parent directory.
 */
export const FolderPickerSheet = React.memo(React.forwardRef<BottomSheetModal, FolderPickerSheetProps>(({
    machineId,
    homeDir = '/',
    mode = 'directory',
    onSelect,
    onFileSelect,
    initialSelection,
}, ref) => {
    const isFileMode = mode === 'file';
    const { theme } = useUnistyles();

    // ---- state ----
    const [currentPath, setCurrentPath] = React.useState(homeDir);
    const [entries, setEntries] = React.useState<DirEntry[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [search, setSearch] = React.useState('');
    const [selectedFiles, setSelectedFiles] = React.useState<Set<string>>(new Set());
    const fetchIdRef = React.useRef(0);

    // ---- helpers ----

    /** Resolve ~ to homeDir for client-side path operations. */
    const resolvePath = React.useCallback((path: string) => {
        if (path === '~') return homeDir;
        if (path.startsWith('~/')) return homeDir + path.slice(1);
        return path;
    }, [homeDir]);

    const fetchDirectory = React.useCallback(async (dirPath: string) => {
        const id = ++fetchIdRef.current;
        setLoading(true);
        setError(null);
        try {
            if (isFileMode) {
                // File mode: list files and directories
                const lsResult = await machineBash(machineId, "ls -1ap", dirPath);
                if (id !== fetchIdRef.current) return;
                if (!lsResult.success) {
                    setError(t('newSession.repos.folderPicker.loadError'));
                    setEntries([]);
                    return;
                }
                const lines = lsResult.stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('.'));
                const dirs: DirEntry[] = [];
                const files: DirEntry[] = [];
                for (const line of lines) {
                    if (line.endsWith('/')) {
                        dirs.push({ name: line.replace(/\/$/, ''), isGitRepo: false, isDir: true });
                    } else {
                        files.push({ name: line, isGitRepo: false, isDir: false });
                    }
                }
                dirs.sort((a, b) => a.name.localeCompare(b.name));
                files.sort((a, b) => a.name.localeCompare(b.name));
                setEntries([...dirs, ...files]);
            } else {
                // Directory mode: list only directories
                const lsResult = await machineBash(
                    machineId,
                    "ls -1ap | grep '/$' | sed 's/\\/$//'",
                    dirPath,
                );
                if (id !== fetchIdRef.current) return;
                if (!lsResult.success) {
                    setError(t('newSession.repos.folderPicker.loadError'));
                    setEntries([]);
                    return;
                }

                const dirNames = lsResult.stdout
                    .split('\n')
                    .map(s => s.trim())
                    .filter(s => s.length > 0 && !s.startsWith('.'));

                // Batch git-repo detection
                const gitResult = await machineBash(
                    machineId,
                    "find . -maxdepth 2 -name '.git' -type d 2>/dev/null | sed 's|^\\./||' | sed 's|/\\.git$||'",
                    dirPath,
                );
                if (id !== fetchIdRef.current) return;
                const gitSet = new Set<string>();
                if (gitResult.success && gitResult.stdout.trim().length > 0) {
                    for (const line of gitResult.stdout.split('\n')) {
                        const trimmed = line.trim();
                        if (trimmed.length > 0) {
                            gitSet.add(trimmed);
                        }
                    }
                }

                const parsed: DirEntry[] = dirNames.map(name => ({
                    name,
                    isGitRepo: gitSet.has(name),
                    isDir: true,
                }));

                parsed.sort((a, b) => {
                    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

                setEntries(parsed);
            }
        } catch {
            if (id !== fetchIdRef.current) return;
            setError(t('newSession.repos.folderPicker.loadError'));
            setEntries([]);
        } finally {
            if (id === fetchIdRef.current) setLoading(false);
        }
    }, [machineId, isFileMode]);

    // Navigate to a new directory
    const navigateTo = React.useCallback((path: string) => {
        setSearch('');
        setCurrentPath(path);
        fetchDirectory(path);
    }, [fetchDirectory]);

    // ---- sheet lifecycle ----

    const handleAnimate = React.useCallback((from: number, to: number) => {
        if (from === -1 && to === 0) {
            setSelectedFiles(initialSelection?.length ? new Set(initialSelection) : new Set());
            navigateTo(homeDir);
        }
    }, [homeDir, navigateTo, initialSelection]);

    const handleDismiss = React.useCallback(() => {
        setSearch('');
    }, []);

    // ---- navigation actions ----

    const goHome = React.useCallback(() => {
        navigateTo(homeDir);
    }, [homeDir, navigateTo]);

    const goUp = React.useCallback(() => {
        if (currentPath === '/') return;
        // Resolve parent: strip trailing /, then take dirname
        const clean = currentPath.replace(/\/+$/, '');
        const lastSlash = clean.lastIndexOf('/');
        const parent = lastSlash <= 0 ? '/' : clean.substring(0, lastSlash);
        navigateTo(parent);
    }, [currentPath, navigateTo]);

    const handleEntryPress = React.useCallback((item: DirEntry) => {
        const next = currentPath === '/'
            ? '/' + item.name
            : currentPath.replace(/\/+$/, '') + '/' + item.name;
        if (isFileMode && !item.isDir) {
            if (onFileSelect) {
                // Multi-select: toggle file in set
                setSelectedFiles(prev => {
                    const updated = new Set(prev);
                    if (updated.has(next)) updated.delete(next);
                    else updated.add(next);
                    return updated;
                });
                return;
            }
            // Single-select fallback
            onSelect(next);
            if (ref && typeof ref !== 'function' && ref.current) {
                ref.current.dismiss();
            }
            return;
        }
        navigateTo(next);
    }, [currentPath, navigateTo, isFileMode, onSelect, onFileSelect, ref]);

    const handleSelect = React.useCallback(() => {
        onSelect(currentPath);
        if (ref && typeof ref !== 'function' && ref.current) {
            ref.current.dismiss();
        }
    }, [currentPath, onSelect, ref]);

    const handleConfirmFiles = React.useCallback(() => {
        if (onFileSelect && selectedFiles.size > 0) {
            onFileSelect([...selectedFiles]);
            if (ref && typeof ref !== 'function' && ref.current) {
                ref.current.dismiss();
            }
        }
    }, [selectedFiles, onFileSelect, ref]);

    const handleCopyPath = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(currentPath);
            hapticsLight(); showCopiedToast();
        } catch {}
    }, [currentPath]);

    // ---- search / path jump ----

    const handleSearchSubmit = React.useCallback(() => {
        const trimmed = search.trim();
        if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
            navigateTo(resolvePath(trimmed));
        }
    }, [search, navigateTo, resolvePath]);

    const clearSearch = React.useCallback(() => {
        setSearch('');
    }, []);

    // ---- filtered entries ----

    const filtered = React.useMemo(() => {
        if (!search.trim() || search.startsWith('/') || search.startsWith('~')) return entries;
        const q = search.toLowerCase();
        return entries.filter(e => e.name.toLowerCase().includes(q));
    }, [entries, search]);

    // ---- rendering ----

    const renderBackdrop = React.useCallback(
        (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
        [],
    );

    // Format path for display: substitute homeDir with ~, then truncate if needed
    const displayPath = React.useMemo(() => {
        let display = currentPath;
        if (homeDir && homeDir !== '/' && currentPath.startsWith(homeDir)) {
            display = '~' + currentPath.slice(homeDir.length);
            if (display === '~') display = '~/';
        }
        if (display.length <= 40) return display;
        return '...' + display.slice(-37);
    }, [currentPath, homeDir]);

    const isAtRoot = currentPath === '/' || currentPath === homeDir;

    const renderItem = React.useCallback(({ item }: { item: DirEntry }) => {
        const fullPath = currentPath === '/'
            ? '/' + item.name
            : currentPath.replace(/\/+$/, '') + '/' + item.name;
        const isSelected = isFileMode && !item.isDir && selectedFiles.has(fullPath);

        const iconName = item.isDir
            ? (item.isGitRepo ? 'git-branch' : 'folder')
            : (isFileMode && onFileSelect)
                ? (isSelected ? 'checkbox' : 'square-outline')
                : 'document-outline';
        const iconColor = isSelected
            ? theme.colors.textLink
            : item.isGitRepo
                ? theme.colors.success
                : theme.colors.textSecondary;

        return (
            <Pressable
                style={({ pressed }) => [
                    itemStyles.row,
                    pressed && { backgroundColor: theme.colors.surfacePressed },
                ]}
                onPress={() => handleEntryPress(item)}
            >
                <Ionicons name={iconName} size={20} color={iconColor} />
                <Text style={[itemStyles.name, { color: theme.colors.text }]} numberOfLines={1}>
                    {item.name}
                </Text>
                {item.isGitRepo && (
                    <View style={[itemStyles.badge, { backgroundColor: theme.colors.success }]}>
                        <Text style={itemStyles.badgeText}>{t('newSession.repos.folderPicker.gitRepo')}</Text>
                    </View>
                )}
                {item.isDir && (
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                )}
            </Pressable>
        );
    }, [theme, handleEntryPress, currentPath, isFileMode, selectedFiles, onFileSelect]);

    const keyExtractor = React.useCallback((item: DirEntry) => item.name, []);

    const ListHeaderComponent = React.useMemo(() => {
        if (isAtRoot) return null;
        return (
            <Pressable
                style={({ pressed }) => [
                    itemStyles.row,
                    pressed && { backgroundColor: theme.colors.surfacePressed },
                ]}
                onPress={goUp}
            >
                <Text style={{ fontSize: 18, color: theme.colors.textSecondary, fontWeight: '600', width: 20, textAlign: 'center' }}>..</Text>
            </Pressable>
        );
    }, [theme, isAtRoot, goUp]);

    const ListEmptyComponent = React.useMemo(() => {
        if (loading) return null;
        return (
            <View style={emptyStyles.container}>
                <Text style={[emptyStyles.text, { color: theme.colors.textSecondary }]}>
                    {error || t('newSession.repos.folderPicker.emptyFolder')}
                </Text>
            </View>
        );
    }, [loading, error, theme]);

    return (
        <BottomSheetModal
            ref={ref}
            snapPoints={['75%']}
            enableDynamicSizing={false}
            keyboardBehavior="interactive"
            keyboardBlurBehavior="restore"
            android_keyboardInputMode="adjustResize"
            backdropComponent={renderBackdrop}
            onAnimate={handleAnimate}
            onDismiss={handleDismiss}
            backgroundStyle={{ backgroundColor: theme.colors.surface }}
            handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
        >
            <View style={{ flex: 1 }}>
                {/* Title */}
                <Text style={[headerStyles.title, { color: theme.colors.text }]}>
                    {isFileMode ? t('newSession.repos.folderPicker.selectFile') : t('newSession.repos.folderPicker.title')}
                </Text>

                {/* Pinned navigation bar */}
                <View style={[headerStyles.navBar, { borderBottomColor: theme.colors.divider }]}>
                    <Pressable onPress={goHome} hitSlop={8} style={headerStyles.navButton}>
                        <Ionicons name="home" size={20} color={theme.colors.textLink} />
                    </Pressable>
                    <Pressable onLongPress={handleCopyPath} style={{ flex: 1 }}>
                        <Text style={[headerStyles.pathText, { color: theme.colors.text }]} numberOfLines={1}>
                            {displayPath}
                        </Text>
                    </Pressable>
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                        {loading ? (
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        ) : !isFileMode ? (
                            <Pressable onPress={handleSelect} hitSlop={8}>
                                <Ionicons name="checkmark-circle" size={24} color={theme.colors.textLink} />
                            </Pressable>
                        ) : onFileSelect ? (
                            <Pressable
                                onPress={handleConfirmFiles}
                                disabled={selectedFiles.size === 0}
                                hitSlop={8}
                                style={{ position: 'relative' }}
                            >
                                <Ionicons
                                    name="checkmark-circle"
                                    size={24}
                                    color={selectedFiles.size > 0 ? theme.colors.textLink : theme.colors.textSecondary}
                                />
                                {selectedFiles.size > 0 && (
                                    <View style={{
                                        position: 'absolute', top: -6, right: -8,
                                        backgroundColor: theme.colors.button.primary.background,
                                        borderRadius: 8, minWidth: 16, height: 16,
                                        alignItems: 'center', justifyContent: 'center',
                                        paddingHorizontal: 4,
                                    }}>
                                        <Text style={{ fontSize: 10, color: theme.colors.button.primary.tint, fontWeight: '700' }}>
                                            {selectedFiles.size}
                                        </Text>
                                    </View>
                                )}
                            </Pressable>
                        ) : null}
                    </View>
                </View>

                {/* Pinned search / path input */}
                <View style={[headerStyles.searchContainer, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                    <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
                    <SheetTextInput
                        style={[
                            headerStyles.searchInput,
                            { color: theme.colors.text },
                            Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any,
                        ]}
                        placeholder={t('newSession.repos.folderPicker.searchPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={search}
                        onChangeText={setSearch}
                        onSubmitEditing={handleSearchSubmit}
                        returnKeyType="go"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    {search.length > 0 && (
                        <Pressable onPress={clearSearch} hitSlop={8}>
                            <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                    )}
                </View>

                <BottomSheetFlatList
                    data={filtered}
                    keyExtractor={keyExtractor}
                    renderItem={renderItem}
                    ListHeaderComponent={ListHeaderComponent}
                    ListEmptyComponent={ListEmptyComponent}
                    contentContainerStyle={{ paddingBottom: 20 }}
                    keyboardShouldPersistTaps="handled"
                />
            </View>
        </BottomSheetModal>
    );
}));

// ---- Styles ----

const headerStyles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        textAlign: 'center',
        paddingVertical: theme.margins.sm,
    },
    navBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.margins.lg,
        paddingVertical: theme.margins.sm,
        borderBottomWidth: 1,
        gap: theme.margins.sm,
    },
    navButton: {
        padding: 4,
    },
    pathText: {
        ...Typography.mono(),
        fontSize: 13,
        textAlign: 'center',
    },
    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: theme.margins.lg,
        marginVertical: theme.margins.md,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: theme.borderRadius.md,
        borderWidth: 1,
        gap: 8,
    },
    searchInput: {
        ...Typography.default(),
        flex: 1,
        fontSize: 15,
        lineHeight: 20,
        padding: 0,
    },
}));

const itemStyles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.margins.lg,
        paddingVertical: 12,
        gap: 12,
    },
    name: {
        ...Typography.default(),
        fontSize: 15,
        flex: 1,
    },
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
    },
    badgeText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        color: '#FFFFFF',
    },
}));

const emptyStyles = StyleSheet.create((_theme) => ({
    container: {
        alignItems: 'center',
        paddingTop: 40,
        paddingHorizontal: _theme.margins.lg,
    },
    text: {
        ...Typography.default(),
        fontSize: 14,
        textAlign: 'center',
    },
}));
