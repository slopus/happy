/**
 * File view/edit overlay panel.
 * Shown in the main content area when a file is selected from the "All Files" sidebar tab.
 * Uses Pierre for viewing file content, CodeMirror for editing (web only).
 */
import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { sessionReadFile, sessionWriteFile } from '@/sync/ops';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface FileViewPanelProps {
    sessionId: string;
    filePath: string;
    onClose: () => void;
}

type FileState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'binary' }
    | { kind: 'loaded'; content: string; originalHash: string | null };

function getFileLanguage(path: string): string | null {
    const ext = path.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
        js: 'javascript', jsx: 'javascript',
        ts: 'typescript', tsx: 'typescript',
        py: 'python',
        html: 'html', htm: 'html',
        css: 'css',
        json: 'json',
        md: 'markdown',
        xml: 'xml',
        yaml: 'yaml', yml: 'yaml',
        sh: 'bash', bash: 'bash',
        sql: 'sql',
        go: 'go',
        rs: 'rust', rust: 'rust',
        java: 'java',
        c: 'c',
        cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
        php: 'php',
        rb: 'ruby',
        swift: 'swift',
        kt: 'kotlin',
        prisma: 'graphql',
        graphql: 'graphql',
        gql: 'graphql',
        toml: 'toml',
        ini: 'ini',
        env: 'bash',
        dockerfile: 'docker',
        tf: 'hcl',
        scss: 'css',
        less: 'css',
        vue: 'markup',
        svelte: 'markup',
    };
    return ext ? (map[ext] ?? null) : null;
}

function isBinaryExtension(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    const binaryExts = [
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
        'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
        'mp3', 'wav', 'flac', 'aac', 'ogg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'zip', 'tar', 'gz', 'rar', '7z',
        'exe', 'dmg', 'deb', 'rpm',
        'woff', 'woff2', 'ttf', 'otf',
        'db', 'sqlite', 'sqlite3',
    ];
    return ext ? binaryExts.includes(ext) : false;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function decodeUtf8Bytes(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

function encodeStringToBase64(str: string): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/** Compute SHA-256 hash of a UTF-8 string (matches server's crypto.createHash('sha256').update(str).digest('hex')) */
async function computeSHA256(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export const FileViewPanel = React.memo(function FileViewPanel({
    sessionId,
    filePath,
    onClose,
}: FileViewPanelProps) {
    const { theme } = useUnistyles();
    const [fileState, setFileState] = React.useState<FileState>({ kind: 'loading' });
    const [editContent, setEditContent] = React.useState('');
    const [isSaving, setIsSaving] = React.useState(false);
    const [displayMode, setDisplayMode] = React.useState<'edit' | 'preview'>('edit');

    const fileName = filePath.split('/').pop() || filePath;
    const language = getFileLanguage(filePath);
    const isMarkdown = language === 'markdown';

    const hasChanges = fileState.kind === 'loaded' && editContent !== fileState.content;

    // Load file content
    React.useEffect(() => {
        let cancelled = false;
        setFileState({ kind: 'loading' });

        if (isBinaryExtension(filePath)) {
            setFileState({ kind: 'binary' });
            return;
        }

        (async () => {
            try {
                const fileResponse = await sessionReadFile(sessionId, filePath);

                if (cancelled) return;

                if (!fileResponse.success || !fileResponse.content) {
                    setFileState({ kind: 'error', message: fileResponse.error || t('files.failedToRead') });
                    return;
                }

                let rawBytes: Uint8Array;
                let decodedContent: string;
                try {
                    rawBytes = decodeBase64ToBytes(fileResponse.content);
                    decodedContent = decodeUtf8Bytes(rawBytes);
                } catch {
                    setFileState({ kind: 'binary' });
                    return;
                }

                const hasNullBytes = rawBytes.some((byte) => byte === 0);
                const nonPrintableCount = decodedContent.split('').filter(char => {
                    const code = char.charCodeAt(0);
                    return code < 32 && code !== 9 && code !== 10 && code !== 13;
                }).length;
                if (hasNullBytes || (nonPrintableCount / decodedContent.length > 0.1)) {
                    setFileState({ kind: 'binary' });
                    return;
                }

                const hash = await computeSHA256(decodedContent);
                setFileState({ kind: 'loaded', content: decodedContent, originalHash: hash });
                setEditContent(decodedContent);
            } catch {
                if (!cancelled) {
                    setFileState({ kind: 'error', message: t('files.failedToRead') });
                }
            }
        })();

        return () => { cancelled = true; };
    }, [sessionId, filePath]);

    const handleSave = React.useCallback(async () => {
        if (fileState.kind !== 'loaded' || !hasChanges) return;
        setIsSaving(true);

        try {
            const base64 = encodeStringToBase64(editContent);
            const response = await sessionWriteFile(
                sessionId,
                filePath,
                base64,
                fileState.originalHash,
            );

            if (!response.success) {
                if (response.error?.includes('hash') || response.error?.includes('mismatch')) {
                    Modal.alert(
                        t('files.fileConflict'),
                        t('files.fileConflictDescription'),
                        [
                            { text: t('files.reload'), onPress: () => {
                                setFileState({ kind: 'loading' });
                            }},
                            { text: t('common.cancel'), style: 'cancel' },
                        ]
                    );
                } else {
                    Modal.alert(t('common.error'), response.error || t('files.failedToSave'));
                }
                return;
            }

            // Update original content + hash to match saved state
            setFileState({
                kind: 'loaded',
                content: editContent,
                originalHash: response.hash ?? null,
            });
        } finally {
            setIsSaving(false);
        }
    }, [sessionId, filePath, editContent, fileState, hasChanges]);

    return (
        <View style={[styles.outer, { backgroundColor: theme.colors.surface }]}>
            {/* Top bar */}
            <View style={[styles.topBar, { backgroundColor: theme.colors.surfaceHigh, borderBottomColor: theme.colors.divider }]}>
                <FileIcon fileName={fileName} size={18} />
                <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={[styles.topBarPath, { color: theme.colors.text }]}
                >
                    {filePath}
                </Text>
                <View style={{ flex: 1 }} />
                {/* Edit/Preview toggle for markdown */}
                {isMarkdown && fileState.kind === 'loaded' && (
                    <View style={styles.toggleRow}>
                        <Pressable
                            onPress={() => setDisplayMode('edit')}
                            style={[
                                styles.toggleButton,
                                displayMode === 'edit' && { backgroundColor: theme.colors.surface },
                            ]}
                        >
                            <Text style={[
                                styles.toggleText,
                                displayMode === 'edit' && styles.toggleTextActive,
                            ]}>
                                {t('files.editFile')}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => setDisplayMode('preview')}
                            style={[
                                styles.toggleButton,
                                displayMode === 'preview' && { backgroundColor: theme.colors.surface },
                            ]}
                        >
                            <Text style={[
                                styles.toggleText,
                                displayMode === 'preview' && styles.toggleTextActive,
                            ]}>
                                Preview
                            </Text>
                        </Pressable>
                    </View>
                )}
                {fileState.kind === 'loaded' && (
                    <Pressable
                        onPress={handleSave}
                        disabled={!hasChanges || isSaving}
                        style={({ pressed }) => [
                            styles.actionButton,
                            {
                                backgroundColor: hasChanges ? theme.colors.textLink : theme.colors.input.background,
                                opacity: !hasChanges ? 0.4 : isSaving ? 0.6 : pressed ? 0.8 : 1,
                            },
                        ]}
                    >
                        {isSaving ? (
                            <ActivityIndicator size="small" color="white" />
                        ) : (
                            <Text style={[
                                hasChanges ? styles.actionButtonText : styles.actionButtonTextSecondary,
                                !hasChanges && { color: theme.colors.textSecondary },
                            ]}>
                                {t('files.saveFile')}
                            </Text>
                        )}
                    </Pressable>
                )}
                <Pressable onPress={onClose} hitSlop={15} style={styles.closeButton}>
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            {/* Content */}
            {fileState.kind === 'loading' ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : fileState.kind === 'error' ? (
                <View style={styles.centered}>
                    <Ionicons name="alert-circle-outline" size={32} color={theme.colors.textDestructive} />
                    <Text style={{ color: theme.colors.textSecondary, marginTop: 8, ...Typography.default() }}>
                        {fileState.message}
                    </Text>
                </View>
            ) : fileState.kind === 'binary' ? (
                <View style={styles.centered}>
                    <Ionicons name="document-outline" size={32} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.textSecondary, marginTop: 8, ...Typography.default() }}>
                        {t('files.binaryFile')}
                    </Text>
                </View>
            ) : isMarkdown && displayMode === 'preview' ? (
                <ScrollView
                    style={{ flex: 1, backgroundColor: theme.dark ? '#1e1e1e' : '#ffffff' }}
                    contentContainerStyle={{ padding: 16 }}
                >
                    {Platform.OS === 'web' && <EditorPreviewStyles />}
                    <View {...(Platform.OS === 'web' ? { className: 'editor-preview-wrap' } as any : {})}>
                        <MarkdownView markdown={editContent} sessionId={sessionId} />
                    </View>
                </ScrollView>
            ) : (
                <EditorView
                    value={editContent}
                    onChange={setEditContent}
                    language={language}
                />
            )}
        </View>
    );
});

