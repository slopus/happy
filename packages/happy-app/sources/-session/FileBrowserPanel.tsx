import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TextInput, Pressable, FlatList, ScrollView, ActivityIndicator, Dimensions, Platform } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS, Easing } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { sessionListDirectory, sessionReadFile, sessionWriteFile, sessionReadClaudeMdChain } from '@/sync/ops';
import type { DirectoryEntry, ClaudeMdChainResponse } from '@/sync/ops';
import { FilePreview, isBinaryFileType } from './FilePreview';
import { MarkdownView } from '@/components/markdown/MarkdownView';

function formatFileSize(bytes?: number): string {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type PanelTab = 'files' | 'prompts';

interface FileBrowserPanelProps {
    visible: boolean;
    onClose: () => void;
    sessionId: string;
    workingDirectory: string;
    mode?: 'overlay' | 'split';
    onInsertText?: (text: string) => void;
}

const PANEL_WIDTH_PHONE = 1.0;
const PANEL_WIDTH_TABLET = 0.4;
const MAX_PANEL_WIDTH = 500;
const ANIMATION_DURATION = 250;

// --- Prompts View (CLAUDE.md chain) ---

// Make directory display relative/nice
const formatDirectory = (dir: string) => {
    if (dir.startsWith('~')) return dir;
    const home = '/root';
    if (dir.startsWith(home)) return '~' + dir.slice(home.length);
    return dir;
};

// Single prompt card with its own edit state
const PromptCard = React.memo(({ file, sessionId, isExpanded, onToggle, onInsertText, panelVisible }: {
    file: { path: string; content: string; directory: string };
    sessionId: string;
    isExpanded: boolean;
    onToggle: () => void;
    onInsertText?: (text: string) => void;
    panelVisible: boolean;
}) => {
    const { theme } = useUnistyles();
    const [editing, setEditing] = useState(false);
    const [editText, setEditText] = useState('');
    const [saving, setSaving] = useState(false);
    const inputHeightRef = useRef(0);

    // Cancel editing when panel closes
    useEffect(() => {
        if (!panelVisible && editing) {
            setEditing(false);
            setEditText('');
        }
    }, [panelVisible, editing]);

    const startEditing = useCallback(() => {
        setEditText(file.content || '');
        inputHeightRef.current = 0;
        setEditing(true);
    }, [file.content]);

    const cancelEditing = useCallback(() => {
        setEditing(false);
        setEditText('');
    }, []);

    const saveEdit = useCallback(async () => {
        setSaving(true);
        try {
            const encoded = btoa(unescape(encodeURIComponent(editText)));
            const result = await sessionWriteFile(sessionId, file.path, encoded);
            if (result.success) {
                file.content = editText;
                setEditing(false);
            }
        } catch { /* ignore */ } finally {
            setSaving(false);
        }
    }, [editText, sessionId, file]);

    return (
        <View style={{
            backgroundColor: theme.colors.surfaceHighest,
            borderRadius: 10,
            overflow: 'hidden',
        }}>
            {/* Card header */}
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingLeft: 12,
                paddingRight: 4,
                paddingVertical: 2,
                gap: 4,
            }}>
                <Pressable
                    onPress={onToggle}
                    style={({ pressed }) => ({
                        flex: 1,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        paddingVertical: 8,
                        opacity: pressed ? 0.6 : 1,
                    })}
                >
                    <Ionicons
                        name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                        size={14}
                        color={theme.colors.textSecondary}
                    />
                    <Ionicons name="document-text" size={16} color={theme.colors.textSecondary} />
                    <Text
                        numberOfLines={1}
                        style={{
                            flex: 1,
                            fontSize: 13,
                            color: theme.colors.text,
                            ...Typography.default('semiBold'),
                        }}
                    >
                        {formatDirectory(file.directory)}
                    </Text>
                </Pressable>
                {isExpanded && !editing && (
                    <Pressable
                        onPress={startEditing}
                        hitSlop={6}
                        style={({ pressed }) => ({
                            width: 34, height: 34,
                            alignItems: 'center', justifyContent: 'center',
                            borderRadius: 8,
                            backgroundColor: pressed ? theme.colors.background : 'transparent',
                            opacity: pressed ? 0.5 : 1,
                        })}
                    >
                        <Ionicons name="create-outline" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
                {onInsertText && file.content && !editing && (
                    <Pressable
                        onPress={() => onInsertText(file.content)}
                        hitSlop={6}
                        style={({ pressed }) => ({
                            width: 34, height: 34,
                            alignItems: 'center', justifyContent: 'center',
                            borderRadius: 8,
                            backgroundColor: pressed ? theme.colors.background : 'transparent',
                            opacity: pressed ? 0.5 : 1,
                        })}
                    >
                        <Ionicons name="arrow-redo-outline" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
            </View>

            {/* Card body */}
            {isExpanded && (
                <View style={{
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.divider,
                }}>
                    {editing ? (
                        <View>
                            <TextInput
                                value={editText}
                                onChangeText={setEditText}
                                multiline
                                autoFocus
                                scrollEnabled={false}
                                style={{
                                    fontSize: 13,
                                    lineHeight: 20,
                                    color: theme.colors.text,
                                    padding: 12,
                                    textAlignVertical: 'top',
                                    minHeight: Math.max(100, (editText.split('\n').length + 1) * 20 + 24),
                                    ...Typography.mono(),
                                }}
                                placeholderTextColor={theme.colors.textSecondary}
                            />
                            <View style={{
                                flexDirection: 'row',
                                justifyContent: 'flex-end',
                                gap: 8,
                                paddingHorizontal: 12,
                                paddingBottom: 10,
                            }}>
                                <Pressable
                                    onPress={cancelEditing}
                                    style={({ pressed }) => ({
                                        paddingHorizontal: 14, paddingVertical: 7,
                                        borderRadius: 8,
                                        backgroundColor: theme.colors.background,
                                        opacity: pressed ? 0.6 : 1,
                                    })}
                                >
                                    <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Cancel</Text>
                                </Pressable>
                                <Pressable
                                    onPress={saveEdit}
                                    disabled={saving}
                                    style={({ pressed }) => ({
                                        paddingHorizontal: 14, paddingVertical: 7,
                                        borderRadius: 8,
                                        backgroundColor: pressed ? theme.colors.primary + 'cc' : theme.colors.primary,
                                        opacity: saving ? 0.5 : (pressed ? 0.8 : 1),
                                    })}
                                >
                                    {saving ? (
                                        <ActivityIndicator size="small" color="#fff" />
                                    ) : (
                                        <Text style={{ fontSize: 13, color: '#fff', ...Typography.default('semiBold') }}>Save</Text>
                                    )}
                                </Pressable>
                            </View>
                        </View>
                    ) : (
                        <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                            {file.content ? (
                                <MarkdownView markdown={file.content} />
                            ) : (
                                <Text style={{
                                    fontSize: 13,
                                    color: theme.colors.textSecondary,
                                    fontStyle: 'italic',
                                }}>
                                    Empty
                                </Text>
                            )}
                        </View>
                    )}
                </View>
            )}
        </View>
    );
});

const PromptsView = React.memo(({ sessionId, workingDirectory, bottomInset, onInsertText, panelVisible }: {
    sessionId: string;
    workingDirectory: string;
    bottomInset: number;
    onInsertText?: (text: string) => void;
    panelVisible: boolean;
}) => {
    const { theme } = useUnistyles();
    const [chain, setChain] = useState<ClaudeMdChainResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

    const loadChain = useCallback(async () => {
        if (!workingDirectory || !sessionId) {
            setChain({ success: false, files: [], error: 'No working directory' });
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const result = await sessionReadClaudeMdChain(sessionId, workingDirectory);
            setChain(result);
            if (result.success && result.files.length > 0) {
                setExpandedPaths(new Set(result.files.map(f => f.path)));
            }
        } catch {
            setChain({ success: false, files: [], error: 'Failed to load' });
        } finally {
            setLoading(false);
        }
    }, [sessionId, workingDirectory]);

    useEffect(() => {
        loadChain();
    }, [loadChain]);

    const toggleExpanded = useCallback((path: string) => {
        setExpandedPaths(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    if (loading) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (!chain?.success || chain.error) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                <Ionicons name="warning-outline" size={32} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginTop: 8, textAlign: 'center' }}>
                    {chain?.error || 'Failed to load prompts'}
                </Text>
                <Pressable onPress={loadChain} style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: theme.colors.background, borderRadius: 8 }}>
                    <Text style={{ fontSize: 14, color: theme.colors.text }}>Retry</Text>
                </Pressable>
            </View>
        );
    }

    if (chain.files.length === 0) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                <Ionicons name="document-text-outline" size={40} color={theme.colors.textSecondary} style={{ opacity: 0.5 }} />
                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginTop: 8 }}>
                    No CLAUDE.md files found
                </Text>
            </View>
        );
    }

    return (
        <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 12, paddingBottom: bottomInset + 20, gap: 10 }}
        >
            {chain.files.map((file) => (
                <PromptCard
                    key={file.path}
                    file={file}
                    sessionId={sessionId}
                    isExpanded={expandedPaths.has(file.path)}
                    onToggle={() => toggleExpanded(file.path)}
                    onInsertText={onInsertText}
                    panelVisible={panelVisible}
                />
            ))}
        </ScrollView>
    );
});

