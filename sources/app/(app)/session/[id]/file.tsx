import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { Typography } from '@/constants/Typography';
import { sessionReadFile, sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';

interface FileContent {
    content: string;
    encoding: 'utf8' | 'base64';
    isBinary: boolean;
}

// Diff display component
const DiffDisplay: React.FC<{ diffContent: string }> = ({ diffContent }) => {
    const { theme } = useUnistyles();
    const lines = diffContent.split('\n');
    
    return (
        <View>
            {lines.map((line, index) => {
                const baseStyle = { ...Typography.mono(), fontSize: 14, lineHeight: 20 };
                let lineStyle: any = baseStyle;
                let backgroundColor = 'transparent';
                
                if (line.startsWith('+') && !line.startsWith('+++')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.addedText };
                    backgroundColor = theme.colors.diff.addedBg;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.removedText };
                    backgroundColor = theme.colors.diff.removedBg;
                } else if (line.startsWith('@@')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.hunkHeaderText, fontWeight: '600' };
                    backgroundColor = theme.colors.diff.hunkHeaderBg;
                } else if (line.startsWith('+++') || line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.text, fontWeight: '600' };
                } else {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.contextText };
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
                            borderLeftColor: line.startsWith('+') && !line.startsWith('+++') ? theme.colors.diff.addedBorder : theme.colors.diff.removedBorder
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
    const { theme } = useUnistyles();
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
                            // If someone is using a custom diff tool like
                            // difftastic, the parser would break. So instead
                            // force git to use the built in diff tool.
                            command: `git diff --no-ext-diff "${filePath}"`,
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
            Modal.alert(t('common.error'), error);
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
                backgroundColor: theme.colors.surface,
                justifyContent: 'center', 
                alignItems: 'center' 
            }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ 
                    marginTop: 16, 
                    fontSize: 16, 
                    color: theme.colors.textSecondary,
                    ...Typography.default() 
                }}>
                    {t('files.loadingFile', { fileName })}
                </Text>
            </View>
        );
    }

    if (error) {
        return (
            <View style={{ 
                flex: 1, 
                backgroundColor: theme.colors.surface,
                justifyContent: 'center', 
                alignItems: 'center',
                padding: 20
            }}>
                <Text style={{ 
                    fontSize: 18, 
                    fontWeight: 'bold',
                    color: theme.colors.textDestructive,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('common.error')}
                </Text>
                <Text style={{ 
                    fontSize: 16, 
                    color: theme.colors.textSecondary,
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
                backgroundColor: theme.colors.surface,
                justifyContent: 'center', 
                alignItems: 'center',
                padding: 20
            }}>
                <Text style={{ 
                    fontSize: 18, 
                    fontWeight: 'bold',
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('files.binaryFile')}
                </Text>
                <Text style={{ 
                    fontSize: 16, 
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default() 
                }}>
                    {t('files.cannotDisplayBinary')}
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
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            
            {/* File path header */}
            <View style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHigh
            }}>
                <Text style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
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
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface
                }}>
                    <Pressable
                        onPress={() => setDisplayMode('diff')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: displayMode === 'diff' ? theme.colors.textLink : theme.colors.input.background,
                            marginRight: 8
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: displayMode === 'diff' ? 'white' : theme.colors.textSecondary,
                            ...Typography.default()
                        }}>
                            {t('files.diff')}
                        </Text>
                    </Pressable>
                    
                    <Pressable
                        onPress={() => setDisplayMode('file')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: displayMode === 'file' ? theme.colors.textLink : theme.colors.input.background
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: displayMode === 'file' ? 'white' : theme.colors.textSecondary,
                            ...Typography.default()
                        }}>
                            {t('files.file')}
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
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.fileEmpty')}
                    </Text>
                ) : !diffContent && !fileContent?.content ? (
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.noChanges')}
                    </Text>
                ) : null}
            </ScrollView>
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
