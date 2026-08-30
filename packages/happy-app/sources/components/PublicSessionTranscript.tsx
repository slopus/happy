import * as React from 'react';
import { Image, Linking, Platform, Pressable, ScrollView, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { parseMarkdown, type MarkdownSpan } from '@/components/markdown/parseMarkdown';
import { getPublicSessionAttachmentUrl } from '@/sync/publicSessionShareViewer';
import type {
    PublicSessionBlockV1,
    PublicSessionMessageV1,
    PublicSessionSnapshotV1,
} from '@/sync/publicSessionShareTypes';
import { publicSessionShareText as t } from '@/text/publicSessionShareText';

export function PublicSessionTranscript({
    publicId,
    publishedAt,
    snapshot,
}: {
    publicId: string;
    publishedAt: number;
    snapshot: PublicSessionSnapshotV1;
}) {
    return (
        <ScrollView
            style={styles.page}
            contentContainerStyle={styles.pageContent}
            testID="public-session-transcript"
        >
            <View style={styles.shell}>
                <View style={styles.brandRow}>
                    <View style={styles.brandMark}>
                        <Ionicons name="paw" size={18} color={styles.brandMarkIcon.color} />
                    </View>
                    <Text style={styles.brand}>{t('sessionShare.sharedViaPaws')}</Text>
                </View>
                <View style={styles.hero}>
                    <Text style={styles.title}>{snapshot.title}</Text>
                    <Text style={styles.date}>
                        {t('sessionShare.sharedOn', { date: new Date(publishedAt).toLocaleString() })}
                    </Text>
                </View>

                <View style={styles.messages}>
                    {snapshot.messages.map((message) => (
                        <PublicMessage key={message.id} message={message} publicId={publicId} />
                    ))}
                </View>

                <View style={styles.footer}>
                    <Ionicons name="lock-closed-outline" size={14} color={styles.footerIcon.color} />
                    <Text style={styles.footerText}>{t('sessionShare.sharedViaPaws')}</Text>
                </View>
            </View>
        </ScrollView>
    );
}

function PublicMessage({ message, publicId }: { message: PublicSessionMessageV1; publicId: string }) {
    const user = message.role === 'user';
    const system = message.role === 'system';
    return (
        <View
            style={[styles.messageRow, user && styles.messageRowUser]}
            testID={`public-session-message-${message.id}`}
        >
            <View style={[styles.message, user && styles.userMessage, system && styles.systemMessage]}>
                {!user && !system ? (
                    <View style={styles.assistantLabel}>
                        <View style={styles.assistantMark}>
                            <Ionicons name="sparkles" size={13} color={styles.assistantMarkIcon.color} />
                        </View>
                        <Text style={styles.assistantLabelText}>Paws</Text>
                    </View>
                ) : null}
                {message.blocks.map((block, index) => (
                    <PublicBlock key={`${message.id}-${index}`} block={block} publicId={publicId} />
                ))}
            </View>
        </View>
    );
}

function PublicBlock({ block, publicId }: { block: PublicSessionBlockV1; publicId: string }) {
    const [attachmentUnavailable, setAttachmentUnavailable] = React.useState(false);
    if (block.type === 'text') return <PublicMarkdown markdown={block.markdown} />;
    if (block.type === 'thinking') {
        return (
            <View style={styles.thinkingBlock}>
                <View style={styles.blockLabelRow}>
                    <Ionicons name="bulb-outline" size={15} color={styles.secondaryIcon.color} />
                    <Text style={styles.blockLabel}>{t('sessionShare.thinking')}</Text>
                </View>
                <PublicMarkdown markdown={block.markdown} secondary />
            </View>
        );
    }
    if (block.type === 'tool') {
        const statusLabel = block.status === 'running'
            ? t('sessionShare.toolRunning')
            : block.status === 'failed'
                ? t('sessionShare.toolFailed')
                : t('sessionShare.toolCompleted');
        return (
            <View style={styles.toolBlock}>
                <View style={styles.toolHeader}>
                    <Ionicons
                        name={block.status === 'failed' ? 'alert-circle-outline' : 'terminal-outline'}
                        size={16}
                        color={block.status === 'failed' ? styles.errorIcon.color : styles.secondaryIcon.color}
                    />
                    <Text style={styles.toolName}>{block.title ?? block.name}</Text>
                    <Text style={[styles.toolStatus, block.status === 'failed' && styles.toolStatusFailed]}>{statusLabel}</Text>
                </View>
                {block.body ? <Text selectable style={styles.toolBody}>{block.body}</Text> : null}
            </View>
        );
    }

    const uri = getPublicSessionAttachmentUrl(publicId, block.attachmentId);
    if (attachmentUnavailable) {
        return (
            <View style={styles.unavailableAttachment} testID={`public-session-attachment-unavailable-${block.attachmentId}`}>
                <Ionicons name="alert-circle-outline" size={18} color={styles.secondaryIcon.color} />
                <Text style={styles.unavailableAttachmentText}>{t('sessionShare.attachmentUnavailable')}</Text>
            </View>
        );
    }
    if (block.kind === 'image') {
        return (
            <Pressable
                accessibilityLabel={block.name}
                accessibilityRole="link"
                onPress={() => void Linking.openURL(uri)}
                style={({ pressed }) => [styles.imageAttachment, pressed && styles.pressed]}
            >
                <Image
                    accessibilityLabel={block.name}
                    resizeMode="contain"
                    source={{ uri }}
                    style={styles.attachmentImage}
                    testID={`public-session-attachment-${block.attachmentId}`}
                    onError={() => setAttachmentUnavailable(true)}
                />
                <View style={styles.attachmentCaption}>
                    <Text style={styles.attachmentName} numberOfLines={1}>{block.name}</Text>
                    <Text style={styles.attachmentMeta}>{formatBytes(block.size)}</Text>
                </View>
            </Pressable>
        );
    }
    if (Platform.OS === 'web' && (block.kind === 'audio' || block.kind === 'video')) {
        const player = React.createElement(block.kind, {
            controls: true,
            preload: 'metadata',
            src: uri,
            onError: () => setAttachmentUnavailable(true),
            style: block.kind === 'video' ? styles.videoPlayer : styles.audioPlayer,
            'data-testid': `public-session-attachment-${block.attachmentId}`,
        });
        return (
            <View style={styles.mediaAttachment}>
                {player}
                <View style={styles.attachmentCaption}>
                    <Text style={styles.attachmentName} numberOfLines={1}>{block.name}</Text>
                    <Text style={styles.attachmentMeta}>{formatBytes(block.size)}</Text>
                </View>
            </View>
        );
    }
    const openFile = async () => {
        try {
            const response = await fetch(uri, { method: 'HEAD' });
            if (!response.ok) throw new Error('Attachment unavailable');
            await Linking.openURL(uri);
        } catch {
            setAttachmentUnavailable(true);
        }
    };
    return (
        <Pressable
            accessibilityLabel={`${t('sessionShare.downloadAttachment')}: ${block.name}`}
            accessibilityRole="link"
            onPress={() => void openFile()}
            style={({ pressed }) => [styles.fileAttachment, pressed && styles.pressed]}
            testID={`public-session-attachment-${block.attachmentId}`}
        >
            <View style={styles.fileIcon}>
                <Ionicons name={attachmentIcon(block.kind)} size={20} color={styles.brandMarkIcon.color} />
            </View>
            <View style={styles.fileCopy}>
                <Text style={styles.attachmentName} numberOfLines={1}>{block.name}</Text>
                <Text style={styles.attachmentMeta}>{formatBytes(block.size)}</Text>
            </View>
            <Ionicons name="download-outline" size={18} color={styles.secondaryIcon.color} />
        </Pressable>
    );
}

function PublicMarkdown({ markdown, secondary = false }: { markdown: string; secondary?: boolean }) {
    const blocks = React.useMemo(() => parseMarkdown(markdown), [markdown]);
    return (
        <View style={styles.markdown}>
            {blocks.map((block, index) => {
                if (block.type === 'text') {
                    return <SpanText key={index} spans={block.content} secondary={secondary} />;
                }
                if (block.type === 'header') {
                    return (
                        <SpanText
                            key={index}
                            spans={block.content}
                            secondary={secondary}
                            style={block.level <= 2 ? styles.markdownHeadingLarge : styles.markdownHeading}
                        />
                    );
                }
                if (block.type === 'horizontal-rule') return <View key={index} style={styles.rule} />;
                if (block.type === 'code-block' || block.type === 'mermaid') {
                    return <Text key={index} selectable style={styles.codeBlock}>{block.content}</Text>;
                }
                if (block.type === 'list' || block.type === 'numbered-list') {
                    return (
                        <View key={index} style={styles.list}>
                            {block.items.map((item, itemIndex) => (
                                <View key={itemIndex} style={[styles.listRow, { paddingLeft: item.depth * 16 }]}>
                                    <Text style={[styles.bodyText, secondary && styles.secondaryBody]}>
                                        {block.type === 'numbered-list' && 'number' in item ? `${item.number}.` : '•'}
                                    </Text>
                                    <SpanText spans={item.spans} secondary={secondary} style={styles.listText} />
                                </View>
                            ))}
                        </View>
                    );
                }
                if (block.type === 'table') {
                    return (
                        <ScrollView key={index} horizontal style={styles.tableScroll}>
                            <View style={styles.table}>
                                <View style={styles.tableRow}>
                                    {block.headers.map((cell, cellIndex) => (
                                        <SpanText key={cellIndex} spans={cell} style={styles.tableHeaderCell} />
                                    ))}
                                </View>
                                {block.rows.map((row, rowIndex) => (
                                    <View key={rowIndex} style={styles.tableRow}>
                                        {row.map((cell, cellIndex) => (
                                            <SpanText key={cellIndex} spans={cell} style={styles.tableCell} />
                                        ))}
                                    </View>
                                ))}
                            </View>
                        </ScrollView>
                    );
                }
                if (block.type === 'image' && /^https?:\/\//.test(block.url)) {
                    return (
                        <Pressable key={index} onPress={() => void Linking.openURL(block.url)}>
                            <Image accessibilityLabel={block.alt} resizeMode="contain" source={{ uri: block.url }} style={styles.markdownImage} />
                        </Pressable>
                    );
                }
                if (block.type === 'options') {
                    return <Text key={index} selectable style={[styles.bodyText, secondary && styles.secondaryBody]}>{block.items.join('\n')}</Text>;
                }
                return null;
            })}
        </View>
    );
}

function SpanText({
    secondary = false,
    spans,
    style,
}: {
    secondary?: boolean;
    spans: MarkdownSpan[];
    style?: StyleProp<TextStyle>;
}) {
    return (
        <Text selectable style={[styles.bodyText, secondary && styles.secondaryBody, style]}>
            {spans.map((span, index) => (
                <Text
                    key={index}
                    accessibilityRole={span.url ? 'link' : undefined}
                    onPress={span.url && /^https?:\/\//.test(span.url) ? () => void Linking.openURL(span.url as string) : undefined}
                    style={[
                        span.styles.includes('bold') && styles.bold,
                        span.styles.includes('semibold') && styles.semibold,
                        span.styles.includes('italic') && styles.italic,
                        span.styles.includes('code') && styles.inlineCode,
                        span.url && styles.link,
                    ]}
                >
                    {span.text}
                </Text>
            ))}
        </Text>
    );
}

function attachmentIcon(kind: 'audio' | 'video' | 'file'): React.ComponentProps<typeof Ionicons>['name'] {
    if (kind === 'audio') return 'musical-notes-outline';
    if (kind === 'video') return 'videocam-outline';
    return 'document-outline';
}

function formatBytes(size: number): string {
    if (size < 1_024) return `${size} B`;
    if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
    return `${(size / 1_048_576).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.groupped.background },
    pageContent: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 48 },
    shell: { width: '100%', maxWidth: layout.maxWidth },
    brandRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
    brandMark: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accent },
    brandMarkIcon: { color: theme.colors.surface },
    brand: { color: theme.colors.text, fontSize: 15, fontWeight: '600' as const },
    hero: { paddingTop: 34, paddingBottom: 30, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    title: { color: theme.colors.text, fontSize: 34, lineHeight: 42, fontWeight: '700' as const },
    date: { color: theme.colors.textSecondary, fontSize: 14, marginTop: 10 },
    messages: { paddingVertical: 28, gap: 24 },
    messageRow: { width: '100%', alignItems: 'flex-start' },
    messageRowUser: { alignItems: 'flex-end' },
    message: { width: '100%', gap: 12 },
    userMessage: { width: 'auto', maxWidth: '80%', paddingHorizontal: 18, paddingVertical: 14, borderRadius: 18, backgroundColor: theme.colors.surfaceHigh },
    systemMessage: { padding: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh },
    assistantLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
    assistantMark: { width: 25, height: 25, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHigh },
    assistantMarkIcon: { color: theme.colors.accent },
    assistantLabelText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' as const },
    markdown: { width: '100%', gap: 10 },
    bodyText: { color: theme.colors.text, fontSize: 16, lineHeight: 25 },
    secondaryBody: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 22 },
    markdownHeadingLarge: { fontSize: 24, lineHeight: 31, fontWeight: '700' as const, marginTop: 5 },
    markdownHeading: { fontSize: 19, lineHeight: 26, fontWeight: '600' as const, marginTop: 4 },
    bold: { fontWeight: '700' as const },
    semibold: { fontWeight: '600' as const },
    italic: { fontStyle: 'italic' as const },
    inlineCode: { fontFamily: 'IBMPlexMono-Regular', backgroundColor: theme.colors.surfaceHigh },
    link: { color: theme.colors.accent, textDecorationLine: 'underline' as const },
    rule: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider, marginVertical: 8 },
    codeBlock: { color: theme.colors.text, fontFamily: 'IBMPlexMono-Regular', fontSize: 13, lineHeight: 20, padding: 14, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh },
    list: { gap: 7 },
    listRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
    listText: { flex: 1 },
    tableScroll: { maxWidth: '100%' },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 9, overflow: 'hidden' },
    tableRow: { flexDirection: 'row' },
    tableHeaderCell: { minWidth: 140, padding: 10, fontWeight: '600' as const, backgroundColor: theme.colors.surfaceHigh },
    tableCell: { minWidth: 140, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    markdownImage: { width: '100%', height: 360, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh },
    thinkingBlock: { padding: 14, gap: 10, borderLeftWidth: 2, borderLeftColor: theme.colors.divider },
    blockLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    blockLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' as const },
    secondaryIcon: { color: theme.colors.textSecondary },
    errorIcon: { color: theme.colors.status.error },
    toolBlock: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 12, overflow: 'hidden' },
    toolHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: theme.colors.surfaceHigh },
    toolName: { flex: 1, color: theme.colors.text, fontSize: 13, fontWeight: '600' as const },
    toolStatus: { color: theme.colors.textSecondary, fontSize: 11 },
    toolStatusFailed: { color: theme.colors.status.error },
    toolBody: { color: theme.colors.textSecondary, fontFamily: 'IBMPlexMono-Regular', fontSize: 12, lineHeight: 18, padding: 12 },
    imageAttachment: { width: '100%', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 14, overflow: 'hidden' },
    attachmentImage: { width: '100%', height: 420, backgroundColor: theme.colors.surfaceHigh },
    mediaAttachment: { width: '100%', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 14, overflow: 'hidden' },
    videoPlayer: { width: '100%', maxHeight: 480, backgroundColor: theme.colors.surfaceHigh },
    audioPlayer: { width: '100%', height: 48, marginTop: 10 },
    attachmentCaption: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
    attachmentName: { flex: 1, color: theme.colors.text, fontSize: 13, fontWeight: '500' as const },
    attachmentMeta: { color: theme.colors.textSecondary, fontSize: 12 },
    fileAttachment: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 12 },
    unavailableAttachment: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh },
    unavailableAttachmentText: { color: theme.colors.textSecondary, fontSize: 13 },
    fileIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accent },
    fileCopy: { flex: 1 },
    footer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7, paddingTop: 22, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    footerIcon: { color: theme.colors.textSecondary },
    footerText: { color: theme.colors.textSecondary, fontSize: 12 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
}));
