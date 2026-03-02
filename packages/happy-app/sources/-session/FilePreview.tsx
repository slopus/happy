import React from 'react';
import { View, Text, Pressable, ScrollView, Platform } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import * as Clipboard from 'expo-clipboard';

interface FilePreviewProps {
    fileName: string;
    filePath: string;
    content: string;
    base64Content?: string;
    onClose: () => void;
    /** For gallery navigation: call to load adjacent file */
    onNavigate?: (direction: 'prev' | 'next') => void;
    /** Gallery position info: "3 / 12" */
    galleryPosition?: string;
}

const CODE_EXTENSIONS: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.r': 'r',
    '.sql': 'sql',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.html': 'html', '.htm': 'html',
    '.xml': 'xml', '.svg': 'xml',
    '.json': 'json',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml',
    '.ini': 'ini', '.conf': 'ini',
    '.dockerfile': 'dockerfile',
    '.graphql': 'graphql', '.gql': 'graphql',
    '.lua': 'lua',
    '.dart': 'dart',
    '.vue': 'vue',
    '.prisma': 'prisma',
    '.proto': 'protobuf',
    '.tf': 'hcl',
    '.zig': 'zig',
    '.ex': 'elixir', '.exs': 'elixir',
    '.erl': 'erlang',
    '.hs': 'haskell',
    '.ml': 'ocaml',
    '.clj': 'clojure',
    '.el': 'lisp',
    '.vim': 'vim',
    '.cmake': 'cmake',
    '.makefile': 'makefile',
    '.gitignore': 'text',
    '.env': 'text',
};

const MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
const PDF_EXTENSIONS = ['.pdf'];

export type FileType = 'markdown' | 'code' | 'image' | 'audio' | 'video' | 'pdf' | 'text';

