import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { Typography } from '@/constants/Typography';
import { sessionReadFile, sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { StatusBar } from 'expo-status-bar';
import { Modal } from '@/modal';

interface FileContent {
    content: string;
    encoding: 'utf8' | 'base64';
    isBinary: boolean;
}

// Diff display component
const DiffDisplay: React.FC<{ diffContent: string }> = ({ diffContent }) => {
    const lines = diffContent.split('\n');
    
    return (
        <View>
            {lines.map((line, index) => {
                const baseStyle = { ...Typography.mono(), fontSize: 14, lineHeight: 20 };
                let lineStyle: any = baseStyle;
                let backgroundColor = 'transparent';
                
                if (line.startsWith('+') && !line.startsWith('+++')) {
                    lineStyle = { ...baseStyle, color: '#059669' }; // Green for additions
                    backgroundColor = '#f0fdf4'; // Light green background
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: '#dc2626' }; // Red for deletions
                    backgroundColor = '#fef2f2'; // Light red background
                } else if (line.startsWith('@@')) {
                    lineStyle = { ...baseStyle, color: '#0891b2', fontWeight: '600' }; // Cyan for hunk headers
                    backgroundColor = '#f0f9ff'; // Light blue background
                } else if (line.startsWith('+++') || line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: '#374151', fontWeight: '600' }; // Dark gray for file headers
                } else {
                    lineStyle = { ...baseStyle, color: '#374151' }; // Normal text
                }
                
                return (
                    <View 
                        key={index} 
                        style={{ 
                            backgroundColor, 
                            paddingHorizontal: 8, 
                            paddingVertical: 1,
                            borderLeftWidth: line.startsWith('+') && !line.startsWith('+++') ? 3 : 
                                           line.startsWith('-') && !line.startsWith('---') ? 3 : 0,
                            borderLeftColor: line.startsWith('+') && !line.startsWith('+++') ? '#059669' : '#dc2626'
                        }}
                    >
                        <Text style={lineStyle}>
                            {line || ' '}
                        </Text>
                    </View>
                );
            })}
        </View>
    );
};

