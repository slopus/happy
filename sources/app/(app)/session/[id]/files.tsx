import * as React from 'react';
import { View, ActivityIndicator, Platform, TextInput } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { getGitStatusFiles, GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';
import { searchFiles, FileItem } from '@/sync/suggestionFile';
import { useSessionGitStatus } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';

export default function FilesScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    
    const [gitStatusFiles, setGitStatusFiles] = React.useState<GitStatusFiles | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const gitStatus = useSessionGitStatus(sessionId);
    const { theme } = useUnistyles();
    
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
    useFocusEffect(
        React.useCallback(() => {
            loadGitStatusFiles();
        }, [loadGitStatusFiles])
    );

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

        // Load files when searching or when repo is clean
        const shouldShowAllFiles = searchQuery || 
            (gitStatusFiles?.totalStaged === 0 && gitStatusFiles?.totalUnstaged === 0);
        
        if (shouldShowAllFiles && !isLoading) {
            loadFiles();
        } else if (!searchQuery) {
            setSearchResults([]);
            setIsSearching(false);
        }
    }, [searchQuery, gitStatusFiles, sessionId, isLoading]);

    const handleFilePress = React.useCallback((file: GitFileStatus | FileItem) => {
        // Navigate to file viewer with the file path (base64 encoded for special characters)
        const encodedPath = btoa(file.fullPath);
        router.push(`/session/${sessionId}/file?path=${encodedPath}`);
    }, [router, sessionId]);

    const renderStatusIcon = (file: GitFileStatus) => {
        switch (file.status) {
            case 'modified':
                return <Octicons name="git-compare" size={29} color="#FF9500" />;
            case 'added':
                return <Octicons name="diff-added" size={29} color="#34C759" />;
            case 'deleted':
                return <Octicons name="diff-removed" size={29} color="#FF3B30" />;
            case 'renamed':
                return <Octicons name="arrow-right" size={29} color="#007AFF" />;
            case 'untracked':
                return <Octicons name="file" size={29} color="#8E8E93" />;
            default:
                return <Octicons name="file" size={29} color="#666" />;
        }
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
        const pathPart = file.filePath || 'Project root';
        return lineChanges ? `${pathPart} • ${lineChanges}` : pathPart;
    };

    const renderFileIcon = (file: FileItem) => {
        if (file.fileType === 'folder') {
            return <Octicons name="file-directory" size={29} color="#007AFF" />;
        }
        
        // File type based icons
        const ext = file.fileName.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'js':
            case 'jsx':
                return <Octicons name="file-code" size={29} color="#F7DF1E" />;
            case 'ts':
            case 'tsx':
                return <Octicons name="file-code" size={29} color="#3178C6" />;
            case 'py':
                return <Octicons name="file-code" size={29} color="#3776AB" />;
            case 'html':
            case 'htm':
                return <Octicons name="file-code" size={29} color="#E34F26" />;
            case 'css':
                return <Octicons name="file-code" size={29} color="#1572B6" />;
            case 'json':
                return <Octicons name="file-code" size={29} color="#000" />;
            case 'md':
                return <Octicons name="markdown" size={29} color="#000" />;
            case 'png':
            case 'jpg':
            case 'jpeg':
            case 'gif':
            case 'svg':
                return <Octicons name="image" size={29} color="#4CAF50" />;
            case 'zip':
            case 'tar':
            case 'gz':
                return <Octicons name="file-zip" size={29} color="#666" />;
            default:
                return <Octicons name="file" size={29} color="#666" />;
        }
    };

    return (
        <View style={{ flex: 1, backgroundColor: 'white' }}>
            
            {/* Search Input - Always Visible */}
            <View style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: Platform.select({ ios: '#C6C6C8', default: '#E0E0E0' })
            }}>
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: Platform.select({ ios: '#F2F2F7', default: '#F5F5F5' }),
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 8
                }}>
                    <Octicons name="search" size={16} color="#666" style={{ marginRight: 8 }} />
                    <TextInput
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder="Search files..."
                        style={{
                            flex: 1,
                            fontSize: 16,
                            ...Typography.default()
                        }}
                        placeholderTextColor="#666"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </View>
            </View>
            
            {/* Header with branch info */}
            {!isLoading && gitStatusFiles && (
                <View style={{
                    padding: 16,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: Platform.select({ ios: '#C6C6C8', default: '#E0E0E0' })
                }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginBottom: 8
                    }}>
                        <Octicons name="git-branch" size={16} color="#666" style={{ marginRight: 6 }} />
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: '#000',
                            ...Typography.default()
                        }}>
                            {gitStatusFiles.branch || 'detached HEAD'}
                        </Text>
                    </View>
                    <Text style={{
                        fontSize: 12,
                        color: '#666',
                        ...Typography.default()
                    }}>
                        {gitStatusFiles.totalStaged} staged • {gitStatusFiles.totalUnstaged} unstaged
                    </Text>
                </View>
            )}

            {/* Git Status List */}
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
                ) : !gitStatusFiles ? (
                    <View style={{ 
                        flex: 1, 
                        justifyContent: 'center', 
                        alignItems: 'center',
                        paddingTop: 40,
                        paddingHorizontal: 20
                    }}>
                        <Octicons name="git-branch" size={48} color="#C7C7CC" />
                        <Text style={{
                            fontSize: 16,
                            color: '#666',
                            textAlign: 'center',
                            marginTop: 16,
                            ...Typography.default()
                        }}>
                            Not a git repository
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: '#999',
                            textAlign: 'center',
                            marginTop: 8,
                            ...Typography.default()
                        }}>
                            This directory is not under git version control
                        </Text>
                    </View>
                ) : searchQuery || (gitStatusFiles.totalStaged === 0 && gitStatusFiles.totalUnstaged === 0) ? (
                    // Show search results or all files when clean repo
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
                                color: '#666',
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                Searching files...
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
                            <Octicons name={searchQuery ? "search" : "file-directory"} size={48} color="#C7C7CC" />
                            <Text style={{
                                fontSize: 16,
                                color: '#666',
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                {searchQuery ? 'No files found' : 'No files in project'}
                            </Text>
                            {searchQuery && (
                                <Text style={{
                                    fontSize: 14,
                                    color: '#999',
                                    textAlign: 'center',
                                    marginTop: 8,
                                    ...Typography.default()
                                }}>
                                    Try a different search term
                                </Text>
                            )}
                        </View>
                    ) : (
                        // Show search results or all files
                        <>
                            {searchQuery && (
                                <View style={{
                                    backgroundColor: '#F8F9FA',
                                    paddingHorizontal: 16,
                                    paddingVertical: 12,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: Platform.select({ ios: '#C6C6C8', default: '#E0E0E0' })
                                }}>
                                    <Text style={{
                                        fontSize: 14,
                                        fontWeight: '600',
                                        color: '#007AFF',
                                        ...Typography.default()
                                    }}>
                                        Search Results ({searchResults.length})
                                    </Text>
                                </View>
                            )}
                            {searchResults.map((file, index) => (
                                <Item
                                    key={`file-${file.fullPath}-${index}`}
                                    title={file.fileName}
                                    subtitle={file.filePath || 'Project root'}
                                    icon={renderFileIcon(file)}
                                    onPress={() => handleFilePress(file)}
                                    showDivider={index < searchResults.length - 1}
                                />
                            ))}
                        </>
                    )
                ) : (
                    <>
                        {/* Staged Changes Section */}
                        {gitStatusFiles.stagedFiles.length > 0 && (
                            <>
                                <View style={{
                                    backgroundColor: '#F8F9FA',
                                    paddingHorizontal: 16,
                                    paddingVertical: 12,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: Platform.select({ ios: '#C6C6C8', default: '#E0E0E0' })
                                }}>
                                    <Text style={{
                                        fontSize: 14,
                                        fontWeight: '600',
                                        color: '#34C759',
                                        ...Typography.default()
                                    }}>
                                        Staged Changes ({gitStatusFiles.stagedFiles.length})
                                    </Text>
                                </View>
                                {gitStatusFiles.stagedFiles.map((file, index) => (
                                    <Item
                                        key={`staged-${file.fullPath}-${index}`}
                                        title={file.fileName}
                                        subtitle={renderFileSubtitle(file)}
                                        icon={renderStatusIcon(file)}
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
                                    backgroundColor: '#F8F9FA',
                                    paddingHorizontal: 16,
                                    paddingVertical: 12,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: Platform.select({ ios: '#C6C6C8', default: '#E0E0E0' })
                                }}>
                                    <Text style={{
                                        fontSize: 14,
                                        fontWeight: '600',
                                        color: '#FF9500',
                                        ...Typography.default()
                                    }}>
                                        Unstaged Changes ({gitStatusFiles.unstagedFiles.length})
                                    </Text>
                                </View>
                                {gitStatusFiles.unstagedFiles.map((file, index) => (
                                    <Item
                                        key={`unstaged-${file.fullPath}-${index}`}
                                        title={file.fileName}
                                        subtitle={renderFileSubtitle(file)}
                                        icon={renderStatusIcon(file)}
                                        onPress={() => handleFilePress(file)}
                                        showDivider={index < gitStatusFiles.unstagedFiles.length - 1}
                                    />
                                ))}
                            </>
                        )}
                    </>
                )}
            </ItemList>
        </View>
    );
}