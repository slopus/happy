import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Pressable, FlatList, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineListDirectory, machineReadFile } from '@/sync/ops';
import type { DirectoryEntry } from '@/sync/ops';
import { FilePreview, isBinaryFileType, isImageFile } from '@/-session/FilePreview';

function formatFileSize(bytes?: number): string {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const FilesTabView = React.memo(() => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const allMachines = useAllMachines();
    const onlineMachines = allMachines.filter(isMachineOnline);

    // State
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
    const [currentPath, setCurrentPath] = useState('/');
    const [entries, setEntries] = useState<DirectoryEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [previewFile, setPreviewFile] = useState<{ path: string; name: string; content: string; base64Content?: string } | null>(null);
    const [fileLoading, setFileLoading] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const pathHistory = useRef<string[]>([]);

    // Auto-select first online machine
    useEffect(() => {
        if (!selectedMachineId && onlineMachines.length > 0) {
            setSelectedMachineId(onlineMachines[0].id);
        }
    }, [onlineMachines, selectedMachineId]);

    // Load directory
    const loadDirectory = useCallback(async (path: string) => {
        if (!selectedMachineId) return;
        setLoading(true);
        setError(null);
        try {
            const result = await machineListDirectory(selectedMachineId, path);
            if (result.success && result.entries) {
                setEntries(result.entries);
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
    }, [selectedMachineId]);

    // Load when path or machine changes
    useEffect(() => {
        if (selectedMachineId && currentPath) {
            loadDirectory(currentPath);
        }
    }, [selectedMachineId, currentPath, loadDirectory]);

    // Navigate to directory
    const navigateToDir = useCallback((dirName: string) => {
        pathHistory.current.push(currentPath);
        const newPath = currentPath === '/' ? `/${dirName}` : `${currentPath}/${dirName}`;
        setCurrentPath(newPath);
    }, [currentPath]);

    // Go back
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

    // Navigate to breadcrumb
    const navigateToBreadcrumb = useCallback((targetPath: string) => {
        if (targetPath !== currentPath) {
            pathHistory.current.push(currentPath);
            setCurrentPath(targetPath);
        }
    }, [currentPath]);

    // Open file
    const openFile = useCallback(async (entry: DirectoryEntry) => {
        if (entry.type === 'directory') {
            navigateToDir(entry.name);
            return;
        }
        if (!selectedMachineId) return;
        const isBinary = isBinaryFileType(entry.name);
        const sizeLimit = isBinary ? 10 * 1024 * 1024 : 2 * 1024 * 1024;
        if (entry.size && entry.size > sizeLimit) {
            setError(`File too large to preview (>${isBinary ? '10' : '2'}MB)`);
            return;
        }
        setFileLoading(true);
        try {
            const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
            const result = await machineReadFile(selectedMachineId, filePath);
            if (result.success && result.content) {
                if (isBinary) {
                    // Keep raw base64 for binary files
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
    }, [selectedMachineId, currentPath, navigateToDir]);

    // Gallery navigation for images
    const imageFiles = React.useMemo(() => {
        const visible = showHidden ? entries : entries.filter(e => !e.name.startsWith('.'));
        return visible.filter(e => e.type === 'file' && isImageFile(e.name));
    }, [entries, showHidden]);

    const currentImageIndex = React.useMemo(() => {
        if (!previewFile) return -1;
        return imageFiles.findIndex(e => e.name === previewFile.name);
    }, [imageFiles, previewFile]);

    const handleGalleryNavigate = useCallback(async (direction: 'prev' | 'next') => {
        if (currentImageIndex < 0 || !selectedMachineId) return;
        const newIndex = direction === 'prev'
            ? (currentImageIndex - 1 + imageFiles.length) % imageFiles.length
            : (currentImageIndex + 1) % imageFiles.length;
        const entry = imageFiles[newIndex];
        const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
        try {
            const result = await machineReadFile(selectedMachineId, filePath);
            if (result.success && result.content) {
                setPreviewFile({ path: filePath, name: entry.name, content: '', base64Content: result.content });
            }
        } catch { /* ignore */ }
    }, [currentImageIndex, imageFiles, selectedMachineId, currentPath]);

    const galleryPosition = currentImageIndex >= 0
        ? `${currentImageIndex + 1} / ${imageFiles.length}`
        : undefined;

    // Go home
    const goHome = useCallback(() => {
        pathHistory.current = [];
        setCurrentPath('/');
    }, []);

    // Filter
    const visibleEntries = showHidden ? entries : entries.filter(e => !e.name.startsWith('.'));

    // Breadcrumb segments
    const pathSegments = currentPath.split('/').filter(Boolean);

    // Get machine display name
    const selectedMachine = allMachines.find(m => m.id === selectedMachineId);
    const machineName = selectedMachine?.metadata?.displayName || selectedMachineId || 'Unknown';

    // No machines online
    if (onlineMachines.length === 0) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, backgroundColor: theme.colors.groupped.background }}>
                <Ionicons name="cloud-offline-outline" size={48} color={theme.colors.textSecondary} style={{ opacity: 0.5 }} />
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, marginTop: 12, textAlign: 'center' }}>
                    No machines online
                </Text>
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary, marginTop: 4, textAlign: 'center', opacity: 0.7 }}>
                    Start a daemon to browse files
                </Text>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            {/* Machine selector + path bar */}
            <View style={{
                paddingHorizontal: 16,
                paddingTop: 8,
                paddingBottom: 8,
                backgroundColor: theme.colors.surface,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.divider,
            }}>
                {/* Machine selector (if multiple) */}
                {onlineMachines.length > 1 && (
                    <FlatList
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        data={onlineMachines}
                        keyExtractor={(m) => m.id}
                        style={{ marginBottom: 8 }}
                        renderItem={({ item }) => {
                            const isSelected = item.id === selectedMachineId;
                            const name = item.metadata?.displayName || item.id;
                            return (
                                <Pressable
                                    onPress={() => {
                                        setSelectedMachineId(item.id);
                                        setCurrentPath('/');
                                        pathHistory.current = [];
                                    }}
                                    style={{
                                        paddingHorizontal: 12,
                                        paddingVertical: 6,
                                        borderRadius: 16,
                                        backgroundColor: isSelected ? theme.colors.text : 'transparent',
                                        marginRight: 8,
                                        borderWidth: isSelected ? 0 : 1,
                                        borderColor: theme.colors.divider,
                                    }}
                                >
                                    <Text style={{
                                        fontSize: 13,
                                        color: isSelected ? theme.colors.surface : theme.colors.text,
                                        ...Typography.default(isSelected ? 'semiBold' : undefined),
                                    }}>{name}</Text>
                                </Pressable>
                            );
                        }}
                    />
                )}

                {/* Path bar with actions */}
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {currentPath !== '/' && (
                        <Pressable onPress={navigateBack} hitSlop={8} style={{ marginRight: 8 }}>
                            <Ionicons name="arrow-back" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                    )}
                    <Pressable onPress={goHome} hitSlop={8} style={{ marginRight: 8 }}>
                        <Ionicons name="home-outline" size={16} color={theme.colors.textSecondary} />
                    </Pressable>

                    {/* Breadcrumb */}
                    <FlatList
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        data={pathSegments}
                        keyExtractor={(_, i) => String(i)}
                        style={{ flex: 1 }}
                        renderItem={({ item, index }) => {
                            const targetPath = '/' + pathSegments.slice(0, index + 1).join('/');
                            const isLast = index === pathSegments.length - 1;
                            return (
                                <Pressable
                                    onPress={() => navigateToBreadcrumb(targetPath)}
                                    style={{ flexDirection: 'row', alignItems: 'center' }}
                                >
                                    <Text style={{
                                        fontSize: 13,
                                        color: isLast ? theme.colors.text : theme.colors.textSecondary,
                                        ...Typography.default(isLast ? 'semiBold' : undefined),
                                    }}>{item}</Text>
                                    {!isLast && (
                                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, marginHorizontal: 4 }}>/</Text>
                                    )}
                                </Pressable>
                            );
                        }}
                        ListEmptyComponent={() => (
                            <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>/</Text>
                        )}
                    />

                    <Pressable
                        onPress={() => setShowHidden(!showHidden)}
                        hitSlop={8}
                        style={{ marginLeft: 8, opacity: showHidden ? 1 : 0.4 }}
                    >
                        <Ionicons name="eye-outline" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                    <Pressable
                        onPress={() => loadDirectory(currentPath)}
                        hitSlop={8}
                        style={{ marginLeft: 8 }}
                    >
                        <Ionicons name="refresh-outline" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            </View>

            {/* Content */}
            {loading ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : error ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                    <Ionicons name="warning-outline" size={32} color={theme.colors.textSecondary} />
                    <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginTop: 8, textAlign: 'center' }}>
                        {error}
                    </Text>
                    <Pressable
                        onPress={() => { setError(null); loadDirectory(currentPath); }}
                        style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: theme.colors.surface, borderRadius: 8 }}
                    >
                        <Text style={{ fontSize: 14, color: theme.colors.text }}>Retry</Text>
                    </Pressable>
                </View>
            ) : (
                <FlatList
                    data={visibleEntries}
                    keyExtractor={(item) => item.name}
                    contentContainerStyle={{ paddingBottom: 40 }}
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
                                >{item.name}</Text>
                            </View>
                            {item.type === 'file' && item.size !== undefined && (
                                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginLeft: 8 }}>
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
                            <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginTop: 8 }}>
                                Empty directory
                            </Text>
                        </View>
                    )}
                />
            )}

            {/* File loading overlay */}
            {fileLoading && (
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
            )}

            {/* File Preview */}
            {previewFile && (
                <FilePreview
                    fileName={previewFile.name}
                    filePath={previewFile.path}
                    content={previewFile.content}
                    base64Content={previewFile.base64Content}
                    onClose={() => setPreviewFile(null)}
                    onNavigate={currentImageIndex >= 0 ? handleGalleryNavigate : undefined}
                    galleryPosition={galleryPosition}
                />
            )}
        </View>
    );
});