/** CSS overrides to make MarkdownView match the editor look (web only) */
const EditorPreviewStyles = React.memo(function EditorPreviewStyles() {
    React.useEffect(() => {
        const id = 'editor-preview-styles';
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        el.textContent = `
.editor-preview-wrap div[dir] {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Monaco, Consolas, monospace !important;
    font-size: 14px !important;
    line-height: 1.5 !important;
}
.editor-preview-wrap div[dir] div[style*="background"] {
    border-radius: 6px;
}
`;
        return () => {
            // Don't remove — other instances might still be mounted
        };
    }, []);
    return null;
});

/**
 * Lazy-loads the CodeEditor (web-only CodeMirror wrapper).
 * On native this renders the fallback stub.
 */
const EditorView = React.memo(function EditorView({
    value,
    onChange,
    language,
}: {
    value: string;
    onChange: (v: string) => void;
    language: string | null;
}) {
    const { theme } = useUnistyles();
    const [EditorComponent, setEditorComponent] = React.useState<React.ComponentType<any> | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        // Dynamic import to keep native bundle clean
        import('@/components/CodeEditor').then((mod) => {
            setEditorComponent(() => mod.CodeEditor);
        });
    }, []);

    if (!EditorComponent) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <View style={{ flex: 1 }}>
            <EditorComponent
                value={value}
                onChange={onChange}
                language={language}
                darkMode={theme.dark}
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    outer: {
        flex: 1,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
    },
    topBarPath: {
        fontSize: 13,
        maxWidth: '50%',
        ...Typography.mono(),
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
    },
    actionButtonText: {
        fontSize: 13,
        fontWeight: '600',
        color: 'white',
        ...Typography.default('semiBold'),
    },
    actionButtonTextSecondary: {
        fontSize: 13,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    closeButton: {
        padding: 4,
    },
    toggleRow: {
        flexDirection: 'row',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        marginRight: 4,
    },
    toggleButton: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
    },
    toggleText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    toggleTextActive: {
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
}));
