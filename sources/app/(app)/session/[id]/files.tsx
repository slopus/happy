import * as React from 'react';
import { View, ActivityIndicator, TextInput, Platform } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { searchFiles, FileItem } from '@/sync/suggestionFile';
import { StatusBar } from 'expo-status-bar';

export default function FilesScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    
    const [searchQuery, setSearchQuery] = React.useState('');
    const [files, setFiles] = React.useState<FileItem[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);

    // Load files on mount and when search query changes
    React.useEffect(() => {
        let isCancelled = false;
        
        const loadFiles = async () => {
            try {
                setIsLoading(true);
                const results = await searchFiles(sessionId, searchQuery, { limit: 50 });
                if (!isCancelled) {
                    setFiles(results);
                }
            } catch (error) {
                console.error('Failed to search files:', error);
                if (!isCancelled) {
                    setFiles([]);
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadFiles();
        
        return () => {
            isCancelled = true;
        };
    }, [sessionId, searchQuery]);

    const handleFilePress = React.useCallback((file: FileItem) => {
        if (file.fileType === 'file') {
            // Navigate to file viewer with the file path
            router.push(`/session/${sessionId}/file?path=${encodeURIComponent(file.fullPath)}`);
        } else {
            // For folders, update search to show files in that directory
            setSearchQuery(file.fullPath);
        }
    }, [router, sessionId]);

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
            <StatusBar style="dark" />
            
            {/* Search Input */}
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

            {/* Results count */}
            {!isLoading && files.length > 0 && (
                <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                    <Text style={{
                        fontSize: 12,
                        color: '#666',
                        ...Typography.default()
                    }}>
                        {files.length} result{files.length !== 1 ? 's' : ''}
                    </Text>
                </View>
            )}

            {/* File List */}
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
                ) : files.length === 0 ? (
                    <View style={{ 
                        flex: 1, 
                        justifyContent: 'center', 
                        alignItems: 'center',
                        paddingTop: 40,
                        paddingHorizontal: 20
                    }}>
                        <Octicons name="file-directory" size={48} color="#C7C7CC" />
                        <Text style={{
                            fontSize: 16,
                            color: '#666',
                            textAlign: 'center',
                            marginTop: 16,
                            ...Typography.default()
                        }}>
                            {searchQuery ? 'No files found' : 'Loading project files...'}
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
                    files.map((file, index) => (
                        <Item
                            key={`${file.fullPath}-${index}`}
                            title={file.fileName}
                            subtitle={file.filePath || 'Project root'}
                            icon={renderFileIcon(file)}
                            onPress={() => handleFilePress(file)}
                            showDivider={index < files.length - 1}
                        />
                    ))
                )}
            </ItemList>
        </View>
    );
}