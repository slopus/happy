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
import { LinearGradient } from 'expo-linear-gradient';
import { storage, useSessionGitStatus, useSessionGitStatusFiles, useSessionProjectFiles } from '@/sync/storage';
import { getGitStatusFiles, GitFileStatus } from '@/sync/gitStatusFiles';
import { getProjectFiles, ProjectFile } from '@/sync/projectFiles';
import { FileIcon } from '@/components/FileIcon';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { SideChatPanel } from './SideChatPanel';
import type { Session } from '@/sync/storageTypes';
import {
    formatShortcutChord,
    getPreferredShortcutModifier,
    matchesShortcutChord,
    SIDEBAR_PICKER_SHORTCUTS,
    type SidebarPickerShortcutId,
} from '@/keyboard/shortcuts';
import {
    AnimatedClickAwayBackdrop,
    AnimatedPopup,
    LocalBlurHalo,
} from './AnimatedOverlay';
import { MobileGlassSurface } from './MobileGlass';

export type SidebarMode = 'changes' | 'allFiles' | 'sideChat';
type PickableSidebarMode = Exclude<SidebarMode, 'sideChat'>;

const ALL_PANELS: { key: SidebarMode; icon: keyof typeof Octicons.glyphMap }[] = [
    { key: 'changes', icon: 'git-compare' },
    { key: 'allFiles', icon: 'file-directory' },
    { key: 'sideChat', icon: 'comment-discussion' },
];

// Panels that are opened directly from the picker. The 'sideChat' panel is not
// here: it isn't opened empty — it appears when you create a side chat via the
// dedicated "New side chat" picker action, which forks a new child session.
const PICKABLE_PANELS = ALL_PANELS.filter((p) => p.key !== 'sideChat') as Array<{
    key: PickableSidebarMode;
    icon: keyof typeof Octicons.glyphMap;
}>;
const SIDE_CHAT_ICON: keyof typeof Octicons.glyphMap = 'comment-discussion';

function panelIcon(panel: SidebarMode): keyof typeof Octicons.glyphMap {
    return ALL_PANELS.find((p) => p.key === panel)?.icon ?? 'file';
}

function panelLabel(panel: SidebarMode): string {
    switch (panel) {
        case 'changes': return t('files.changes');
        case 'allFiles': return t('files.allFiles');
        case 'sideChat': return t('sideChat.panelTitle');
    }
}

