import * as React from 'react';
import { View, ActivityIndicator, Platform, TextInput, Pressable } from 'react-native';
import { t } from '@/text';
import { useRoute } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Octicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { getGitStatusFiles, GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';
import { searchFiles, FileItem } from '@/sync/suggestionFile';
import { sessionListDirectory } from '@/sync/ops';
import type { DirectoryEntry } from '@/sync/ops';
import { storage, useSessionGitStatus, useSessionProjectGitStatus } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';

const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
    'mp3', 'wav', 'flac', 'aac', 'ogg',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', 'tar', 'gz', 'rar', '7z',
    'exe', 'dmg', 'deb', 'rpm',
    'woff', 'woff2', 'ttf', 'otf',
    'db', 'sqlite', 'sqlite3'
]);

function isBinaryExtension(fileName: string): boolean {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

function formatFileSize(bytes?: number): string {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;

    const [gitStatusFiles, setGitStatusFiles] = React.useState<GitStatusFiles | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);

    // Browse mode state
    const [viewMode, setViewMode] = React.useState<'changes' | 'browse'>('changes');
    const [currentPath, setCurrentPath] = React.useState<string>('.');
    const [directoryEntries, setDirectoryEntries] = React.useState<DirectoryEntry[]>([]);
    const [isLoadingDirectory, setIsLoadingDirectory] = React.useState(false);
    const [pathHistory, setPathHistory] = React.useState<string[]>([]);

    // Use project git status first, fallback to session git status for backward compatibility
    const projectGitStatus = useSessionProjectGitStatus(sessionId);
    const sessionGitStatus = useSessionGitStatus(sessionId);
    const gitStatus = projectGitStatus || sessionGitStatus;
    const { theme } = useUnistyles();

    const isGitRepo = gitStatusFiles !== null;

    // Load git status files
    const loadGitStatusFiles = React.useCallback(async () => {
        try {
            setIsLoading(true);
            const result = await getGitStatusFiles(sessionId);
            setGitStatusFiles(result);
        } catch (error) {
            console.error('Failed to load git status files:', error);
            setGitStatusFiles(null);
        } finally {
            setIsLoading(false);
        }
    }, [sessionId]);

    // Load on mount
    React.useEffect(() => {
        loadGitStatusFiles();
    }, [loadGitStatusFiles]);

    // Refresh when screen is focused
    const [browseRefreshKey, setBrowseRefreshKey] = React.useState(0);
    useFocusEffect(
        React.useCallback(() => {
            loadGitStatusFiles();
            // Also refresh browse mode directory listing
            setBrowseRefreshKey(k => k + 1);
        }, [loadGitStatusFiles])
    );

    // Auto-switch to browse mode when not a git repo
    React.useEffect(() => {
        if (!isLoading && !isGitRepo) {
            setViewMode('browse');
        }
    }, [isLoading, isGitRepo]);

    // Load directory entries for browse mode
    React.useEffect(() => {
        if (viewMode !== 'browse' || searchQuery) return;

        let isCancelled = false;

        const loadDirectory = async () => {
            setIsLoadingDirectory(true);
            try {
                const session = storage.getState().sessions[sessionId];
                const basePath = session?.metadata?.path;
                if (!basePath) {
                    if (!isCancelled) {
                        setDirectoryEntries([]);
                        setIsLoadingDirectory(false);
                    }
                    return;
                }

                const fullPath = currentPath === '.' ? basePath : `${basePath}/${currentPath}`;
                const result = await sessionListDirectory(sessionId, fullPath);
                if (!isCancelled) {
                    if (result.success && result.entries) {
                        // Filter out hidden files/directories (starting with .) and 'other' type entries
                        setDirectoryEntries(
                            result.entries.filter(e => !e.name.startsWith('.') && e.type !== 'other')
                        );
                    } else {
                        // Clear stale data on failure
                        setDirectoryEntries([]);
                    }
                }
            } catch (error) {
                console.error('Failed to load directory:', error);
                if (!isCancelled) {
                    setDirectoryEntries([]);
                }
            } finally {
                if (!isCancelled) {
                    setIsLoadingDirectory(false);
                }
            }
        };

        loadDirectory();

        return () => {
            isCancelled = true;
        };
    }, [viewMode, currentPath, sessionId, searchQuery, browseRefreshKey]);

    // Handle search and file loading
    React.useEffect(() => {
        const loadFiles = async () => {
            if (!sessionId) return;

            try {
                setIsSearching(true);
                const results = await searchFiles(sessionId, searchQuery, { limit: 100 });
                setSearchResults(results);
            } catch (error) {
                console.error('Failed to search files:', error);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        };

        // Load files when searching or when repo is clean (in changes mode)
        const shouldShowAllFiles = searchQuery ||
            (viewMode === 'changes' && gitStatusFiles?.totalStaged === 0 && gitStatusFiles?.totalUnstaged === 0);

        if (shouldShowAllFiles && !isLoading) {
            loadFiles();
        } else if (!searchQuery) {
            setSearchResults([]);
            setIsSearching(false);
        }
    }, [searchQuery, gitStatusFiles, sessionId, isLoading, viewMode]);

    const handleFilePress = React.useCallback((file: GitFileStatus | FileItem) => {
        const encodedPath = btoa(file.fullPath);
        router.push(`/session/${sessionId}/file?path=${encodedPath}`);
    }, [router, sessionId]);

    const handleBrowseFilePress = React.useCallback((entry: DirectoryEntry) => {
        const session = storage.getState().sessions[sessionId];
        const basePath = session?.metadata?.path || '';
        const filePath = currentPath === '.' ? entry.name : `${currentPath}/${entry.name}`;
        const encodedPath = btoa(`${basePath}/${filePath}`);
        router.push(`/session/${sessionId}/file?path=${encodedPath}`);
    }, [router, sessionId, currentPath]);

    const handleNavigateIntoDirectory = React.useCallback((dirName: string) => {
        setPathHistory(h => [...h, currentPath]);
        setCurrentPath(currentPath === '.' ? dirName : `${currentPath}/${dirName}`);
    }, [currentPath]);

    const handleNavigateUp = React.useCallback(() => {
        if (pathHistory.length > 0) {
            const prev = pathHistory[pathHistory.length - 1];
            setPathHistory(h => h.slice(0, -1));
            setCurrentPath(prev);
        } else {
            setCurrentPath('.');
        }
    }, [pathHistory]);

    const renderFileIcon = (file: GitFileStatus) => {
        return <FileIcon fileName={file.fileName} size={32} />;
    };

    const renderStatusIcon = (file: GitFileStatus) => {
        let statusColor: string;
        let statusIcon: string;

        switch (file.status) {
            case 'modified':
                statusColor = "#FF9500";
                statusIcon = "diff-modified";
                break;
            case 'added':
                statusColor = "#34C759";
                statusIcon = "diff-added";
                break;
            case 'deleted':
                statusColor = "#FF3B30";
                statusIcon = "diff-removed";
                break;
            case 'renamed':
                statusColor = "#007AFF";
                statusIcon = "arrow-right";
                break;
            case 'untracked':
                statusColor = theme.dark ? "#b0b0b0" : "#8E8E93";
                statusIcon = "file";
                break;
            default:
                return null;
        }

        return <Octicons name={statusIcon as any} size={16} color={statusColor} />;
    };

    const renderLineChanges = (file: GitFileStatus) => {
        const parts = [];
        if (file.linesAdded > 0) {
            parts.push(`+${file.linesAdded}`);
        }
        if (file.linesRemoved > 0) {
            parts.push(`-${file.linesRemoved}`);
        }
        return parts.length > 0 ? parts.join(' ') : '';
    };

    const renderFileSubtitle = (file: GitFileStatus) => {
        const lineChanges = renderLineChanges(file);
        const pathPart = file.filePath || t('files.projectRoot');
        return lineChanges ? `${pathPart} • ${lineChanges}` : pathPart;
    };

    const renderFileIconForSearch = (file: FileItem) => {
        if (file.fileType === 'folder') {
            return <Octicons name="file-directory" size={29} color="#007AFF" />;
        }

        return <FileIcon fileName={file.fileName} size={29} />;
    };

    // Determine what content to show
    const showSearch = !!searchQuery;
    const showBrowse = viewMode === 'browse' && !searchQuery;
    const showChanges = viewMode === 'changes' && !searchQuery;

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>

            {/* Search Input - Always Visible */}
            <View style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider
            }}>
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: theme.colors.input.background,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 8
                }}>
                    <Octicons name="search" size={16} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
                    <TextInput
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder={t('files.searchPlaceholder')}
                        style={{
                            flex: 1,
                            fontSize: 16,
                            ...Typography.default()
                        }}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </View>
            </View>

            {/* Mode Toggle - Only when git repo */}
            {!isLoading && isGitRepo && !searchQuery && (
                <View style={{
                    flexDirection: 'row',
                    paddingHorizontal: 16,
                    paddingVertical: 10,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                }}>
                    <Pressable
                        onPress={() => setViewMode('changes')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: viewMode === 'changes' ? theme.colors.textLink : theme.colors.input.background,
                            marginRight: 8
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: viewMode === 'changes' ? 'white' : theme.colors.textSecondary,
                            ...Typography.default()
                        }}>
                            {t('files.changesTab')}
                        </Text>
                    </Pressable>

                    <Pressable
                        onPress={() => setViewMode('browse')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: viewMode === 'browse' ? theme.colors.textLink : theme.colors.input.background
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: viewMode === 'browse' ? 'white' : theme.colors.textSecondary,
                            ...Typography.default()
                        }}>
                            {t('files.browseTab')}
                        </Text>
                    </Pressable>
                </View>
            )}

            {/* Header with branch info - Only in changes mode */}
            {showChanges && !isLoading && gitStatusFiles && (
                <View style={{
                    padding: 16,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider
                }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginBottom: 8
                    }}>
                        <Octicons name="git-branch" size={16} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.text,
                            ...Typography.default()
                        }}>
                            {gitStatusFiles.branch || t('files.detachedHead')}
                        </Text>
                    </View>
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        ...Typography.default()
                    }}>
                        {t('files.summary', { staged: gitStatusFiles.totalStaged, unstaged: gitStatusFiles.totalUnstaged })}
                    </Text>
                </View>
            )}

            {/* Browse mode path bar */}
            {showBrowse && currentPath !== '.' && (
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 16,
                    paddingVertical: 10,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                }}>
                    <Pressable onPress={handleNavigateUp} style={{ marginRight: 8, padding: 4 }}>
                        <Octicons name="arrow-left" size={16} color={theme.colors.textLink} />
                    </Pressable>
                    <Octicons name="file-directory" size={16} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 14,
                        color: theme.colors.textSecondary,
                        flex: 1,
                        ...Typography.mono()
                    }} numberOfLines={1}>
                        {currentPath}
                    </Text>
                </View>
            )}

            {/* Content */}
            <ItemList style={{ flex: 1 }}>
                {isLoading ? (
                    <View style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        paddingTop: 40
                    }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : showSearch ? (
                    // Search results (same as before)
                    isSearching ? (
                        <View style={{
                            flex: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: 40
                        }}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            <Text style={{
                                fontSize: 16,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                {t('files.searching')}
                            </Text>
                        </View>
                    ) : searchResults.length === 0 ? (
                        <View style={{
                            flex: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: 40,
                            paddingHorizontal: 20
                        }}>
                            <Octicons name="search" size={48} color={theme.colors.textSecondary} />
                            <Text style={{
                                fontSize: 16,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                {t('files.noFilesFound')}
                            </Text>
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 8,
                                ...Typography.default()
                            }}>
                                {t('files.tryDifferentTerm')}
                            </Text>
                        </View>
                    ) : (
                        <>
                            <View style={{
                                backgroundColor: theme.colors.surfaceHigh,
                                paddingHorizontal: 16,
                                paddingVertical: 12,
                                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                borderBottomColor: theme.colors.divider
                            }}>
                                <Text style={{
                                    fontSize: 14,
                                    fontWeight: '600',
                                    color: theme.colors.textLink,
                                    ...Typography.default()
                                }}>
                                    {t('files.searchResults', { count: searchResults.length })}
                                </Text>
                            </View>
                            {searchResults.map((file, index) => (
                                <Item
                                    key={`file-${file.fullPath}-${index}`}
                                    title={file.fileName}
                                    subtitle={file.filePath || t('files.projectRoot')}
                                    icon={renderFileIconForSearch(file)}
                                    onPress={() => handleFilePress(file)}
                                    showDivider={index < searchResults.length - 1}
                                />
                            ))}
                        </>
                    )
                ) : showBrowse ? (
                    // Browse mode - directory listing
                    isLoadingDirectory ? (
                        <View style={{
                            flex: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: 40
                        }}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        </View>
                    ) : directoryEntries.length === 0 ? (
                        <View style={{
                            flex: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: 40,
                            paddingHorizontal: 20
                        }}>
                            <Octicons name="file-directory" size={48} color={theme.colors.textSecondary} />
                            <Text style={{
                                fontSize: 16,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                {t('files.emptyDirectory')}
                            </Text>
                        </View>
                    ) : (
                        directoryEntries.map((entry, index) => {
                            const isDirectory = entry.type === 'directory';
                            const isBinary = !isDirectory && isBinaryExtension(entry.name);

                            return (
                                <Item
                                    key={`browse-${entry.name}-${index}`}
                                    title={entry.name}
                                    subtitle={isDirectory ? t('files.directory') : (isBinary ? t('files.binaryFile') : formatFileSize(entry.size))}
                                    icon={isDirectory
                                        ? <Octicons name="file-directory" size={29} color="#007AFF" />
                                        : <FileIcon fileName={entry.name} size={29} />
                                    }
                                    onPress={() => {
                                        if (isDirectory) {
                                            handleNavigateIntoDirectory(entry.name);
                                        } else {
                                            handleBrowseFilePress(entry);
                                        }
                                    }}
                                    rightElement={isBinary ? (
                                        <Octicons name="file-binary" size={16} color={theme.colors.textSecondary} />
                                    ) : undefined}
                                    showDivider={index < directoryEntries.length - 1}
                                />
                            );
                        })
                    )
                ) : showChanges ? (
                    // Changes mode
                    gitStatusFiles && (gitStatusFiles.totalStaged === 0 && gitStatusFiles.totalUnstaged === 0) ? (
                        // Clean repo - show all files via search
                        isSearching ? (
                            <View style={{
                                flex: 1,
                                justifyContent: 'center',
                                alignItems: 'center',
                                paddingTop: 40
                            }}>
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            </View>
                        ) : searchResults.length === 0 ? (
                            <View style={{
                                flex: 1,
                                justifyContent: 'center',
                                alignItems: 'center',
                                paddingTop: 40,
                                paddingHorizontal: 20
                            }}>
                                <Octicons name="file-directory" size={48} color={theme.colors.textSecondary} />
                                <Text style={{
                                    fontSize: 16,
                                    color: theme.colors.textSecondary,
                                    textAlign: 'center',
                                    marginTop: 16,
                                    ...Typography.default()
                                }}>
                                    {t('files.noFilesInProject')}
                                </Text>
                            </View>
                        ) : (
                            searchResults.map((file, index) => (
                                <Item
                                    key={`file-${file.fullPath}-${index}`}
                                    title={file.fileName}
                                    subtitle={file.filePath || t('files.projectRoot')}
                                    icon={renderFileIconForSearch(file)}
                                    onPress={() => handleFilePress(file)}
                                    showDivider={index < searchResults.length - 1}
                                />
                            ))
                        )
                    ) : gitStatusFiles ? (
                        <>
                            {/* Staged Changes Section */}
                            {gitStatusFiles.stagedFiles.length > 0 && (
                                <>
                                    <View style={{
                                        backgroundColor: theme.colors.surfaceHigh,
                                        paddingHorizontal: 16,
                                        paddingVertical: 12,
                                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                        borderBottomColor: theme.colors.divider
                                    }}>
                                        <Text style={{
                                            fontSize: 14,
                                            fontWeight: '600',
                                            color: theme.colors.success,
                                            ...Typography.default()
                                        }}>
                                            {t('files.stagedChanges', { count: gitStatusFiles.stagedFiles.length })}
                                        </Text>
                                    </View>
                                    {gitStatusFiles.stagedFiles.map((file, index) => (
                                        <Item
                                            key={`staged-${file.fullPath}-${index}`}
                                            title={file.fileName}
                                            subtitle={renderFileSubtitle(file)}
                                            icon={renderFileIcon(file)}
                                            rightElement={renderStatusIcon(file)}
                                            onPress={() => handleFilePress(file)}
                                            showDivider={index < gitStatusFiles.stagedFiles.length - 1 || gitStatusFiles.unstagedFiles.length > 0}
                                        />
                                    ))}
                                </>
                            )}

                            {/* Unstaged Changes Section */}
                            {gitStatusFiles.unstagedFiles.length > 0 && (
                                <>
                                    <View style={{
                                        backgroundColor: theme.colors.surfaceHigh,
                                        paddingHorizontal: 16,
                                        paddingVertical: 12,
                                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                        borderBottomColor: theme.colors.divider
                                    }}>
                                        <Text style={{
                                            fontSize: 14,
                                            fontWeight: '600',
                                            color: theme.colors.warning,
                                            ...Typography.default()
                                        }}>
                                            {t('files.unstagedChanges', { count: gitStatusFiles.unstagedFiles.length })}
                                        </Text>
                                    </View>
                                    {gitStatusFiles.unstagedFiles.map((file, index) => (
                                        <Item
                                            key={`unstaged-${file.fullPath}-${index}`}
                                            title={file.fileName}
                                            subtitle={renderFileSubtitle(file)}
                                            icon={renderFileIcon(file)}
                                            rightElement={renderStatusIcon(file)}
                                            onPress={() => handleFilePress(file)}
                                            showDivider={index < gitStatusFiles.unstagedFiles.length - 1}
                                        />
                                    ))}
                                </>
                            )}
                        </>
                    ) : null
                ) : null}
            </ItemList>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    }
}));
