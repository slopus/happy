import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { HtmlContent } from '@/components/dootask/HtmlContent';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

// --- Constants ---

const AVATAR_SIZE = 36;
const AVATAR_GAP = 10;
const CONTENT_LEFT = AVATAR_SIZE + AVATAR_GAP;
const AVATAR_PLACEHOLDER_COLORS = [
    '#E57373', '#F06292', '#BA68C8', '#9575CD',
    '#7986CB', '#64B5F6', '#4FC3F7', '#4DD0E1',
    '#4DB6AC', '#81C784', '#AED581', '#FFD54F',
    '#FFB74D', '#FF8A65', '#A1887F', '#90A4AE',
];

// --- Helpers ---

function getMsgText(msg: DooTaskDialogMsg): string {
    if (typeof msg.msg === 'string') return msg.msg;
    if (msg.msg?.text) return msg.msg.text;
    return '';
}

/** Strip HTML tags from chat message text, converting block elements to newlines. */
function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getMsgImageUrl(msg: DooTaskDialogMsg, serverUrl: string): string | null {
    const path = msg.msg?.path || msg.msg?.url || msg.msg?.thumb || null;
    if (!path) return null;
    if (path.startsWith('http')) return path;
    return serverUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAvatarColor(userId: number): string {
    return AVATAR_PLACEHOLDER_COLORS[userId % AVATAR_PLACEHOLDER_COLORS.length];
}

/** Extract HH:mm from a datetime string like "2026-02-22 10:30:00" */
function formatTime(createdAt: string): string {
    const match = createdAt.match(/(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : '';
}

// --- Props ---

type ChatBubbleProps = {
    msg: DooTaskDialogMsg;
    currentUserId: number;
    senderName?: string;
    avatarUrl?: string | null;
    showAvatar: boolean;
    replyMsg?: DooTaskDialogMsg | null;
    replySenderName?: string;
    onImagePress?: (url: string) => void;
    onLongPress?: (msg: DooTaskDialogMsg) => void;
    serverUrl: string;
};

// --- Content Renderers ---

/** Check if HTML contains complex elements that need WebView rendering. */
const COMPLEX_HTML_RE = /<(table|img|pre|code|ul|ol|li|h[1-6]|iframe|video|audio|blockquote|div\s+class|\.tox-checklist)/i;

function TextContent({ msg, theme, onImagePress }: { msg: DooTaskDialogMsg; theme: any; onImagePress?: (url: string) => void }) {
    const text = getMsgText(msg);
    const isHtml = (typeof msg.msg === 'object' && msg.msg?.type === 'html') || /<[^>]+>/.test(text);
    // Only use WebView for complex HTML (tables, code blocks, images, lists, etc.)
    // Simple HTML (br, p, b, i, a, span) is stripped and rendered natively for instant display
    if (isHtml && COMPLEX_HTML_RE.test(text)) {
        return <HtmlContent html={text} theme={theme} onImagePress={onImagePress} />;
    }
    return (
        <Text style={[styles.msgText, { color: theme.colors.text }]}>
            {isHtml ? stripHtml(text) : text}
        </Text>
    );
}

function ImageContent({ msg, serverUrl, onImagePress }: { msg: DooTaskDialogMsg; serverUrl: string; onImagePress?: (url: string) => void }) {
    const imageUrl = getMsgImageUrl(msg, serverUrl);
    if (!imageUrl) return null;
    return (
        <Pressable onPress={() => onImagePress?.(imageUrl)} style={styles.imageWrapper}>
            <Image
                source={{ uri: imageUrl }}
                style={{ width: 260, height: 180, borderRadius: 8 }}
                contentFit="cover"
            />
        </Pressable>
    );
}

function FileContent({ msg, serverUrl, theme }: { msg: DooTaskDialogMsg; serverUrl: string; theme: any }) {
    const fileName = msg.msg?.name || '';
    const fileSize = msg.msg?.size ? formatFileSize(msg.msg.size) : '';
    const filePath = msg.msg?.path || msg.msg?.url || '';
    const fileUrl = filePath
        ? (filePath.startsWith('http') ? filePath : serverUrl.replace(/\/+$/, '') + '/' + filePath.replace(/^\/+/, ''))
        : null;
    return (
        <Pressable
            style={[styles.fileCard, { backgroundColor: theme.colors.surfaceHigh }]}
            onPress={() => { if (fileUrl) WebBrowser.openBrowserAsync(fileUrl); }}
        >
            <View style={[styles.fileIconCircle, { backgroundColor: theme.colors.surfaceHighest }]}>
                <Ionicons name="document-outline" size={20} color={theme.colors.textSecondary} />
            </View>
            <View style={styles.fileInfo}>
                <Text style={[styles.fileName, { color: theme.colors.text }]} numberOfLines={1}>
                    {fileName}
                </Text>
                {fileSize ? (
                    <Text style={[styles.fileSize, { color: theme.colors.textSecondary }]}>
                        {fileSize}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    );
}

// --- Component ---

export const ChatBubble = React.memo(({
    msg,
    currentUserId,
    senderName,
    avatarUrl,
    showAvatar,
    replyMsg,
    replySenderName,
    onImagePress,
    onLongPress,
    serverUrl,
}: ChatBubbleProps) => {
    const { theme } = useUnistyles();
    const isSelf = msg.userid === currentUserId;
    const time = formatTime(msg.created_at);

    // Notice messages: centered, no layout change
    if (msg.type === 'notice') {
        return (
            <View style={styles.noticeContainer}>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                    {stripHtml(getMsgText(msg))}
                </Text>
            </View>
        );
    }

    // Reply quote block
    const replyBlock = replyMsg ? (
        <View style={[styles.replyQuote, { borderLeftColor: theme.colors.textLink }]}>
            {replySenderName ? (
                <Text style={[styles.replySender, { color: theme.colors.textLink }]} numberOfLines={1}>
                    {replySenderName}
                </Text>
            ) : null}
            <Text style={[styles.replyText, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                {stripHtml(getMsgText(replyMsg))}
            </Text>
        </View>
    ) : null;

    // Render content based on message type
    let content: React.ReactNode = null;
    switch (msg.type) {
        case 'text':
            content = <TextContent msg={msg} theme={theme} onImagePress={onImagePress} />;
            break;
        case 'image':
            content = <ImageContent msg={msg} serverUrl={serverUrl} onImagePress={onImagePress} />;
            break;
        case 'file':
            content = <FileContent msg={msg} serverUrl={serverUrl} theme={theme} />;
            break;
        case 'record':
        case 'meeting':
        case 'longtext':
        case 'template':
        default:
            content = (
                <Text style={[styles.unsupportedText, { color: theme.colors.textSecondary }]}>
                    {t('dootask.unsupportedMessage')}
                </Text>
            );
            break;
    }

    // --- Self messages: right-aligned with subtle background band ---
    if (isSelf) {
        return (
            <Pressable
                onLongPress={() => onLongPress?.(msg)}
                style={[styles.selfBand, { backgroundColor: theme.colors.surfaceHigh }]}
            >
                <View style={styles.selfContent}>
                    {replyBlock}
                    {content}
                    {time ? (
                        <Text style={[styles.selfTime, { color: theme.colors.textSecondary }]}>
                            {time}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    // --- Others' messages: Slack-style flat layout ---
    const initial = (senderName || '?')[0].toUpperCase();
    const avatarBg = getAvatarColor(msg.userid);

    return (
        <Pressable
            onLongPress={() => onLongPress?.(msg)}
            style={styles.otherRow}
        >
            {/* Avatar column */}
            <View style={styles.avatarColumn}>
                {showAvatar ? (
                    avatarUrl ? (
                        <Image
                            source={{ uri: avatarUrl }}
                            style={{ width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2 }}
                        />
                    ) : (
                        <View style={[styles.avatarPlaceholder, { backgroundColor: avatarBg }]}>
                            <Text style={styles.avatarInitial}>{initial}</Text>
                        </View>
                    )
                ) : null}
            </View>

            {/* Content column */}
            <View style={styles.otherContent}>
                {/* Header: name + time (only on first message of a group) */}
                {showAvatar && (
                    <View style={styles.headerRow}>
                        {senderName ? (
                            <Text style={[styles.senderName, { color: avatarBg }]}>
                                {senderName}
                            </Text>
                        ) : null}
                        {time ? (
                            <Text style={[styles.headerTime, { color: theme.colors.textSecondary }]}>
                                {time}
                            </Text>
                        ) : null}
                    </View>
                )}
                {replyBlock}
                {content}
            </View>
        </Pressable>
    );
});

// --- Styles ---

const styles = StyleSheet.create((theme) => ({
    // --- Others' messages (Slack flat layout) ---
    otherRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: theme.margins.lg,
        paddingVertical: 1,
    },
    avatarColumn: {
        width: AVATAR_SIZE,
        marginRight: AVATAR_GAP,
        alignItems: 'center',
        justifyContent: 'flex-start',
    },
    avatarPlaceholder: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarInitial: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: '#FFFFFF',
    },
    otherContent: {
        flex: 1,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.margins.sm,
        marginBottom: 2,
    },
    senderName: {
        ...Typography.default('semiBold'),
        fontSize: 15,
    },
    headerTime: {
        ...Typography.default(),
        fontSize: 12,
    },

    // --- Self messages (right-aligned background band) ---
    selfBand: {
        paddingVertical: theme.margins.sm,
        paddingLeft: CONTENT_LEFT + theme.margins.lg,
        paddingRight: theme.margins.lg,
    },
    selfContent: {
        alignItems: 'flex-end',
    },
    selfTime: {
        ...Typography.default(),
        fontSize: 11,
        marginTop: 2,
    },

    // --- Shared content styles ---
    msgText: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 22,
    },
    replyQuote: {
        borderLeftWidth: 3,
        paddingLeft: theme.margins.sm,
        marginBottom: theme.margins.xs,
    },
    replySender: {
        ...Typography.default('semiBold'),
        fontSize: 12,
    },
    replyText: {
        ...Typography.default(),
        fontSize: 13,
    },

    // --- Image ---
    imageWrapper: {
        marginTop: theme.margins.xs,
    },

    // --- File card ---
    fileCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.md,
        paddingHorizontal: theme.margins.md,
        paddingVertical: theme.margins.sm,
        borderRadius: theme.borderRadius.md,
        marginTop: theme.margins.xs,
        maxWidth: 280,
    },
    fileIconCircle: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    fileInfo: {
        flex: 1,
    },
    fileName: {
        ...Typography.default('semiBold'),
        fontSize: 14,
    },
    fileSize: {
        ...Typography.default(),
        fontSize: 12,
        marginTop: 1,
    },

    // --- Notice ---
    noticeContainer: {
        alignItems: 'center',
        paddingVertical: theme.margins.sm,
        paddingHorizontal: theme.margins.lg,
    },
    noticeText: {
        ...Typography.default(),
        fontSize: 12,
        textAlign: 'center',
    },

    // --- Unsupported ---
    unsupportedText: {
        ...Typography.default('italic'),
        fontSize: 13,
    },
}));