interface FilesSidebarProps {
    sessionId: string;
    selectedPath?: string | null;
    onFilePress?: (file: GitFileStatus) => void;
    openPanels: SidebarMode[];
    activePanel: SidebarMode | null;
    onOpenPanel: (panel: SidebarMode) => void;
    onSelectPanel: (panel: SidebarMode) => void;
    onClosePanel: (panel: SidebarMode) => void;
    onAllFilesFilePress?: (filePath: string) => void;
    // Side chats (rendered inside the 'sideChat' panel). Creation is unified
    // into this sidebar's panel picker, so there is no separate add button.
    sideChats: Session[];
    activeSideChatId: string | null;
    onSelectSideChat: (id: string) => void;
    onCloseSideChat: (id: string) => void;
    onCreateSideChat: () => void;
    canCreateSideChat: boolean;
    creatingSideChat: boolean;
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
const INDENT_PX = 10;

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
    openPanels,
    activePanel,
    onOpenPanel,
    onSelectPanel,
    onClosePanel,
    onAllFilesFilePress,
    sideChats,
    activeSideChatId,
    onSelectSideChat,
    onCloseSideChat,
    onCreateSideChat,
    canCreateSideChat,
    creatingSideChat,
}) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const preferredModifier = React.useMemo(() => getPreferredShortcutModifier(
        typeof navigator === 'undefined' ? undefined : navigator
    ), []);
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

    // Add-panel menu (lists panels not yet open). Open panels live inline as chips.
    const [addMenuOpen, setAddMenuOpen] = React.useState(false);
    React.useEffect(() => {
        setAddMenuOpen(false);
    }, [activePanel, openPanels.length]);

    const availablePanels = React.useMemo(
        () => PICKABLE_PANELS.filter((panel) => !openPanels.includes(panel.key)),
        [openPanels],
    );
    const availablePickerActionIds = React.useMemo<SidebarPickerShortcutId[]>(() => [
        ...availablePanels.map((panel) => panel.key),
        'newSideChat',
    ], [availablePanels]);

    const runPickerAction = React.useCallback((actionId: SidebarPickerShortcutId): boolean => {
        if (actionId === 'newSideChat') {
            if (creatingSideChat || !canCreateSideChat) {
                return false;
            }
            setAddMenuOpen(false);
            onCreateSideChat();
            return true;
        }

        if (!availablePanels.some((panel) => panel.key === actionId)) {
            return false;
        }
        setAddMenuOpen(false);
        onOpenPanel(actionId);
        return true;
    }, [availablePanels, canCreateSideChat, creatingSideChat, onCreateSideChat, onOpenPanel]);

    React.useEffect(() => {
        const shortcutsActive = activePanel === null || addMenuOpen;
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !shortcutsActive) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            const actionId = availablePickerActionIds.find((candidate) => matchesShortcutChord(
                event,
                preferredModifier,
                SIDEBAR_PICKER_SHORTCUTS[candidate],
            ));
            if (!actionId || !runPickerAction(actionId)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
        };

        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [activePanel, addMenuOpen, availablePickerActionIds, preferredModifier, runPickerAction]);

    // Empty sidebar: vertically-centered picker of panels to open (no header).
    if (activePanel === null) {
        return (
            <View style={[styles.container, styles.pickerContainer]}>
                <View style={styles.pickerWrap}>
                    {PICKABLE_PANELS.map((p) => (
                        <Pressable
                            key={p.key}
                            onPress={() => onOpenPanel(p.key)}
                            style={({ pressed, hovered }: any) => [styles.pickerCard, (pressed || hovered) && styles.pickerCardPressed]}
                        >
                            <Octicons name={p.icon} size={15} color={theme.colors.textSecondary} />
                            <Text style={styles.pickerCardText} numberOfLines={1}>{panelLabel(p.key)}</Text>
                            <Text style={styles.pickerShortcut}>
                                {formatShortcutChord(preferredModifier, SIDEBAR_PICKER_SHORTCUTS[p.key])}
                            </Text>
                        </Pressable>
                    ))}
                    <Pressable
                        onPress={onCreateSideChat}
                        disabled={creatingSideChat || !canCreateSideChat}
                        style={({ pressed, hovered }: any) => [
                            styles.pickerCard,
                            (pressed || hovered) && styles.pickerCardPressed,
                            (creatingSideChat || !canCreateSideChat) && { opacity: 0.5 },
                        ]}
                    >
                        {creatingSideChat
                            ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            : <Octicons name={SIDE_CHAT_ICON} size={15} color={theme.colors.textSecondary} />}
                        <Text style={styles.pickerCardText} numberOfLines={1}>{t('sideChat.newChat')}</Text>
                        <Text style={styles.pickerShortcut}>
                            {formatShortcutChord(preferredModifier, SIDEBAR_PICKER_SHORTCUTS.newSideChat)}
                        </Text>
                    </Pressable>
                </View>
            </View>
        );
    }

    const addMenuContent = (
        <>
            {availablePanels.map((p) => (
                <Pressable
                    key={p.key}
                    onPress={() => {
                        setAddMenuOpen(false);
                        onOpenPanel(p.key);
                    }}
                    style={({ pressed, hovered }: any) => [styles.menuAddRow, (pressed || hovered) && { backgroundColor: theme.colors.surfaceSelected }]}
                >
                    <Octicons name={p.icon} size={13} color={theme.colors.textSecondary} />
                    <Text style={styles.menuRowText} numberOfLines={1}>{panelLabel(p.key)}</Text>
                    <Text style={styles.menuShortcut}>
                        {formatShortcutChord(preferredModifier, SIDEBAR_PICKER_SHORTCUTS[p.key])}
                    </Text>
                </Pressable>
            ))}
            <Pressable
                disabled={creatingSideChat || !canCreateSideChat}
                onPress={() => {
                    setAddMenuOpen(false);
                    onCreateSideChat();
                }}
                style={({ pressed, hovered }: any) => [
                    styles.menuAddRow,
                    (pressed || hovered) && { backgroundColor: theme.colors.surfaceSelected },
                    (creatingSideChat || !canCreateSideChat) && { opacity: 0.5 },
                ]}
            >
                {creatingSideChat
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Octicons name={SIDE_CHAT_ICON} size={13} color={theme.colors.textSecondary} />}
                <Text style={styles.menuRowText} numberOfLines={1}>{t('sideChat.newChat')}</Text>
                <Text style={styles.menuShortcut}>
                    {formatShortcutChord(preferredModifier, SIDEBAR_PICKER_SHORTCUTS.newSideChat)}
                </Text>
            </Pressable>
        </>
    );

    return (
        <View style={styles.container}>
            {/* Open panels as chips + add-panel button */}
            <View style={styles.header}>
                <View style={styles.chipRow}>
                    {openPanels.map((key) => (
                        <PanelChip
                            key={key}
                            panel={key}
                            active={key === activePanel}
                            onSelect={() => onSelectPanel(key)}
                            onClose={() => onClosePanel(key)}
                        />
                    ))}
                </View>
                <View style={styles.headerRight}>
                    {activePanel === 'changes' && hasFiles && gitStatus && (gitStatus.linesAdded > 0 || gitStatus.linesRemoved > 0) ? (
                        <View style={styles.headerLineChanges}>
                            {gitStatus.linesAdded > 0 && (
                                <Text style={styles.headerAdded}>+{gitStatus.linesAdded}</Text>
                            )}
                            {gitStatus.linesRemoved > 0 && (
                                <Text style={styles.headerRemoved}>-{gitStatus.linesRemoved}</Text>
                            )}
                        </View>
                    ) : null}
                    <Pressable
                        onPress={() => setAddMenuOpen((v) => !v)}
                        accessibilityLabel={t('files.addPanel')}
                        style={({ pressed, hovered }: any) => [
                            styles.iconButton,
                            (pressed || hovered || addMenuOpen) && { backgroundColor: theme.colors.surface },
                        ]}
                    >
                        <Octicons name="plus" size={14} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            </View>

            {activePanel === 'sideChat' ? (
                <SideChatPanel
                    parentSessionId={sessionId}
                    sideChats={sideChats}
                    activeSideChatId={activeSideChatId}
                    onSelectSideChat={onSelectSideChat}
                    onCloseSideChat={onCloseSideChat}
                    onCreateSideChat={onCreateSideChat}
                    canCreateSideChat={canCreateSideChat}
                    creatingSideChat={creatingSideChat}
                />
            ) : activePanel === 'changes' ? (
                <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
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

            {addMenuOpen && (
                Platform.OS === 'web' ? (
                    <>
                        <Pressable style={styles.menuBackdrop} onPress={() => setAddMenuOpen(false)} />
                        <View style={[styles.menuCard, styles.webMenuCard]}>{addMenuContent}</View>
                    </>
                ) : (
                    <>
                        <AnimatedClickAwayBackdrop
                            onPress={() => setAddMenuOpen(false)}
                            style={styles.menuBackdrop}
                        />
                        <AnimatedPopup style={styles.menuCard}>
                            <LocalBlurHalo borderRadius={14} expansion={12} />
                            <MobileGlassSurface
                                enabled
                                nativeEffect
                                intensity={82}
                                glassEffectStyle="regular"
                                tintColor={theme.colors.glass.overlayTint}
                                style={styles.menuSurface}
                            >
                                {addMenuContent}
                            </MobileGlassSurface>
                        </AnimatedPopup>
                    </>
                )
            )}
        </View>
    );
});