// --- Main Panel ---
export const FileBrowserPanel: React.FC<FileBrowserPanelProps> = ({
    visible,
    onClose,
    sessionId,
    workingDirectory,
    mode = 'overlay',
    onInsertText,
}) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { width: windowWidth } = Dimensions.get('window');
    const isTablet = windowWidth >= 768;

    const panelWidth = Math.min(
        windowWidth * (isTablet ? PANEL_WIDTH_TABLET : PANEL_WIDTH_PHONE),
        MAX_PANEL_WIDTH
    );

    // State
    const [activeTab, setActiveTab] = useState<PanelTab>('files');
    const [currentPath, setCurrentPath] = useState(workingDirectory || '/');
    const [entries, setEntries] = useState<DirectoryEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [previewFile, setPreviewFile] = useState<{ path: string; name: string; content: string; base64Content?: string } | null>(null);
    const [fileLoading, setFileLoading] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const pathHistory = useRef<string[]>([]);

    // Animation (only for overlay mode)
    const translateX = useSharedValue(panelWidth);
    const backdropOpacity = useSharedValue(0);

    const animatedPanelStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: translateX.value }],
    }));

    const animatedBackdropStyle = useAnimatedStyle(() => ({
        opacity: backdropOpacity.value,
        pointerEvents: backdropOpacity.value > 0 ? 'auto' as const : 'none' as const,
    }));

    useEffect(() => {
        if (mode === 'split') return;
        if (visible) {
            translateX.value = withTiming(0, { duration: ANIMATION_DURATION, easing: Easing.out(Easing.cubic) });
            backdropOpacity.value = withTiming(1, { duration: ANIMATION_DURATION });
        } else {
            translateX.value = withTiming(panelWidth, { duration: 200, easing: Easing.in(Easing.cubic) });
            backdropOpacity.value = withTiming(0, { duration: 200 });
        }
    }, [visible, panelWidth, mode]);

    // Load directory
    const loadDirectory = useCallback(async (path: string) => {
        setLoading(true);
        setError(null);
        try {
            const result = await sessionListDirectory(sessionId, path);
            if (result.success && result.entries) {
                const sorted = [...result.entries].sort((a, b) => {
                    if (a.type === 'directory' && b.type !== 'directory') return -1;
                    if (a.type !== 'directory' && b.type === 'directory') return 1;
                    return a.name.localeCompare(b.name);
                });
                setEntries(sorted);
            } else {
                setError(result.error || 'Failed to load directory');
                setEntries([]);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error');
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, [sessionId]);

    useEffect(() => {
        if (visible && currentPath && activeTab === 'files') {
            loadDirectory(currentPath);
        }
    }, [visible, currentPath, loadDirectory, activeTab]);

    useEffect(() => {
        setCurrentPath(workingDirectory || '/');
        pathHistory.current = [];
    }, [workingDirectory]);

    const navigateToDir = useCallback((dirName: string) => {
        pathHistory.current.push(currentPath);
        const newPath = currentPath.endsWith('/')
            ? `${currentPath}${dirName}`
            : `${currentPath}/${dirName}`;
        setCurrentPath(newPath);
    }, [currentPath]);

    const navigateBack = useCallback(() => {
        if (pathHistory.current.length > 0) {
            const prev = pathHistory.current.pop()!;
            setCurrentPath(prev);
        } else {
            const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
            if (parent !== currentPath) {
                setCurrentPath(parent);
            }
        }
    }, [currentPath]);

    const navigateToBreadcrumb = useCallback((targetPath: string) => {
        if (targetPath !== currentPath) {
            pathHistory.current.push(currentPath);
            setCurrentPath(targetPath);
        }
    }, [currentPath]);

    const openFile = useCallback(async (entry: DirectoryEntry) => {
        if (entry.type === 'directory') {
            navigateToDir(entry.name);
            return;
        }

        const isBinary = isBinaryFileType(entry.name);
        const sizeLimit = isBinary ? 10 * 1024 * 1024 : 2 * 1024 * 1024;
        if (entry.size && entry.size > sizeLimit) {
            setError(`File too large to preview (>${isBinary ? '10' : '2'}MB)`);
            return;
        }

        setFileLoading(true);
        try {
            const filePath = currentPath.endsWith('/')
                ? `${currentPath}${entry.name}`
                : `${currentPath}/${entry.name}`;
            const result = await sessionReadFile(sessionId, filePath);
            if (result.success && result.content) {
                if (isBinary) {
                    setPreviewFile({ path: filePath, name: entry.name, content: '', base64Content: result.content });
                } else {
                    let decoded: string;
                    try {
                        decoded = atob(result.content);
                        const bytes = new Uint8Array(decoded.length);
                        for (let i = 0; i < decoded.length; i++) {
                            bytes[i] = decoded.charCodeAt(i);
                        }
                        decoded = new TextDecoder('utf-8').decode(bytes);
                    } catch {
                        decoded = atob(result.content);
                    }
                    setPreviewFile({ path: filePath, name: entry.name, content: decoded });
                }
            } else {
                setError(result.error || 'Failed to read file');
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setFileLoading(false);
        }
    }, [sessionId, currentPath, navigateToDir]);

    const panGesture = Gesture.Pan()
        .activeOffsetX(20)
        .onEnd((event) => {
            if (event.translationX > 80) {
                runOnJS(onClose)();
            }
        });

    const visibleEntries = showHidden ? entries : entries.filter(e => !e.name.startsWith('.'));
    const pathSegments = currentPath.split('/').filter(Boolean);

    // --- Tab switcher ---
    const tabSwitcher = (
        <View style={{
            flexDirection: 'row',
            marginTop: 8,
            gap: 0,
            backgroundColor: theme.colors.background,
            borderRadius: 8,
            padding: 2,
        }}>
            {([
                { key: 'files' as PanelTab, label: 'Files', icon: 'folder-outline' as const },
                { key: 'prompts' as PanelTab, label: 'Prompts', icon: 'document-text-outline' as const },
            ]).map(tab => {
                const isActive = activeTab === tab.key;
                return (
                    <Pressable
                        key={tab.key}
                        onPress={() => setActiveTab(tab.key)}
                        style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 5,
                            paddingVertical: 6,
                            borderRadius: 6,
                            backgroundColor: isActive ? theme.colors.surfaceHighest : 'transparent',
                        }}
                    >
                        <Ionicons
                            name={tab.icon}
                            size={14}
                            color={isActive ? theme.colors.text : theme.colors.textSecondary}
                        />
                        <Text style={{
                            fontSize: 13,
                            color: isActive ? theme.colors.text : theme.colors.textSecondary,
                            ...Typography.default(isActive ? 'semiBold' : undefined),
                        }}>
                            {tab.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );

    // --- Header ---
    const headerContent = (
        <View style={{
            paddingTop: mode === 'split' ? 12 : insets.top + 8,
            paddingHorizontal: 16,
            paddingBottom: 8,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.divider,
        }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{
                    fontSize: 17,
                    color: theme.colors.text,
                    ...Typography.default('semiBold'),
                }}>
                    {activeTab === 'files' ? 'Files' : 'Prompts'}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {activeTab === 'files' && (
                        <>
                            <Pressable
                                onPress={() => setShowHidden(!showHidden)}
                                hitSlop={10}
                                style={{
                                    width: 32, height: 32,
                                    alignItems: 'center', justifyContent: 'center',
                                    opacity: showHidden ? 1 : 0.4,
                                }}
                            >
                                <Ionicons name="eye-outline" size={18} color={theme.colors.text} />
                            </Pressable>
                            <Pressable
                                onPress={() => loadDirectory(currentPath)}
                                hitSlop={10}
                                style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                            >
                                <Ionicons name="refresh-outline" size={18} color={theme.colors.text} />
                            </Pressable>
                        </>
                    )}
                    <Pressable
                        onPress={onClose}
                        hitSlop={10}
                        style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <Ionicons name="close" size={20} color={theme.colors.text} />
                    </Pressable>
                </View>
            </View>

            {/* Tab switcher */}
            {tabSwitcher}

            {/* Breadcrumb (only in files mode) */}
            {activeTab === 'files' && (
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: 8,
                }}>
                    {currentPath !== workingDirectory && (
                        <Pressable
                            onPress={navigateBack}
                            hitSlop={8}
                            style={{ marginRight: 6 }}
                        >
                            <Ionicons name="arrow-back" size={16} color={theme.colors.textSecondary} />
                        </Pressable>
                    )}
                    <FlatList
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        data={pathSegments}
                        keyExtractor={(_, i) => String(i)}
                        renderItem={({ item, index }) => {
                            const targetPath = '/' + pathSegments.slice(0, index + 1).join('/');
                            const isLast = index === pathSegments.length - 1;
                            return (
                                <Pressable
                                    onPress={() => navigateToBreadcrumb(targetPath)}
                                    style={{ flexDirection: 'row', alignItems: 'center' }}
                                >
                                    <Text style={{
                                        fontSize: 12,
                                        color: isLast ? theme.colors.text : theme.colors.textSecondary,
                                        ...Typography.default(isLast ? 'semiBold' : undefined),
                                    }}>
                                        {item}
                                    </Text>
                                    {!isLast && (
                                        <Text style={{
                                            fontSize: 12,
                                            color: theme.colors.textSecondary,
                                            marginHorizontal: 4,
                                        }}>/</Text>
                                    )}
                                </Pressable>
                            );
                        }}
                    />
                </View>
            )}
        </View>
    );

    // --- Files body ---
    const filesBody = loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        </View>
    ) : error ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <Ionicons name="warning-outline" size={32} color={theme.colors.textSecondary} />
            <Text style={{
                fontSize: 14,
                color: theme.colors.textSecondary,
                marginTop: 8,
                textAlign: 'center',
            }}>{error}</Text>
            <Pressable
                onPress={() => { setError(null); loadDirectory(currentPath); }}
                style={{
                    marginTop: 12,
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    backgroundColor: theme.colors.background,
                    borderRadius: 8,
                }}
            >
                <Text style={{ fontSize: 14, color: theme.colors.text }}>Retry</Text>
            </Pressable>
        </View>
    ) : (
        <FlatList
            data={visibleEntries}
            keyExtractor={(item) => item.name}
            contentContainerStyle={{ paddingBottom: mode === 'split' ? 20 : insets.bottom + 20 }}
            renderItem={({ item }) => (
                <Pressable
                    onPress={() => openFile(item)}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                        backgroundColor: pressed ? theme.colors.background : 'transparent',
                    })}
                >
                    {item.type === 'directory' ? (
                        <Ionicons name="folder" size={22} color={theme.colors.textSecondary} style={{ width: 26 }} />
                    ) : (
                        <View style={{ width: 26, alignItems: 'center' }}>
                            <FileIcon fileName={item.name} size={20} />
                        </View>
                    )}
                    <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text
                            numberOfLines={1}
                            style={{
                                fontSize: 14,
                                color: item.name.startsWith('.') ? theme.colors.textSecondary : theme.colors.text,
                                ...Typography.default(item.type === 'directory' ? 'semiBold' : undefined),
                            }}
                        >
                            {item.name}
                        </Text>
                    </View>
                    {item.type === 'file' && item.size !== undefined && (
                        <Text style={{
                            fontSize: 11,
                            color: theme.colors.textSecondary,
                            marginLeft: 8,
                        }}>
                            {formatFileSize(item.size)}
                        </Text>
                    )}
                    {item.type === 'directory' && (
                        <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                    )}
                </Pressable>
            )}
            ListEmptyComponent={() => (
                <View style={{ alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                    <Ionicons name="folder-open-outline" size={40} color={theme.colors.textSecondary} style={{ opacity: 0.5 }} />
                    <Text style={{
                        fontSize: 14,
                        color: theme.colors.textSecondary,
                        marginTop: 8,
                    }}>Empty directory</Text>
                </View>
            )}
        />
    );

    const bodyContent = activeTab === 'files' ? filesBody : (
        <PromptsView
            sessionId={sessionId}
            workingDirectory={workingDirectory}
            bottomInset={mode === 'split' ? 0 : insets.bottom}
            onInsertText={onInsertText}
            panelVisible={visible}
        />
    );

    const loadingOverlay = fileLoading && (
        <View style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.3)',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
        }}>
            <ActivityIndicator size="large" color="#fff" />
        </View>
    );

    const previewModal = previewFile && (
        <FilePreview
            fileName={previewFile.name}
            filePath={previewFile.path}
            content={previewFile.content}
            base64Content={previewFile.base64Content}
            onClose={() => setPreviewFile(null)}
        />
    );

    // --- Split mode: simple inline panel ---
    if (mode === 'split') {
        if (!visible) return null;
        return (
            <View style={{
                flex: 1,
                backgroundColor: theme.colors.surface,
            }}>
                {headerContent}
                {bodyContent}
                {loadingOverlay}
                {previewModal}
            </View>
        );
    }

    // --- Overlay mode: animated slide-in ---
    if (!visible && translateX.value >= panelWidth) return null;

    return (
        <>
            {/* Backdrop */}
            <Animated.View
                style={[
                    {
                        position: 'absolute',
                        top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.4)',
                        zIndex: 2000,
                    },
                    animatedBackdropStyle,
                ]}
            >
                <Pressable style={{ flex: 1 }} onPress={onClose} />
            </Animated.View>

            {/* Panel */}
            <GestureDetector gesture={panGesture}>
                <Animated.View
                    style={[
                        {
                            position: 'absolute',
                            top: 0, right: 0, bottom: 0,
                            width: panelWidth,
                            backgroundColor: theme.colors.surface,
                            zIndex: 2001,
                            borderLeftWidth: 1,
                            borderLeftColor: theme.colors.divider,
                            shadowColor: '#000',
                            shadowOffset: { width: -2, height: 0 },
                            shadowOpacity: 0.15,
                            shadowRadius: 10,
                            elevation: 20,
                        },
                        animatedPanelStyle,
                    ]}
                >
                    {headerContent}
                    {bodyContent}
                    {loadingOverlay}
                </Animated.View>
            </GestureDetector>

            {previewModal}
        </>
    );
};
