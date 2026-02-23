import * as React from 'react';
import { View, Text, Pressable, Platform, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { HtmlContent } from '@/components/dootask/HtmlContent';
import type { DooTaskDialogMsg, PendingMessageStatus, EmojiReaction } from '@/sync/dootask/types';
import { useDootaskAudioPlayer } from '@/hooks/useAudioPlayer';

// --- AI Assistant ---

const AI_ASSISTANT_USERID = -1;
const AI_AVATAR_COLOR = '#7C4DFF';

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

/** Detect if text content is purely 1-3 emoji characters (for large emoji display). */
const EMOJI_RE = /^(?:\p{Extended_Pictographic}[\u{FE0F}\u{200D}\u{20E3}]*){1,3}$/u;
function getEmojiCount(text: string): number {
    const stripped = text.replace(/<\/?p>/gi, '').trim();
    if (!EMOJI_RE.test(stripped)) return 0;
    const emojis = [...stripped.matchAll(/\p{Extended_Pictographic}[\u{FE0F}\u{200D}\u{20E3}]*/gu)];
    return emojis.length;
}
const EMOJI_SIZES = [0, 36, 32, 28]; // index = count

/** Replace DooTask's {{RemoteURL}} placeholder and resolve relative paths to absolute URLs. */
function resolveUrl(raw: string, serverUrl: string): string {
    const base = serverUrl.replace(/\/+$/, '') + '/';
    const resolved = raw.replace(/\{\{RemoteURL\}\}/g, base);
    if (resolved.startsWith('http') || resolved.startsWith('//') || resolved.startsWith('data:')) return resolved;
    return base + resolved.replace(/^\/+/, '');
}

// --- Native Markdown Renderer ---
// Renders markdown as native React Native components (Text/View) so they
// naturally participate in flex layout — right-aligning in self-message bubbles,
// sizing to content, and rendering instantly without WebView overhead.

const HEADER_SIZES = [24, 20, 18, 16, 15, 14]; // h1–h6
const MONO_FONT = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Parse inline markdown (bold, italic, code, links, strikethrough) into Text elements */
function renderInline(text: string, theme: any, keyPrefix: string = ''): React.ReactNode {
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let idx = 0;

    // Order matters: bold-italic before bold before italic, image before link
    const re = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|`([^`]+?)`|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|~~(.+?)~~)/;

    while (remaining) {
        const match = remaining.match(re);
        if (!match || match.index === undefined) {
            if (remaining) parts.push(remaining);
            break;
        }
        if (match.index > 0) {
            parts.push(remaining.substring(0, match.index));
        }
        const key = `${keyPrefix}-${idx++}`;
        if (match[2]) {
            parts.push(<Text key={key} style={{ fontWeight: '700', fontStyle: 'italic' }}>{renderInline(match[2], theme, key)}</Text>);
        } else if (match[3]) {
            parts.push(<Text key={key} style={{ fontWeight: '700' }}>{renderInline(match[3], theme, key)}</Text>);
        } else if (match[4]) {
            parts.push(<Text key={key} style={{ fontStyle: 'italic' }}>{renderInline(match[4], theme, key)}</Text>);
        } else if (match[5]) {
            parts.push(<Text key={key} style={{ fontFamily: MONO_FONT, backgroundColor: theme.colors.surfaceHighest || '#2a2a2a', fontSize: 13 }}>{match[5]}</Text>);
        } else if (match[6] !== undefined && match[7]) {
            // ![alt](url) — inline image reference, show as link text
            parts.push(<Text key={key} style={{ color: '#0A84FF' }}>{match[6] || 'image'}</Text>);
        } else if (match[8] && match[9]) {
            parts.push(<Text key={key} style={{ color: '#0A84FF' }}>{match[8]}</Text>);
        } else if (match[10]) {
            parts.push(<Text key={key} style={{ textDecorationLine: 'line-through' as const }}>{match[10]}</Text>);
        }
        remaining = remaining.substring(match.index + match[0].length);
    }
    return parts.length === 1 ? parts[0] : <>{parts}</>;
}

/** Render markdown text as native React Native components */
function MarkdownContent({ text, theme, serverUrl, onImagePress }: {
    text: string; theme: any; serverUrl: string; onImagePress?: (url: string) => void;
}) {
    const elements: React.ReactNode[] = [];
    let processed = text;

    // Strip DooTask :::ai-action{...}::: directives — extract status labels
    processed = processed.replace(/:::ai-action\{([^}]+)\}:::/g, (_m, attrs: string) => {
        if (/status="applied"/.test(attrs)) return '\u2713 Adopted';
        if (/status="dismissed"/.test(attrs)) return '\u2717 Dismissed';
        return '';
    });

    // Strip :::reasoning...:::  blocks (AI thinking — not useful in mobile)
    processed = processed.replace(/:::\s*reasoning\s*\n?([\s\S]*?):::/g, '');
    processed = processed.replace(/:::\s*reasoning\s*[\r\n]*\s*:::/g, '');

    // Split into code-block vs text segments
    type Block = { type: 'code'; lang: string; content: string } | { type: 'text'; content: string };
    const blocks: Block[] = [];
    const codeRe = /```(\w*)\n?([\s\S]*?)```/g;
    let lastIdx = 0;
    let cm;
    while ((cm = codeRe.exec(processed)) !== null) {
        if (cm.index > lastIdx) blocks.push({ type: 'text', content: processed.substring(lastIdx, cm.index) });
        blocks.push({ type: 'code', lang: cm[1], content: cm[2].trimEnd() });
        lastIdx = cm.index + cm[0].length;
    }
    if (lastIdx < processed.length) blocks.push({ type: 'text', content: processed.substring(lastIdx) });

    let ki = 0;
    for (const block of blocks) {
        if (block.type === 'code') {
            elements.push(
                <View key={ki++} style={mdStyles.codeBlock(theme)}>
                    {block.lang ? <Text style={mdStyles.codeLang(theme)}>{block.lang}</Text> : null}
                    <Text style={mdStyles.codeText(theme)}>{block.content}</Text>
                </View>,
            );
            continue;
        }

        const lines = block.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) {
                if (i > 0 && i < lines.length - 1) elements.push(<View key={ki++} style={{ height: 6 }} />);
                continue;
            }

            // Header
            const hm = line.match(/^(#{1,6})\s+(.+)$/);
            if (hm) {
                const level = hm[1].length;
                elements.push(
                    <Text key={ki++} style={[styles.msgText, { color: theme.colors.text, fontSize: HEADER_SIZES[level - 1], fontWeight: '700', lineHeight: HEADER_SIZES[level - 1] * 1.4 }]}>
                        {renderInline(hm[2], theme, `h${ki}`)}
                    </Text>,
                );
                continue;
            }

            // Horizontal rule
            if (/^---+$/.test(line.trim())) {
                elements.push(<View key={ki++} style={{ height: 1, backgroundColor: theme.colors.divider || '#333', marginVertical: 8 }} />);
                continue;
            }

            // Blockquote
            const bq = line.match(/^>\s+(.+)$/);
            if (bq) {
                elements.push(
                    <View key={ki++} style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.divider || '#333', paddingLeft: 8, marginVertical: 2 }}>
                        <Text style={[styles.msgText, { color: theme.colors.textSecondary }]}>{renderInline(bq[1], theme, `q${ki}`)}</Text>
                    </View>,
                );
                continue;
            }

            // Unordered list
            const ul = line.match(/^[-*+]\s+(.+)$/);
            if (ul) {
                elements.push(<Text key={ki++} style={[styles.msgText, { color: theme.colors.text }]}>{'  \u2022 '}{renderInline(ul[1], theme, `u${ki}`)}</Text>);
                continue;
            }

            // Ordered list
            const ol = line.match(/^(\d+)\.\s+(.+)$/);
            if (ol) {
                elements.push(<Text key={ki++} style={[styles.msgText, { color: theme.colors.text }]}>{`  ${ol[1]}. `}{renderInline(ol[2], theme, `o${ki}`)}</Text>);
                continue;
            }

            // Image on its own line
            const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
            if (img) {
                const imgUrl = resolveUrl(img[2].replace(/\{\{RemoteURL\}\}/g, serverUrl.replace(/\/+$/, '') + '/'), serverUrl);
                elements.push(
                    <Pressable key={ki++} onPress={() => onImagePress?.(imgUrl)} style={{ marginVertical: 4 }}>
                        <Image source={{ uri: imgUrl }} style={{ width: 260, height: 180, borderRadius: 8 }} contentFit="cover" />
                    </Pressable>,
                );
                continue;
            }

            // Regular text
            elements.push(<Text key={ki++} style={[styles.msgText, { color: theme.colors.text }]}>{renderInline(line, theme, `t${ki}`)}</Text>);
        }
    }

    if (elements.length === 0) {
        return <Text style={[styles.msgText, { color: theme.colors.text }]}>{text}</Text>;
    }
    if (elements.length === 1) return <>{elements}</>;
    return <View>{elements}</View>;
}

// Inline style helpers for MarkdownContent (can't use StyleSheet.create for dynamic theme)
const mdStyles = {
    codeBlock: (theme: any) => ({
        backgroundColor: theme.colors.surfaceHighest || '#2a2a2a',
        borderRadius: 4,
        padding: 12,
        marginVertical: 4,
    }),
    codeLang: (theme: any) => ({
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginBottom: 4,
    }),
    codeText: (theme: any) => ({
        fontFamily: MONO_FONT,
        fontSize: 13,
        color: theme.colors.text,
        lineHeight: 18,
    }),
} as const;

/** Replace {{RemoteURL}} placeholders in HTML content so images and links resolve correctly. */
export function resolveContentUrls(html: string, serverUrl: string): string {
    const base = serverUrl.replace(/\/+$/, '') + '/';
    return html.replace(/\{\{RemoteURL\}\}/g, base);
}

/** Strip thumbnail suffix and crop params to get the original image URL (mirrors DooTask's thumbRestore). */
export function thumbRestore(url: string): string {
    return url
        .replace(/_thumb\.(png|jpg|jpeg)$/, '')
        .replace(/\/crop\/([^/]+)$/, '');
}

function getMsgImageUrl(msg: DooTaskDialogMsg, serverUrl: string): string | null {
    const path = msg.msg?.path || msg.msg?.url || msg.msg?.thumb || null;
    if (!path) return null;
    return resolveUrl(path, serverUrl);
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
    disabledAt?: string | null;
    showAvatar: boolean;
    replyMsg?: DooTaskDialogMsg | null;
    replySenderName?: string;
    onImagePress?: (url: string) => void;
    onLongPress?: (msg: DooTaskDialogMsg, layout?: { y: number; height: number }) => void;
    onEmojiPress?: (msgId: number, symbol: string) => void;
    serverUrl: string;
    pending?: PendingMessageStatus;
    onRetry?: () => void;
};

// --- Content Renderers ---

/** Check if HTML contains complex elements that need WebView rendering. */
const COMPLEX_HTML_RE = /<(table|img|pre|code|ul|ol|li|h[1-6]|iframe|video|audio|blockquote|div\s+class|\.tox-checklist)/i;

export function TextContent({ msg, theme, serverUrl, onImagePress }: { msg: DooTaskDialogMsg; theme: any; serverUrl: string; onImagePress?: (url: string) => void }) {
    const text = getMsgText(msg);

    // Markdown messages: render as native components (Text/View) for proper flex layout
    const isMd = typeof msg.msg === 'object' && msg.msg?.type === 'md';
    if (isMd) {
        return <MarkdownContent text={text} theme={theme} serverUrl={serverUrl} onImagePress={onImagePress} />;
    }

    const isHtml = (typeof msg.msg === 'object' && msg.msg?.type === 'html') || /<[^>]+>/.test(text);
    // Only use WebView for complex HTML (tables, code blocks, images, lists, etc.)
    // Simple HTML (br, p, b, i, a, span) is stripped and rendered natively for instant display
    if (isHtml && COMPLEX_HTML_RE.test(text)) {
        return <HtmlContent html={resolveContentUrls(text, serverUrl)} theme={theme} onImagePress={onImagePress} />;
    }
    return (
        <Text style={[styles.msgText, { color: theme.colors.text }]}>
            {isHtml ? stripHtml(text) : text}
        </Text>
    );
}

function ImageContent({ msg, serverUrl, theme, onImagePress }: { msg: DooTaskDialogMsg; serverUrl: string; theme: any; onImagePress?: (url: string) => void }) {
    const imageUrl = getMsgImageUrl(msg, serverUrl);
    // File-upload image: has path/url/thumb
    if (imageUrl) {
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
    // Text-with-embedded-images: msg.msg.text contains <img> tags (DooTask classifies these as type='image')
    const text = getMsgText(msg);
    if (text) {
        return <HtmlContent html={resolveContentUrls(text, serverUrl)} theme={theme} onImagePress={onImagePress} />;
    }
    return null;
}

function FileContent({ msg, serverUrl, theme, onImagePress }: { msg: DooTaskDialogMsg; serverUrl: string; theme: any; onImagePress?: (url: string) => void }) {
    const msgData = msg.msg || {};
    const filePath = msgData.path || msgData.url || '';
    const fileUrl = filePath ? resolveUrl(filePath, serverUrl) : null;

    // Sub-type: image (DooTask reassigns ext [jpg,jpeg,webp,png,gif] → msg.msg.type = 'img')
    if (msgData.type === 'img' && fileUrl) {
        const w = msgData.width || 260;
        const h = msgData.height || 180;
        const ratio = Math.min(260 / w, 260 / h, 1);
        const displayW = Math.round(w * ratio);
        const displayH = Math.round(h * ratio);
        return (
            <Pressable onPress={() => onImagePress?.(fileUrl)} style={styles.imageWrapper}>
                <Image
                    source={{ uri: msgData.thumb ? resolveUrl(msgData.thumb, serverUrl) : fileUrl }}
                    style={{ width: displayW, height: displayH, borderRadius: 8 }}
                    contentFit="cover"
                />
            </Pressable>
        );
    }

    // Sub-type: video (mp4 with dimensions)
    if (msgData.ext === 'mp4' && msgData.width > 0 && msgData.height > 0) {
        const w = msgData.width;
        const h = msgData.height;
        const ratio = Math.min(260 / w, 260 / h, 1);
        const displayW = Math.round(w * ratio);
        const displayH = Math.round(h * ratio);
        const thumbUrl = msgData.thumb ? resolveUrl(msgData.thumb, serverUrl) : null;
        return (
            <Pressable
                onPress={() => { if (fileUrl) WebBrowser.openBrowserAsync(fileUrl); }}
                style={styles.imageWrapper}
            >
                {thumbUrl ? (
                    <View>
                        <Image source={{ uri: thumbUrl }} style={{ width: displayW, height: displayH, borderRadius: 8 }} contentFit="cover" />
                        <View style={{ position: 'absolute', top: 0, left: 0, width: displayW, height: displayH, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                            <Ionicons name="play-circle" size={48} color="rgba(255,255,255,0.85)" />
                        </View>
                    </View>
                ) : (
                    <View style={[styles.fileCard, { backgroundColor: theme.colors.surfaceHigh }]}>
                        <View style={[styles.fileIconCircle, { backgroundColor: theme.colors.surfaceHighest }]}>
                            <Ionicons name="videocam-outline" size={20} color={theme.colors.textSecondary} />
                        </View>
                        <View style={styles.fileInfo}>
                            <Text style={[styles.fileName, { color: theme.colors.text }]} numberOfLines={1}>{msgData.name || 'Video'}</Text>
                            {msgData.size ? <Text style={[styles.fileSize, { color: theme.colors.textSecondary }]}>{formatFileSize(msgData.size)}</Text> : null}
                        </View>
                    </View>
                )}
            </Pressable>
        );
    }

    // Generic file (existing behavior)
    const fileName = msgData.name || '';
    const fileSize = msgData.size ? formatFileSize(msgData.size) : '';
    return (
        <Pressable
            style={[styles.fileCard, { backgroundColor: theme.colors.surfaceHigh }]}
            onPress={() => { if (fileUrl) WebBrowser.openBrowserAsync(fileUrl); }}
        >
            <View style={[styles.fileIconCircle, { backgroundColor: theme.colors.surfaceHighest }]}>
                <Ionicons name="document-outline" size={20} color={theme.colors.textSecondary} />
            </View>
            <View style={styles.fileInfo}>
                <Text style={[styles.fileName, { color: theme.colors.text }]} numberOfLines={1}>{fileName}</Text>
                {fileSize ? <Text style={[styles.fileSize, { color: theme.colors.textSecondary }]}>{fileSize}</Text> : null}
            </View>
        </Pressable>
    );
}

function LongtextContent({ msg, theme, serverUrl, onImagePress }: { msg: DooTaskDialogMsg; theme: any; serverUrl: string; onImagePress?: (url: string) => void }) {
    const fileUrl = msg.msg?.file?.url;
    return (
        <View>
            <TextContent msg={msg} theme={theme} serverUrl={serverUrl} onImagePress={onImagePress} />
            {fileUrl ? (
                <Pressable onPress={() => WebBrowser.openBrowserAsync(resolveUrl(fileUrl, serverUrl))} style={{ marginTop: 4 }}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.textLink }}>
                        {t('dootask.viewDetails')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}

function RecordContent({ msg, serverUrl, theme }: { msg: DooTaskDialogMsg; serverUrl: string; theme: any }) {
    const duration = msg.msg?.duration || 0; // milliseconds
    const seconds = Math.max(1, Math.round(duration / 1000));
    const audioUrl = msg.msg?.path ? resolveUrl(msg.msg.path, serverUrl) : '';
    const transcript = msg.msg?.text || '';
    const barWidth = Math.min(200, Math.max(80, 80 + seconds * 3));

    const { isPlaying, toggle } = useDootaskAudioPlayer(msg.id, audioUrl);

    return (
        <View>
            <Pressable
                onPress={audioUrl ? toggle : undefined}
                style={[voiceStyles.bar, { width: barWidth, backgroundColor: theme.colors.surfaceHigh }]}
            >
                <Ionicons
                    name={isPlaying ? 'volume-high' : 'volume-medium'}
                    size={18}
                    color={theme.colors.text}
                />
                <Text style={[voiceStyles.duration, { color: theme.colors.text }]}>
                    {seconds}″
                </Text>
            </Pressable>
            {transcript ? (
                <Text style={[voiceStyles.transcript, { color: theme.colors.textSecondary }]} numberOfLines={3}>
                    {transcript}
                </Text>
            ) : null}
        </View>
    );
}

const voiceStyles = StyleSheet.create({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 16,
        marginTop: 2,
    },
    duration: {
        ...Typography.default(),
        fontSize: 14,
    },
    transcript: {
        ...Typography.default(),
        fontSize: 13,
        marginTop: 4,
    },
});

// --- Emoji Reactions ---

function EmojiReactionsRow({ emoji, msgId, currentUserId, theme, onEmojiPress }: {
    emoji: EmojiReaction[];
    msgId: number;
    currentUserId: number;
    theme: any;
    onEmojiPress?: (msgId: number, symbol: string) => void;
}) {
    if (!emoji || emoji.length === 0) return null;
    return (
        <View style={emojiStyles.row}>
            {emoji.map((e) => {
                const isMine = e.userids.includes(currentUserId);
                return (
                    <Pressable
                        key={e.symbol}
                        onPress={() => onEmojiPress?.(msgId, e.symbol)}
                        style={[
                            emojiStyles.pill,
                            { backgroundColor: isMine ? theme.colors.textLink + '20' : theme.colors.surfaceHigh },
                            isMine && { borderColor: theme.colors.textLink, borderWidth: 1 },
                        ]}
                    >
                        <Text style={emojiStyles.pillEmoji}>{e.symbol}</Text>
                        <Text style={[emojiStyles.pillCount, { color: isMine ? theme.colors.textLink : theme.colors.textSecondary }]}>
                            {e.userids.length}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const emojiStyles = StyleSheet.create({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
    pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
    pillEmoji: { fontSize: 14 },
    pillCount: { ...Typography.default(), fontSize: 12 },
});

// --- Component ---

export const ChatBubble = React.memo(({
    msg,
    currentUserId,
    senderName: _senderName,
    avatarUrl: _avatarUrl,
    disabledAt,
    showAvatar,
    replyMsg,
    replySenderName,
    onImagePress,
    onLongPress,
    onEmojiPress,
    serverUrl,
    pending,
    onRetry,
}: ChatBubbleProps) => {
    const { theme } = useUnistyles();
    const isAiAssistant = msg.userid === AI_ASSISTANT_USERID;
    const isSelf = msg.userid === currentUserId;
    const senderName = isAiAssistant ? t('dootask.aiAssistant') : _senderName;
    const avatarUrl = isAiAssistant ? null : _avatarUrl;
    const time = formatTime(msg.created_at);
    const emojiCount = msg.type === 'text' ? getEmojiCount(getMsgText(msg)) : 0;
    const isLargeEmoji = emojiCount > 0;
    const bubbleRef = React.useRef<View>(null);

    // Notice messages: centered, no layout change
    // DooTask stores notice text in msg.notice (not msg.text)
    if (msg.type === 'notice') {
        const noticeText = msg.msg?.notice || getMsgText(msg);
        return (
            <View style={styles.noticeContainer}>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                    {stripHtml(noticeText)}
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
            if (isLargeEmoji) {
                content = (
                    <Text style={{ fontSize: EMOJI_SIZES[emojiCount], lineHeight: EMOJI_SIZES[emojiCount] * 1.3 }}>
                        {getMsgText(msg).replace(/<\/?p>/gi, '').trim()}
                    </Text>
                );
            } else {
                content = <TextContent msg={msg} theme={theme} serverUrl={serverUrl} onImagePress={onImagePress} />;
            }
            break;
        case 'image':
            content = <ImageContent msg={msg} serverUrl={serverUrl} theme={theme} onImagePress={onImagePress} />;
            break;
        case 'file':
            content = <FileContent msg={msg} serverUrl={serverUrl} theme={theme} onImagePress={onImagePress} />;
            break;
        case 'longtext':
            content = <LongtextContent msg={msg} theme={theme} serverUrl={serverUrl} onImagePress={onImagePress} />;
            break;
        case 'record':
            content = <RecordContent msg={msg} serverUrl={serverUrl} theme={theme} />;
            break;
        case 'meeting':
        case 'template':
        case 'vote':
        case 'word-chain':
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
        let statusRow: React.ReactNode = null;
        if (pending === 'sending') {
            statusRow = (
                <View style={styles.pendingRow}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ width: 12, height: 12, transform: [{ scale: 0.6 }] }} />
                    <Text style={[styles.pendingText, { color: theme.colors.textSecondary }]}>
                        {t('dootask.sending')}
                    </Text>
                </View>
            );
        } else if (pending === 'error') {
            statusRow = (
                <View style={styles.pendingRow}>
                    <Ionicons name="alert-circle" size={13} color={theme.colors.textDestructive} />
                    <Text style={[styles.pendingText, { color: theme.colors.textDestructive }]}>
                        {t('dootask.sendFailed')}
                    </Text>
                    <Pressable onPress={onRetry} hitSlop={8}>
                        <Text style={[styles.retryText, { color: theme.colors.textLink }]}>
                            {t('dootask.retry')}
                        </Text>
                    </Pressable>
                </View>
            );
        }

        return (
            <View ref={bubbleRef}>
                <Pressable
                    onLongPress={pending ? undefined : () => {
                        bubbleRef.current?.measureInWindow((_x, y, _w, h) => {
                            onLongPress?.(msg, { y, height: h });
                        });
                    }}
                    style={[styles.selfBand, { backgroundColor: isLargeEmoji ? 'transparent' : theme.colors.surfaceHigh }, pending === 'error' && { opacity: 0.7 }]}
                >
                    <View style={styles.selfContent}>
                        {replyBlock}
                        {content}
                        <EmojiReactionsRow emoji={msg.emoji} msgId={msg.id} currentUserId={currentUserId} theme={theme} onEmojiPress={onEmojiPress} />
                        {statusRow ?? (time ? (
                            <Text style={[styles.selfTime, { color: theme.colors.textSecondary }]}>
                                {time}{msg.modify > 0 ? ` (${t('dootask.edited')})` : ''}
                            </Text>
                        ) : null)}
                    </View>
                </Pressable>
            </View>
        );
    }

    // --- Others' messages: Slack-style flat layout ---
    const initial = (senderName || '?')[0].toUpperCase();
    const avatarBg = isAiAssistant ? AI_AVATAR_COLOR : getAvatarColor(msg.userid);

    return (
        <View ref={bubbleRef}>
            <Pressable
                onLongPress={() => {
                    bubbleRef.current?.measureInWindow((_x, y, _w, h) => {
                        onLongPress?.(msg, { y, height: h });
                    });
                }}
                style={styles.otherRow}
            >
                {/* Avatar column */}
                <View style={styles.avatarColumn}>
                    {showAvatar ? (
                        isAiAssistant ? (
                            <View style={[styles.avatarPlaceholder, { backgroundColor: AI_AVATAR_COLOR }]}>
                                <Ionicons name="sparkles" size={18} color="#FFFFFF" />
                            </View>
                        ) : avatarUrl ? (
                            <Image
                                source={{ uri: avatarUrl }}
                                style={{ width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, opacity: disabledAt ? 0.4 : 1 }}
                            />
                        ) : (
                            <View style={[styles.avatarPlaceholder, { backgroundColor: avatarBg, opacity: disabledAt ? 0.4 : 1 }]}>
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
                                    {time}{msg.modify > 0 ? ` (${t('dootask.edited')})` : ''}
                                </Text>
                            ) : null}
                        </View>
                    )}
                    {replyBlock}
                    {content}
                    <EmojiReactionsRow emoji={msg.emoji} msgId={msg.id} currentUserId={currentUserId} theme={theme} onEmojiPress={onEmojiPress} />
                </View>
            </Pressable>
        </View>
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

    // --- Pending status ---
    pendingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 4,
    },
    pendingText: {
        ...Typography.default(),
        fontSize: 11,
    },
    retryText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        marginLeft: 4,
    },
}));