export default function FileScreen() {
    const route = useRoute();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const searchParams = useLocalSearchParams();
    const encodedPath = searchParams.path as string;
    let filePath = '';
    
    // Decode base64 path with error handling
    try {
        filePath = encodedPath ? atob(encodedPath) : '';
    } catch (error) {
        console.error('Failed to decode file path:', error);
        filePath = encodedPath || ''; // Fallback to original path if decoding fails
    }
    
    const [fileContent, setFileContent] = React.useState<FileContent | null>(null);
    const [diffContent, setDiffContent] = React.useState<string | null>(null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>('diff');
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    // Determine file language from extension
    const getFileLanguage = React.useCallback((path: string): string | null => {
        const ext = path.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'js':
            case 'jsx':
                return 'javascript';
            case 'ts':
            case 'tsx':
                return 'typescript';
            case 'py':
                return 'python';
            case 'html':
            case 'htm':
                return 'html';
            case 'css':
                return 'css';
            case 'json':
                return 'json';
            case 'md':
                return 'markdown';
            case 'xml':
                return 'xml';
            case 'yaml':
            case 'yml':
                return 'yaml';
            case 'sh':
            case 'bash':
                return 'bash';
            case 'sql':
                return 'sql';
            case 'go':
                return 'go';
            case 'rust':
            case 'rs':
                return 'rust';
            case 'java':
                return 'java';
            case 'c':
                return 'c';
            case 'cpp':
            case 'cc':
            case 'cxx':
                return 'cpp';
            case 'php':
                return 'php';
            case 'rb':
                return 'ruby';
            case 'swift':
                return 'swift';
            case 'kt':
                return 'kotlin';
            default:
                return null;
        }
    }, []);

    // Check if file is likely binary based on extension
    const isBinaryFile = React.useCallback((path: string): boolean => {
        const ext = path.split('.').pop()?.toLowerCase();
        const binaryExtensions = [
            'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
            'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
            'mp3', 'wav', 'flac', 'aac', 'ogg',
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            'zip', 'tar', 'gz', 'rar', '7z',
            'exe', 'dmg', 'deb', 'rpm',
            'woff', 'woff2', 'ttf', 'otf',
            'db', 'sqlite', 'sqlite3'
        ];
        return ext ? binaryExtensions.includes(ext) : false;
    }, []);

    // Load file content
    React.useEffect(() => {
        let isCancelled = false;
        
        const loadFile = async () => {
            try {
                setIsLoading(true);
                setError(null);
                
                // Get session metadata for git commands
                const session = storage.getState().sessions[sessionId!];
                const sessionPath = session?.metadata?.path;
                
                // Check if file is likely binary before trying to read
                if (isBinaryFile(filePath)) {
                    if (!isCancelled) {
                        setFileContent({
                            content: '',
                            encoding: 'base64',
                            isBinary: true
                        });
                        setIsLoading(false);
                    }
                    return;
                }
                
                // Fetch git diff for the file (if in git repo)
                if (sessionPath && sessionId) {
                    try {
                        const diffResponse = await sessionBash(sessionId, {
                            command: `git diff "${filePath}"`,
                            cwd: sessionPath,
                            timeout: 5000
                        });
                        
                        if (!isCancelled && diffResponse.success && diffResponse.stdout.trim()) {
                            setDiffContent(diffResponse.stdout);
                        }
                    } catch (diffError) {
                        console.log('Could not fetch git diff:', diffError);
                        // Continue with file loading even if diff fails
                    }
                }
                
                const response = await sessionReadFile(sessionId, filePath);
                
                if (!isCancelled) {
                    if (response.success && response.content) {
                        // Decode base64 content to UTF-8 string
                        let decodedContent: string;
                        try {
                            decodedContent = atob(response.content);
                        } catch (decodeError) {
                            // If base64 decode fails, treat as binary
                            setFileContent({
                                content: '',
                                encoding: 'base64',
                                isBinary: true
                            });
                            return;
                        }
                        
                        // Check if content contains binary data (null bytes or too many non-printable chars)
                        const hasNullBytes = decodedContent.includes('\0');
                        const nonPrintableCount = decodedContent.split('').filter(char => {
                            const code = char.charCodeAt(0);
                            return code < 32 && code !== 9 && code !== 10 && code !== 13; // Allow tab, LF, CR
                        }).length;
                        const isBinary = hasNullBytes || (nonPrintableCount / decodedContent.length > 0.1);
                        
                        setFileContent({
                            content: isBinary ? '' : decodedContent,
                            encoding: 'utf8',
                            isBinary
                        });
                    } else {
                        setError(response.error || 'Failed to read file');
                    }
                }
            } catch (error) {
                console.error('Failed to load file:', error);
                if (!isCancelled) {
                    setError('Failed to load file');
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadFile();
        
        return () => {
            isCancelled = true;
        };
    }, [sessionId, filePath, isBinaryFile]);

    // Show error modal if there's an error
    React.useEffect(() => {
        if (error) {
            Modal.alert('Error', error);
        }
    }, [error]);

    // Set default display mode based on diff availability
    React.useEffect(() => {
        if (diffContent) {
            setDisplayMode('diff');
        } else if (fileContent) {
            setDisplayMode('file');
        }
    }, [diffContent, fileContent]);

    const fileName = filePath.split('/').pop() || filePath;
    const language = getFileLanguage(filePath);

    if (isLoading) {
        return (
            <View style={{ 
                flex: 1, 
                backgroundColor: 'white',
                justifyContent: 'center', 
                alignItems: 'center' 
            }}>
                <StatusBar style="dark" />
                <ActivityIndicator size="large" color="#666" />
                <Text style={{ 
                    marginTop: 16, 
                    fontSize: 16, 
                    color: '#666',
                    ...Typography.default() 
                }}>
                    Loading {fileName}...
                </Text>
            </View>
        );
    }

    if (error) {
        return (
            <View style={{ 
                flex: 1, 
                backgroundColor: 'white',
                justifyContent: 'center', 
                alignItems: 'center',
                padding: 20
            }}>
                <StatusBar style="dark" />
                <Text style={{ 
                    fontSize: 18, 
                    fontWeight: 'bold',
                    color: '#FF3B30',
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    Error
                </Text>
                <Text style={{ 
                    fontSize: 16, 
                    color: '#666',
                    textAlign: 'center',
                    ...Typography.default() 
                }}>
                    {error}
                </Text>
            </View>
        );
    }

    if (fileContent?.isBinary) {
        return (
            <View style={{ 
                flex: 1, 
                backgroundColor: 'white',
                justifyContent: 'center', 
                alignItems: 'center',
                padding: 20
            }}>
                <StatusBar style="dark" />
                <Text style={{ 
                    fontSize: 18, 
                    fontWeight: 'bold',
                    color: '#666',
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    Binary File
                </Text>
                <Text style={{ 
                    fontSize: 16, 
                    color: '#666',
                    textAlign: 'center',
                    ...Typography.default() 
                }}>
                    Cannot display binary file content
                </Text>
                <Text style={{ 
                    fontSize: 14, 
                    color: '#999',
                    textAlign: 'center',
                    marginTop: 8,
                    ...Typography.default() 
                }}>
                    {fileName}
                </Text>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: 'white' }}>
            <StatusBar style="dark" />
            
            {/* File path header */}
            <View style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: Platform.select({ ios: '#C6C6C8', default: '#E0E0E0' }),
                backgroundColor: '#F8F8F8'
            }}>
                <Text style={{
                    fontSize: 14,
                    color: '#666',
                    ...Typography.mono()
                }}>
                    {filePath}
                </Text>
            </View>

            {/* Toggle buttons for File/Diff view */}
            {diffContent && (
                <View style={{
                    flexDirection: 'row',
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: Platform.select({ ios: '#C6C6C8', default: '#E0E0E0' }),
                    backgroundColor: 'white'
                }}>
                    <Pressable
                        onPress={() => setDisplayMode('diff')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: displayMode === 'diff' ? '#007AFF' : '#F2F2F7',
                            marginRight: 8
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: displayMode === 'diff' ? 'white' : '#666',
                            ...Typography.default()
                        }}>
                            Diff
                        </Text>
                    </Pressable>
                    
                    <Pressable
                        onPress={() => setDisplayMode('file')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: displayMode === 'file' ? '#007AFF' : '#F2F2F7'
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: displayMode === 'file' ? 'white' : '#666',
                            ...Typography.default()
                        }}>
                            File
                        </Text>
                    </Pressable>
                </View>
            )}
            
            {/* Content display */}
            <ScrollView 
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16 }}
                showsVerticalScrollIndicator={true}
            >
                {displayMode === 'diff' && diffContent ? (
                    <DiffDisplay diffContent={diffContent} />
                ) : displayMode === 'file' && fileContent?.content ? (
                    <SimpleSyntaxHighlighter 
                        code={fileContent.content}
                        language={language}
                    />
                ) : displayMode === 'file' && fileContent && !fileContent.content ? (
                    <Text style={{
                        fontSize: 16,
                        color: '#666',
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        File is empty
                    </Text>
                ) : !diffContent && !fileContent?.content ? (
                    <Text style={{
                        fontSize: 16,
                        color: '#666',
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        No changes to display
                    </Text>
                ) : null}
            </ScrollView>
        </View>
    );
}