export function getFileType(fileName: string): FileType {
    const lower = fileName.toLowerCase();

    if (MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'markdown';
    if (PDF_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'pdf';

    const ext = '.' + lower.split('.').pop();
    if (CODE_EXTENSIONS[ext]) return 'code';

    const baseName = lower.split('/').pop() || '';
    if (['makefile', 'dockerfile', 'jenkinsfile', 'vagrantfile', 'gemfile', 'rakefile'].includes(baseName)) return 'code';

    if (IMAGE_EXTENSIONS.some(e => lower.endsWith(e))) return 'image';
    if (AUDIO_EXTENSIONS.some(e => lower.endsWith(e))) return 'audio';
    if (VIDEO_EXTENSIONS.some(e => lower.endsWith(e))) return 'video';

    return 'text';
}

function getLanguage(fileName: string): string | null {
    const lower = fileName.toLowerCase();
    const ext = '.' + lower.split('.').pop();
    if (CODE_EXTENSIONS[ext]) return CODE_EXTENSIONS[ext];

    const baseName = lower.split('/').pop() || '';
    if (baseName === 'makefile') return 'makefile';
    if (baseName === 'dockerfile') return 'dockerfile';

    return null;
}

function getMimeType(fileName: string): string {
    const lower = fileName.toLowerCase();
    const ext = lower.split('.').pop() || '';
    const mimeMap: Record<string, string> = {
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
        'ico': 'image/x-icon', 'svg': 'image/svg+xml',
        'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
        'm4a': 'audio/mp4', 'aac': 'audio/aac', 'flac': 'audio/flac',
        'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
        'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska',
        'pdf': 'application/pdf',
    };
    return mimeMap[ext] || 'application/octet-stream';
}

export function isBinaryFileType(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...PDF_EXTENSIONS].some(e => lower.endsWith(e));
}

export function isImageFile(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return IMAGE_EXTENSIONS.some(e => lower.endsWith(e));
}

export const FilePreview: React.FC<FilePreviewProps> = ({
    fileName,
    filePath,
    content,
    base64Content,
    onClose,
    onNavigate,
    galleryPosition,
}) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const fileType = getFileType(fileName);
    const language = getLanguage(fileName);

    const handleCopy = () => {
        Clipboard.setStringAsync(content);
    };

    // Keyboard navigation for gallery
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !onNavigate) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') { onNavigate('prev'); e.preventDefault(); }
            if (e.key === 'ArrowRight') { onNavigate('next'); e.preventDefault(); }
            if (e.key === 'Escape') { onClose(); e.preventDefault(); }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onNavigate, onClose]);

    const lineCount = content.split('\n').length;
    const charCount = content.length;
    const mime = getMimeType(fileName);
    const isMedia = fileType === 'image' || fileType === 'audio' || fileType === 'video' || fileType === 'pdf';

    const renderMedia = () => {
        if (!base64Content) {
            return (
                <View style={{ alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                    <Ionicons name="document-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginTop: 12 }}>
                        No preview data available
                    </Text>
                </View>
            );
        }

        if (fileType === 'image') {
            return (
                <View style={{ flex: 1, position: 'relative' }}>
                    <Image
                        source={{ uri: `data:${mime};base64,${base64Content}` }}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="contain"
                    />
                    {/* Gallery navigation arrows */}
                    {onNavigate && (
                        <>
                            <Pressable
                                onPress={() => onNavigate('prev')}
                                style={{
                                    position: 'absolute', left: 8, top: '50%', marginTop: -24,
                                    width: 48, height: 48, borderRadius: 24,
                                    backgroundColor: 'rgba(0,0,0,0.5)',
                                    alignItems: 'center', justifyContent: 'center',
                                }}
                            >
                                <Ionicons name="chevron-back" size={28} color="#fff" />
                            </Pressable>
                            <Pressable
                                onPress={() => onNavigate('next')}
                                style={{
                                    position: 'absolute', right: 8, top: '50%', marginTop: -24,
                                    width: 48, height: 48, borderRadius: 24,
                                    backgroundColor: 'rgba(0,0,0,0.5)',
                                    alignItems: 'center', justifyContent: 'center',
                                }}
                            >
                                <Ionicons name="chevron-forward" size={28} color="#fff" />
                            </Pressable>
                        </>
                    )}
                </View>
            );
        }

        if (fileType === 'pdf' && Platform.OS === 'web') {
            return (
                <View style={{ flex: 1 }}>
                    <iframe
                        src={`data:application/pdf;base64,${base64Content}`}
                        style={{ width: '100%', height: '100%', border: 'none' } as any}
                        title={fileName}
                    />
                </View>
            );
        }

        if (fileType === 'pdf') {
            return (
                <View style={{ alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                    <Ionicons name="document-text-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginTop: 12 }}>
                        PDF preview available on web only
                    </Text>
                </View>
            );
        }

        if (fileType === 'audio' && Platform.OS === 'web') {
            return (
                <View style={{ alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                    <Ionicons name="musical-notes" size={48} color={theme.colors.textSecondary} style={{ marginBottom: 20 }} />
                    <audio controls src={`data:${mime};base64,${base64Content}`} style={{ width: '100%', maxWidth: 400 } as any} />
                </View>
            );
        }

        if (fileType === 'video' && Platform.OS === 'web') {
            return (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <video
                        controls
                        src={`data:${mime};base64,${base64Content}`}
                        style={{ width: '100%', maxWidth: 800, maxHeight: '80%', borderRadius: 8 } as any}
                    />
                </View>
            );
        }

        return (
            <View style={{ alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                <Ionicons name={fileType === 'audio' ? 'musical-notes-outline' : 'videocam-outline'} size={48} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginTop: 12 }}>
                    {fileType === 'audio' ? 'Audio' : 'Video'} preview available on web only
                </Text>
            </View>
        );
    };

    return (
        <View style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: fileType === 'image' ? '#000' : theme.colors.surface,
            zIndex: 3000,
        }}>
            {/* Header */}
            <View style={{
                paddingTop: insets.top + 8,
                paddingHorizontal: 16,
                paddingBottom: 10,
                borderBottomWidth: fileType === 'image' ? 0 : 1,
                borderBottomColor: theme.colors.divider,
                backgroundColor: fileType === 'image' ? 'rgba(0,0,0,0.7)' : theme.colors.surface,
                zIndex: 1,
            }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Pressable onPress={onClose} hitSlop={15} style={{ marginRight: 12 }}>
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={24}
                            color={fileType === 'image' ? '#fff' : theme.colors.text}
                        />
                    </Pressable>
                    <View style={{ flex: 1 }}>
                        <Text
                            numberOfLines={1}
                            style={{
                                fontSize: 15,
                                color: fileType === 'image' ? '#fff' : theme.colors.text,
                                ...Typography.default('semiBold'),
                            }}
                        >
                            {fileName}
                        </Text>
                        <Text style={{
                            fontSize: 11,
                            color: fileType === 'image' ? 'rgba(255,255,255,0.6)' : theme.colors.textSecondary,
                            marginTop: 2,
                        }}>
                            {galleryPosition
                                ? galleryPosition
                                : isMedia
                                    ? mime
                                    : `${lineCount} lines · ${charCount > 1024 ? `${(charCount / 1024).toFixed(1)} KB` : `${charCount} B`}${language ? ` · ${language}` : ''}`
                            }
                        </Text>
                    </View>
                    {!isMedia && (
                        <Pressable
                            onPress={handleCopy}
                            hitSlop={10}
                            style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <Ionicons name="copy-outline" size={18} color={theme.colors.text} style={{ opacity: 0.6 }} />
                        </Pressable>
                    )}
                </View>
            </View>

            {/* Content */}
            {isMedia ? (
                renderMedia()
            ) : (
                <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{
                        padding: fileType === 'markdown' ? 16 : 0,
                        paddingBottom: insets.bottom + 40,
                    }}
                >
                    {fileType === 'markdown' ? (
                        <MarkdownView markdown={content} />
                    ) : fileType === 'code' ? (
                        <View style={{ padding: 12, backgroundColor: theme.colors.background }}>
                            <SimpleSyntaxHighlighter code={content} language={language} selectable={true} />
                        </View>
                    ) : (
                        <View style={{ padding: 12, backgroundColor: theme.colors.background }}>
                            <Text selectable style={{ fontSize: 13, lineHeight: 20, color: theme.colors.text, ...Typography.mono() }}>
                                {content}
                            </Text>
                        </View>
                    )}
                </ScrollView>
            )}
        </View>
    );
};