/** A single open-panel chip: click body to activate, hover to reveal close (x). */
const PanelChip = React.memo(function PanelChip({
    panel,
    active,
    onSelect,
    onClose,
}: {
    panel: SidebarMode;
    active: boolean;
    onSelect: () => void;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const iconColor = active ? theme.colors.text : theme.colors.textSecondary;
    // Fade colour matches the chip background so the close (x) reads as an
    // overlay at the chip's end instead of resizing it.
    const fadeColor = theme.colors.surface;
    return (
        <Pressable
            onPress={onSelect}
            // Pointer enter/leave (not hover in/out): leave only fires when the
            // cursor exits the chip *and its descendants*, so moving onto the
            // nested close (x) doesn't unmount the overlay. onHoverOut would
            // fire on child entry and make the x flicker away.
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            style={[
                styles.chip,
                active && styles.chipActive,
                hovered && !active && styles.chipHovered,
            ]}
        >
            <Octicons name={panelIcon(panel)} size={13} color={iconColor} />
            <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                {panelLabel(panel)}
            </Text>
            {hovered && (
                <View style={styles.chipCloseOverlay} pointerEvents="box-none">
                    <LinearGradient
                        colors={['transparent', fadeColor, fadeColor]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.chipCloseFade}
                        pointerEvents="none"
                    />
                    <Pressable
                        onPress={(e) => {
                            e.stopPropagation?.();
                            onClose();
                        }}
                        accessibilityLabel={t('files.closePanel')}
                        hitSlop={6}
                        style={styles.chipClose}
                    >
                        <Octicons name="x" size={12} color={theme.colors.text} />
                    </Pressable>
                </View>
            )}
        </Pressable>
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
    const gitStatus = useSessionGitStatus(sessionId);
    const allFiles = projectFiles?.files ?? [];

    // Fetch project files into Zustand on mount
    React.useEffect(() => {
        let cancelled = false;
        const pathKey = storage.getState().getSessionPathKey(sessionId);
        if (!pathKey) return;

        const existing = storage.getState().pathProjectFiles[pathKey];
        setIsLoading(!existing || existing.files.length === 0);
        (async () => {
            const result = await getProjectFiles(sessionId);
            if (!cancelled) {
                storage.getState().applyProjectFiles(pathKey, result);
                setIsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId, gitStatus?.lastUpdatedAt]);

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

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
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
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 8,
        gap: 8,
        zIndex: 2,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    chipRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 7,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'transparent',
        flexShrink: 1,
        overflow: 'hidden',
    },
    chipHovered: {
        backgroundColor: theme.colors.surface,
    },
    chipActive: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
    },
    chipText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    chipTextActive: {
        color: theme.colors.text,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    chipCloseOverlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    chipCloseFade: {
        width: 18,
    },
    chipClose: {
        paddingRight: 8,
        paddingLeft: 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
    },
    iconButton: {
        width: 26,
        height: 26,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pickerContainer: {
        justifyContent: 'center',
    },
    pickerWrap: {
        paddingHorizontal: 12,
        gap: 8,
    },
    pickerCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    pickerCardPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    pickerCardText: {
        flex: 1,
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    pickerShortcut: {
        flexShrink: 0,
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    menuBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 3,
    },
    menuCard: {
        position: 'absolute',
        top: 42,
        right: 12,
        minWidth: 220,
        maxWidth: '90%',
        zIndex: 4,
    },
    menuSurface: {
        padding: 4,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
    },
    webMenuCard: {
        padding: 4,
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
    },
    menuRowText: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    menuShortcut: {
        flexShrink: 0,
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    menuAddRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 7,
        borderRadius: 6,
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
    },
    rowDeleted: {
        opacity: 0.5,
    },
    chevron: {
        width: 14,
        textAlign: 'center',
    },
    dirName: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
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
    fileSubpath: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        marginTop: 1,
    },
}));
