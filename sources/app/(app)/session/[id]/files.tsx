import * as React from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { getGitStatusFiles, GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';
import { useSessionGitStatus } from '@/sync/storage';
import { StatusBar } from 'expo-status-bar';

export default function FilesScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    
    const [gitStatusFiles, setGitStatusFiles] = React.useState<GitStatusFiles | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);
    const gitStatus = useSessionGitStatus(sessionId);

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

    const handleFilePress = React.useCallback((file: GitFileStatus) => {
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

    return (
        <View style={{ flex: 1, backgroundColor: 'white' }}>
            <StatusBar style="dark" />
            
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
                        <ActivityIndicator size="large" color="#666" />
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
                ) : gitStatusFiles.totalStaged === 0 && gitStatusFiles.totalUnstaged === 0 ? (
                    <View style={{ 
                        flex: 1, 
                        justifyContent: 'center', 
                        alignItems: 'center',
                        paddingTop: 40,
                        paddingHorizontal: 20
                    }}>
                        <Octicons name="check-circle" size={48} color="#34C759" />
                        <Text style={{
                            fontSize: 16,
                            color: '#666',
                            textAlign: 'center',
                            marginTop: 16,
                            ...Typography.default()
                        }}>
                            Working tree clean
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: '#999',
                            textAlign: 'center',
                            marginTop: 8,
                            ...Typography.default()
                        }}>
                            No changes to commit
                        </Text>
                    </View>
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