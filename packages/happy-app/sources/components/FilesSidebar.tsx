import * as React from 'react';
import { View, Text, ScrollView, Pressable, Platform, TextInput, ActivityIndicator } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    Easing,
} from 'react-native-reanimated';
import { storage, useSessionGitStatus, useSessionGitStatusFiles, useSessionProjectFiles } from '@/sync/storage';
import { getGitStatusFiles, GitFileStatus } from '@/sync/gitStatusFiles';
import { getProjectFiles, ProjectFile } from '@/sync/projectFiles';
import { FileIcon } from '@/components/FileIcon';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

export type SidebarMode = 'changes' | 'allFiles';

interface FilesSidebarProps {
    sessionId: string;
    selectedPath?: string | null;
    onFilePress?: (file: GitFileStatus) => void;
    mode?: SidebarMode;
    onModeChange?: (mode: SidebarMode) => void;
    onAllFilesFilePress?: (filePath: string) => void;
}

type FileNode<T = GitFileStatus> = {
    kind: 'file';
    name: string;
    path: string;
    file: T;
};

type DirNode<T = GitFileStatus> = {
    kind: 'dir';
    name: string;
    path: string;
    children: AnyTreeNode<T>[];
};

type AnyTreeNode<T = GitFileStatus> = FileNode<T> | DirNode<T>;

// Legacy alias for existing code
type TreeNode = AnyTreeNode<GitFileStatus>;

const PATH_SEPARATOR = ' / ';
const INDENT_PX = 14;

// Build a nested tree from a flat file list, then path-compress any dir chain
// where every intermediate dir has a single directory child. So a/b/c/file.ts
// where a and b each have only one dir child becomes a single "a / b / c" node.
function buildTree<T extends { fullPath: string }>(files: T[]): AnyTreeNode<T>[] {
    // De-dup files by fullPath (a file can appear in both staged and unstaged).
    const uniq = new Map<string, T>();
    for (const file of files) {
        if (!uniq.has(file.fullPath)) uniq.set(file.fullPath, file);
    }

    const root: DirNode<T> = { kind: 'dir', name: '', path: '', children: [] };

    for (const file of uniq.values()) {
        // Support both forward and back slashes (Windows paths)
        const parts = file.fullPath.split(/[/\\]/).filter(Boolean);
        let cursor = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const segment = parts[i];
            const nextPath = cursor.path ? `${cursor.path}/${segment}` : segment;
            let child = cursor.children.find((c) => c.kind === 'dir' && c.name === segment) as DirNode<T> | undefined;
            if (!child) {
                child = { kind: 'dir', name: segment, path: nextPath, children: [] };
                cursor.children.push(child);
            }
            cursor = child;
        }
        const leafName = parts[parts.length - 1] ?? file.fullPath;
        cursor.children.push({
            kind: 'file',
            name: leafName,
            path: file.fullPath,
            file,
        });
    }

    sortTree(root);
    compressTree(root);
    return root.children;
}

function sortTree<T>(node: DirNode<T>) {
    node.children.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
        if (child.kind === 'dir') sortTree(child);
    }
}

function compressTree<T>(node: DirNode<T>) {
    for (const child of node.children) {
        if (child.kind === 'dir') compressTree(child);
    }
    while (
        node !== undefined &&
        node.kind === 'dir' &&
        node.children.length === 1 &&
        node.children[0].kind === 'dir'
    ) {
        const only = node.children[0] as DirNode<T>;
        node.name = node.name ? `${node.name}${PATH_SEPARATOR}${only.name}` : only.name;
        node.path = only.path;
        node.children = only.children;
    }
}

// Depth-first walk that returns the filtered tree. A dir is kept if any of its
// descendants match; a file is kept if its path contains the query.
function filterTree<T>(nodes: AnyTreeNode<T>[], query: string): AnyTreeNode<T>[] {
    if (!query) return nodes;
    const q = query.toLowerCase();
    const result: AnyTreeNode<T>[] = [];
    for (const node of nodes) {
        if (node.kind === 'file') {
            if (node.path.toLowerCase().includes(q)) result.push(node);
        } else {
            const filteredChildren = filterTree(node.children, query);
            if (filteredChildren.length > 0) {
                result.push({ ...node, children: filteredChildren });
            }
        }
    }
    return result;
}

function collectDirPaths<T>(nodes: AnyTreeNode<T>[], acc: string[] = []): string[] {
    for (const node of nodes) {
        if (node.kind === 'dir') {
            acc.push(node.path);
            collectDirPaths(node.children, acc);
        }
    }
    return acc;
}

