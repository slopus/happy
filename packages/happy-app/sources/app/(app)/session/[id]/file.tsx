import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform, Pressable, Share } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Text } from '@/components/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { CodeEditor } from '@/components/CodeEditor';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { sessionReadFile, sessionBash, sessionWriteFile } from '@/sync/ops';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import { storage, useSetting } from '@/sync/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { FileIcon } from '@/components/FileIcon';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { storeTempText } from '@/sync/persistence';
import * as Clipboard from 'expo-clipboard';
import { hapticsLight } from '@/components/haptics';
import { showCopiedToast } from '@/components/Toast';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { shellEscape } from '@/utils/shellEscape';

function getRepoRelativePath(filePath: string, repoPath: string): string {
    if (repoPath && filePath.startsWith(`${repoPath}/`)) {
        return filePath.substring(repoPath.length + 1);
    }
    return filePath;
}

interface FileContent {
    content: string;
    encoding: 'utf8' | 'base64';
    isBinary: boolean;
}

function parsePositiveInt(value: string | string[] | undefined): number | undefined {
    if (typeof value !== 'string') return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
    const router = useRouter();
    const { theme } = useUnistyles();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const searchParams = useLocalSearchParams();
    const encodedPath = searchParams.path as string;
    const ref = searchParams.ref as string | undefined;
    const preferredView = searchParams.view as 'file' | 'diff' | undefined;
    const isStaged = searchParams.staged === '1';
    const requestedLine = parsePositiveInt(searchParams.line);
    const requestedColumn = parsePositiveInt(searchParams.column);
    let filePath = '';
    
    // Decode base64 path with error handling (UTF-8 safe)
    try {
        if (encodedPath) {
            const binaryString = atob(encodedPath);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            filePath = new TextDecoder('utf-8').decode(bytes);
        }
    } catch (error) {
        console.error('Failed to decode file path:', error);
        filePath = encodedPath || ''; // Fallback to original path if decoding fails
    }
    
    const session = storage.getState().sessions[sessionId!];
    const displayPath = formatPathRelativeToHome(filePath, session?.metadata?.homeDir);

    const sessionPath = session?.metadata?.path || '';

    const [fileContent, setFileContent] = React.useState<FileContent | null>(null);
    const [diffContent, setDiffContent] = React.useState<string | null>(null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>('diff');
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [menuVisible, setMenuVisible] = React.useState(false);
    const wordWrap = useSetting('wrapLinesInDiffs');

    const fileName = filePath.split('/').pop() || filePath;

    // Relative path for display/copy
    const relativePath = React.useMemo(() => {
        if (sessionPath && filePath.startsWith(sessionPath + '/')) {
            return filePath.substring(sessionPath.length + 1);
        }
        return filePath;
    }, [filePath, sessionPath]);

    // Menu items
    const menuItems: ActionMenuItem[] = React.useMemo(() => {
        const items: ActionMenuItem[] = [
            {
                label: t('files.copyRelativePath'),
                onPress: async () => {
                    await Clipboard.setStringAsync(relativePath);
                    hapticsLight(); showCopiedToast();
                },
            },
            {
                label: t('files.copyFileName'),
                onPress: async () => {
                    await Clipboard.setStringAsync(fileName);
                    hapticsLight(); showCopiedToast();
                },
            },
            {
                label: t('files.share'),
                onPress: async () => {
                    const content = fileContent?.content || diffContent || '';
                    if (content) {
                        await Share.share({ title: fileName, message: content });
                    }
                },
            },
        ];

        // History: only for non-ref views (viewing current file, not a specific commit)
        if (!ref && sessionPath) {
            items.push({
                label: t('files.fileHistory'),
                onPress: () => {
                    router.push(`/session/${sessionId}/commits?file=${encodeURIComponent(relativePath)}`);
                },
            });
        }

        // Edit: only for non-ref, non-binary files
        if (!ref && fileContent && !fileContent.isBinary) {
            items.push({
                label: t('files.editFile'),
                onPress: () => {
                    const encodedPath = btoa(
                        new TextEncoder().encode(filePath).reduce((s, b) => s + String.fromCharCode(b), '')
                    );
                    router.push(`/session/${sessionId}/edit?path=${encodeURIComponent(encodedPath)}`);
                },
            });
        }

        // Delete: only for non-ref views
        if (!ref && sessionPath) {
            items.push({
                label: t('files.deleteFile'),
                destructive: true,
                onPress: async () => {
                    const confirmed = await Modal.confirm(
                        t('files.deleteFile'),
                        t('files.deleteFileConfirm', { fileName }),
                        { destructive: true },
                    );
                    if (!confirmed) return;
                    const escapedPath = shellEscape(filePath);
                    const result = await sessionBash(sessionId!, {
                        command: `rm -- ${escapedPath}`,
                        cwd: sessionPath,
                        timeout: 5000,
                    });
                    if (result.success) {
                        Modal.alert(t('common.success'), t('files.deleteFileSuccess'));
                        router.back();
                    } else {
                        Modal.alert(t('common.error'), t('files.deleteFileFailed'));
                    }
                },
            });
        }

        return items;
    }, [relativePath, fileName, fileContent, diffContent, ref, sessionPath, sessionId, filePath, router]);

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
                
                // Fetch git diff for the file
                if (sessionPath && sessionId) {
                    try {
                        const repoRelativePath = getRepoRelativePath(filePath, sessionPath);
                        const escapedPath = shellEscape(repoRelativePath);
                        const diffCommand = ref
                            ? `git diff --no-ext-diff ${shellEscape(`${ref}~1`)} ${shellEscape(ref)} -- ${escapedPath}`
                            : isStaged
                                ? `git diff --cached --no-ext-diff -- ${escapedPath}`
                                : `git diff --no-ext-diff -- ${escapedPath}`;
                        const diffResponse = await sessionBash(sessionId, {
                            command: diffCommand,
                            cwd: sessionPath,
                            timeout: 5000
                        });

                        if (!isCancelled && diffResponse.success && diffResponse.stdout.trim()) {
                            setDiffContent(diffResponse.stdout);
                        }
                    } catch (diffError) {
                        console.log('Could not fetch git diff:', diffError);
                    }
                }

                if (ref && sessionPath && sessionId) {
                    // For a specific commit ref, use git show to get file content at that revision
                    const relativePath = getRepoRelativePath(filePath, sessionPath);
                    const escapedShowTarget = shellEscape(`${ref}:${relativePath}`);
                    const showResponse = await sessionBash(sessionId, {
                        command: `git show ${escapedShowTarget}`,
                        cwd: sessionPath,
                        timeout: 10000,
                    });

                    if (!isCancelled) {
                        if (showResponse.success) {
                            setFileContent({
                                content: showResponse.stdout || '',
                                encoding: 'utf8',
                                isBinary: false,
                            });
                        } else {
                            // File may have been deleted in this commit; show diff only
                            setFileContent({ content: '', encoding: 'utf8', isBinary: false });
                        }
                    }
                } else {
                    const response = await sessionReadFile(sessionId, filePath);

                    if (!isCancelled) {
                        if (response && response.success && response.content) {
                            // Decode base64 content to UTF-8 string
                            let decodedContent: string;
                            try {
                                const binaryString = atob(response.content);
                                const bytes = new Uint8Array(binaryString.length);
                                for (let i = 0; i < binaryString.length; i++) {
                                    bytes[i] = binaryString.charCodeAt(i);
                                }
                                decodedContent = new TextDecoder('utf-8').decode(bytes);
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
                            setError(response?.error || 'Failed to read file');
                        }
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
    }, [sessionId, filePath, ref, isStaged, isBinaryFile]);

    // Show error modal if there's an error
    React.useEffect(() => {
        if (error) {
            Modal.alert(t('common.error'), error);
        }
    }, [error]);

    // Set default display mode based on diff availability
    React.useEffect(() => {
        if (preferredView === 'file' && fileContent && !fileContent.isBinary) {
            setDisplayMode('file');
        } else if (preferredView === 'diff' && diffContent) {
            setDisplayMode('diff');
        } else if (diffContent) {
            setDisplayMode('diff');
        } else if (fileContent) {
            setDisplayMode('file');
        }
    }, [diffContent, fileContent, preferredView]);

    const language = getFileLanguage(filePath);
    const editorLanguage = language || 'plaintext';
    const useReadOnlyCodeEditor = displayMode === 'file' && !!fileContent?.content;
    const handleReadOnlyEditorChange = React.useCallback(() => {
        // Viewer mode only: ignore edits.
    }, []);

    // Handle long press to open text selection screen
    const handleLongPress = React.useCallback((content: string) => {
        if (Platform.OS === 'web') return;
        try {
            const textId = storeTempText(content);
            router.push(`/text-selection?textId=${textId}`);
        } catch (error) {
            console.error('Error storing text for selection:', error);
            Modal.alert(t('common.error'), 'Failed to open text selection');
        }
    }, [router]);

    // Get current display content for long press
    const currentContent = React.useMemo(() => {
        if (displayMode === 'diff' && diffContent) {
            return diffContent;
        } else if (displayMode === 'file' && fileContent?.content) {
            return fileContent.content;
        }
        return '';
    }, [displayMode, diffContent, fileContent]);

    // Long press gesture for text selection
    const longPressGesture = React.useMemo(() =>
        Gesture.LongPress()
            .minDuration(500)
            .onStart(() => {
                if (currentContent) {
                    handleLongPress(currentContent);
                }
            })
            .runOnJS(true),
        [currentContent, handleLongPress]
    );

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
            <Stack.Screen
                options={{
                    headerRight: () => (
                        <Pressable
                            onPress={() => setMenuVisible(true)}
                            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                        >
                            <Ionicons name="ellipsis-horizontal" size={22} color={theme.colors.header.tint} />
                        </Pressable>
                    ),
                }}
            />
            <ActionMenuModal
                visible={menuVisible}
                items={menuItems}
                onClose={() => setMenuVisible(false)}
            />

            {/* File path header - single line, scrollable, long press to copy */}
            <View style={{
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHigh,
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 12,
            }}>
                <View style={{ paddingLeft: 16 }}>
                    <FileIcon fileName={fileName} size={20} />
                </View>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal: 8, paddingRight: 16, alignItems: 'center' }}
                    style={{ flex: 1 }}
                >
                    <Pressable
                        onLongPress={async () => {
                            try {
                                await Clipboard.setStringAsync(filePath);
                                hapticsLight(); showCopiedToast();
                            } catch { /* ignore */ }
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            ...Typography.mono(),
                        }} numberOfLines={1}>
                            {displayPath}
                        </Text>
                    </Pressable>
                </ScrollView>
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
            {useReadOnlyCodeEditor ? (
                <View style={{ flex: 1 }}>
                    <CodeEditor
                        value={fileContent?.content || ''}
                        onChangeText={handleReadOnlyEditorChange}
                        language={editorLanguage}
                        bottomPadding={12}
                        readOnly
                        revealLine={requestedLine}
                        revealColumn={requestedColumn}
                    />
                </View>
            ) : (
                <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={wordWrap ? { padding: 16 } : { paddingVertical: 16 }}
                    showsVerticalScrollIndicator={true}
                >
                    <ScrollView
                        horizontal={!wordWrap}
                        scrollEnabled={!wordWrap}
                        showsHorizontalScrollIndicator={!wordWrap}
                        contentContainerStyle={wordWrap ? undefined : { paddingHorizontal: 16 }}
                    >
                        {Platform.OS !== 'web' && currentContent ? (
                            <GestureDetector gesture={longPressGesture}>
                                <View>
                                    {displayMode === 'diff' && diffContent ? (
                                        <DiffDisplay diffContent={diffContent} />
                                    ) : displayMode === 'file' && fileContent?.content ? (
                                        <SimpleSyntaxHighlighter
                                            code={fileContent.content}
                                            language={language}
                                            selectable={false}
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
                                    ) : null}
                                </View>
                            </GestureDetector>
                        ) : (
                            <>
                                {displayMode === 'diff' && diffContent ? (
                                    <DiffDisplay diffContent={diffContent} />
                                ) : displayMode === 'file' && fileContent?.content ? (
                                    <SimpleSyntaxHighlighter
                                        code={fileContent.content}
                                        language={language}
                                        selectable={true}
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
                            </>
                        )}
                    </ScrollView>
                </ScrollView>
            )}
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