export const FilesSidebar = React.memo<FilesSidebarProps>(({
    sessionId,
    selectedPath,
    onFilePress,
    mode = 'changes',
    onModeChange,
    onAllFilesFilePress,
}) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const gitStatusFiles = useSessionGitStatusFiles(sessionId);
    const gitStatus = useSessionGitStatus(sessionId);

    const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());

    React.useEffect(() => {
        let cancelled = false;
        const pathKey = storage.getState().getSessionPathKey(sessionId);
        if (!pathKey) return;
        (async () => {
            const result = await getGitStatusFiles(sessionId);
            if (!cancelled && result) {
                storage.getState().applyGitStatusFiles(pathKey, result);
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId, gitStatus?.lastUpdatedAt]);

    const handleFilePress = React.useCallback((file: GitFileStatus) => {
        if (file.status === 'deleted') return;
        if (onFilePress) {
            onFilePress(file);
            return;
        }
        const encodedPath = btoa(file.fullPath);
        router.push(`/session/${sessionId}/file?path=${encodedPath}`);
    }, [router, sessionId, onFilePress]);

    const allFiles = React.useMemo(() => {
        const staged = gitStatusFiles?.stagedFiles ?? [];
        const unstaged = gitStatusFiles?.unstagedFiles ?? [];
        return [...staged, ...unstaged];
    }, [gitStatusFiles]);

    const tree = React.useMemo(() => buildTree(allFiles), [allFiles]);
    const filteredTree = tree;
    const effectiveCollapsed = collapsed;

    const hasFiles = allFiles.length > 0;

    const toggleDir = React.useCallback((path: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    return (
        <View style={styles.container}>
            {/* Tab selector */}
            <View style={styles.header}>
                {onModeChange ? (
                    <View style={styles.tabRow}>
                        <Pressable
                            onPress={() => onModeChange('changes')}
                            style={[
                                styles.tab,
                                mode === 'changes' && { backgroundColor: theme.colors.surface },
                            ]}
                        >
                            <Text style={[
                                styles.tabText,
                                mode === 'changes' && styles.tabTextActive,
                            ]} numberOfLines={1}>
                                {t('files.changes')}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => onModeChange('allFiles')}
                            style={[
                                styles.tab,
                                mode === 'allFiles' && { backgroundColor: theme.colors.surface },
                            ]}
                        >
                            <Text style={[
                                styles.tabText,
                                mode === 'allFiles' && styles.tabTextActive,
                            ]} numberOfLines={1}>
                                {t('files.allFiles')}
                            </Text>
                        </Pressable>
                    </View>
                ) : (
                    <Text style={styles.headerTitle} numberOfLines={1}>{t('files.changes')}</Text>
                )}
                {mode === 'changes' && hasFiles && gitStatus && (gitStatus.linesAdded > 0 || gitStatus.linesRemoved > 0) ? (
                    <View style={styles.headerLineChanges}>
                        {gitStatus.linesAdded > 0 && (
                            <Text style={styles.headerAdded}>+{gitStatus.linesAdded}</Text>
                        )}
                        {gitStatus.linesRemoved > 0 && (
                            <Text style={styles.headerRemoved}>-{gitStatus.linesRemoved}</Text>
                        )}
                    </View>
                ) : null}
            </View>

            {mode === 'changes' ? (
                <ScrollView style={styles.list} showsVerticalScrollIndicator={false} contentContainerStyle={styles.listContent}>
                    {!hasFiles ? (
                        <View style={styles.emptyState}>
                            <View style={styles.emptyIconWrap}>
                                <Octicons name="check" size={28} style={styles.emptyIcon} />
                            </View>
                            <Text style={styles.emptyTitle}>{t('files.noChangesTitle')}</Text>
                            <Text style={styles.emptySubtitle}>{t('files.noChangesSubtitle')}</Text>
                        </View>
                    ) : (
                        <View style={styles.tree}>
                            {filteredTree.map((node) => (
                                <TreeNodeRow
                                    key={node.path}
                                    node={node}
                                    depth={0}
                                    selectedPath={selectedPath ?? null}
                                    collapsed={effectiveCollapsed}
                                    onToggleDir={toggleDir}
                                    onFilePress={handleFilePress}
                                />
                            ))}
                        </View>
                    )}
                </ScrollView>
            ) : (
                <AllFilesTab
                    sessionId={sessionId}
                    selectedPath={selectedPath ?? null}
                    onFilePress={onAllFilesFilePress}
                />
            )}
        </View>
    );
});

/** All-files tab: reads from Zustand store, fetches on mount */
const AllFilesTab = React.memo(function AllFilesTab({
    sessionId,
    selectedPath,
    onFilePress,
}: {
    sessionId: string;
    selectedPath: string | null;
    onFilePress?: (filePath: string) => void;
}) {
    const { theme } = useUnistyles();
    const [searchQuery, setSearchQuery] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(false);

    const projectFiles = useSessionProjectFiles(sessionId);
    const allFiles = projectFiles?.files ?? [];

    // Fetch project files into Zustand on mount
    React.useEffect(() => {
        let cancelled = false;
        const pathKey = storage.getState().getSessionPathKey(sessionId);
        if (!pathKey) return;

        // Only fetch if not cached
        const existing = storage.getState().pathProjectFiles[pathKey];
        if (existing && existing.files.length > 0) return;

        setIsLoading(true);
        (async () => {
            const result = await getProjectFiles(sessionId);
            if (!cancelled) {
                storage.getState().applyProjectFiles(pathKey, result);
                setIsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId]);

    const tree = React.useMemo(() => buildTree(allFiles), [allFiles]);
    const filteredTree = React.useMemo(
        () => searchQuery.trim() ? filterTree(tree, searchQuery) : tree,
        [tree, searchQuery]
    );

    const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
    const toggleDir = React.useCallback((path: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const handleFilePress = React.useCallback((file: ProjectFile) => {
        onFilePress?.(file.fullPath);
    }, [onFilePress]);

    return (
        <View style={{ flex: 1 }}>
            {/* Search input */}
            <View style={styles.searchWrap}>
                <Octicons name="search" size={14} color={theme.colors.textSecondary} style={styles.searchIcon} />
                <TextInput
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder={t('files.searchPlaceholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={[styles.searchInput, { color: theme.colors.text }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </View>

            <ScrollView style={styles.list} showsVerticalScrollIndicator={false} contentContainerStyle={styles.listContent}>
                {isLoading && allFiles.length === 0 ? (
                    <View style={styles.emptyState}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : filteredTree.length === 0 ? (
                    <View style={styles.emptyState}>
                        <View style={styles.emptyIconWrap}>
                            <Octicons name="file" size={28} color={theme.colors.textSecondary} />
                        </View>
                        <Text style={styles.emptyTitle}>
                            {searchQuery ? t('files.noFilesFound') : t('files.noFilesInProject')}
                        </Text>
                    </View>
                ) : (
                    <View style={styles.tree}>
                        {filteredTree.map((node) => (
                            <ProjectTreeNodeRow
                                key={node.path}
                                node={node}
                                depth={0}
                                selectedPath={selectedPath}
                                collapsed={collapsed}
                                onToggleDir={toggleDir}
                                onFilePress={handleFilePress}
                            />
                        ))}
                    </View>
                )}
            </ScrollView>
        </View>
    );
});

/** Tree row for project files (no status badges, clickable) */
const ProjectTreeNodeRow = React.memo(function ProjectTreeNodeRow({
    node, depth, selectedPath, collapsed, onToggleDir, onFilePress,
}: {
    node: AnyTreeNode<ProjectFile>;
    depth: number;
    selectedPath: string | null;
    collapsed: Set<string>;
    onToggleDir: (path: string) => void;
    onFilePress: (file: ProjectFile) => void;
}) {
    const { theme } = useUnistyles();
    const leftPad = 8 + depth * INDENT_PX;

    if (node.kind === 'dir') {
        const isCollapsed = collapsed.has(node.path);
        return (
            <View>
                <Pressable
                    onPress={() => onToggleDir(node.path)}
                    style={({ pressed }) => [styles.row, { paddingLeft: leftPad }, pressed && styles.rowPressed]}
                >
                    <View style={styles.chevron}>
                        <AnimatedChevron collapsed={isCollapsed} color={theme.colors.textSecondary} />
                    </View>
                    <Text style={styles.dirName} numberOfLines={1}>{node.name}</Text>
                </Pressable>
                {!isCollapsed
                    ? node.children.map((child) => (
                        <ProjectTreeNodeRow
                            key={child.path}
                            node={child}
                            depth={depth + 1}
                            selectedPath={selectedPath}
                            collapsed={collapsed}
                            onToggleDir={onToggleDir}
                            onFilePress={onFilePress}
                        />
                    ))
                    : null}
            </View>
        );
    }

    const isSelected = selectedPath === node.path;
    return (
        <Pressable
            onPress={() => onFilePress(node.file)}
            style={({ pressed }) => [
                styles.row,
                { paddingLeft: leftPad },
                pressed && styles.rowPressed,
                isSelected && styles.rowSelected,
            ]}
        >
            <View style={styles.chevronGutter} />
            <FileIcon fileName={node.name} size={16} />
            <Text style={styles.fileName} numberOfLines={1}>
                {node.name}
            </Text>
        </Pressable>
    );
});

interface TreeNodeRowProps {
    node: TreeNode;
    depth: number;
    selectedPath: string | null;
    collapsed: Set<string>;
    onToggleDir: (path: string) => void;
    onFilePress: (file: GitFileStatus) => void;
}

const CHEVRON_DURATION = 160;
const EASING = Easing.out(Easing.cubic);

const TreeNodeRow = React.memo(function TreeNodeRow({ node, depth, selectedPath, collapsed, onToggleDir, onFilePress }: TreeNodeRowProps) {
    const { theme } = useUnistyles();
    const leftPad = 8 + depth * INDENT_PX;

    if (node.kind === 'dir') {
        const isCollapsed = collapsed.has(node.path);
        return (
            <View>
                <Pressable
                    onPress={() => onToggleDir(node.path)}
                    style={({ pressed }) => [styles.row, { paddingLeft: leftPad }, pressed && styles.rowPressed]}
                >
                    <View style={styles.chevron}>
                        <AnimatedChevron collapsed={isCollapsed} color={theme.colors.textSecondary} />
                    </View>
                    <Text style={styles.dirName} numberOfLines={1}>{node.name}</Text>
                </Pressable>
                {!isCollapsed
                    ? node.children.map((child) => (
                        <TreeNodeRow
                            key={child.path}
                            node={child}
                            depth={depth + 1}
                            selectedPath={selectedPath}
                            collapsed={collapsed}
                            onToggleDir={onToggleDir}
                            onFilePress={onFilePress}
                        />
                    ))
                    : null}
            </View>
        );
    }

    const isSelected = selectedPath === node.path;
    const isDeleted = node.file.status === 'deleted';
    return (
        <Pressable
            onPress={() => onFilePress(node.file)}
            disabled={isDeleted}
            style={({ pressed }) => [
                styles.row,
                { paddingLeft: leftPad },
                pressed && !isDeleted && styles.rowPressed,
                isSelected && !isDeleted && styles.rowSelected,
                isDeleted && styles.rowDeleted,
            ]}
        >
            {/* Gutter where chevron sits for dir rows — keeps file names aligned with folder labels. */}
            <View style={styles.chevronGutter} />
            <FileIcon fileName={node.name} size={16} />
            <Text
                style={[styles.fileName, isDeleted && styles.fileNameDeleted]}
                numberOfLines={1}
            >
                {node.name}
            </Text>
        </Pressable>
    );
});

const AnimatedChevron = React.memo(function AnimatedChevron({ collapsed, color, size = 12 }: { collapsed: boolean; color: string; size?: number }) {
    const rotation = useSharedValue(collapsed ? 0 : 90);
    React.useEffect(() => {
        rotation.value = withTiming(collapsed ? 0 : 90, { duration: CHEVRON_DURATION, easing: EASING });
    }, [collapsed, rotation]);
    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${rotation.value}deg` }],
    }));
    return (
        <Animated.View style={animatedStyle}>
            <Octicons name="chevron-right" size={size} color={color} />
        </Animated.View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.divider,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 8,
    },
    headerTitle: {
        flex: 1,
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    headerCountWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 4,
        paddingVertical: 2,
    },
    headerCount: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    headerLineChanges: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    headerAdded: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.gitAddedText,
        ...Typography.mono(),
    },
    headerRemoved: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.gitRemovedText,
        ...Typography.mono(),
    },
    searchWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 12,
        marginBottom: 6,
        paddingHorizontal: 10,
        paddingVertical: Platform.select({ web: 6, default: 8 }),
        borderRadius: 8,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        gap: 6,
    },
    searchIcon: {
        opacity: 0.8,
    },
    searchInput: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
        padding: 0,
        ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : null),
    },
    list: {
        flex: 1,
    },
    listContent: {
        flexGrow: 1,
        paddingBottom: 16,
    },
    tree: {
        paddingHorizontal: 4,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingRight: 12,
        paddingVertical: 5,
        borderRadius: 6,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
        borderWidth: 1,
        borderColor: theme.colors.textLink,
    },
    rowDeleted: {
        opacity: 0.5,
    },
    chevron: {
        width: 14,
        textAlign: 'center',
    },
    chevronGutter: {
        width: 14,
    },
    dirName: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    fileName: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    fileNameDeleted: {
        textDecorationLine: 'line-through',
        color: theme.colors.textSecondary,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        gap: 4,
    },
    emptyIconWrap: {
        width: 64,
        height: 64,
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        marginBottom: 12,
    },
    emptyIcon: {
        color: '#34C759',
    },
    emptyTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    emptySubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    emptySearch: {
        paddingTop: 24,
        alignItems: 'center',
    },
    tabRow: {
        flexDirection: 'row',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    tab: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
    },
    tabText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    tabTextActive: {
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    fileSubpath: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        marginTop: 1,
    },
}));
