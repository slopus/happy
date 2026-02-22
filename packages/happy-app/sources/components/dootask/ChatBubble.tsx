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

// --- Helpers ---

function getMsgText(msg: DooTaskDialogMsg): string {
    if (typeof msg.msg === 'string') return msg.msg;
    if (msg.msg?.text) return msg.msg.text;
    return '';
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

// --- Props ---

type ChatBubbleProps = {
    msg: DooTaskDialogMsg;
    currentUserId: number;
    senderName?: string;
    replyMsg?: DooTaskDialogMsg | null;
    replySenderName?: string;
    onImagePress?: (url: string) => void;
    onLongPress?: (msg: DooTaskDialogMsg) => void;
    serverUrl: string;
};

// --- Component ---

export const ChatBubble = React.memo(({
    msg,
    currentUserId,
    senderName,
    replyMsg,
    replySenderName,
    onImagePress,
    onLongPress,
    serverUrl,
}: ChatBubbleProps) => {
    const { theme } = useUnistyles();
    const isSelf = msg.userid === currentUserId;

    // Notice messages: centered, no bubble
    if (msg.type === 'notice') {
        return (
            <View style={styles.noticeContainer}>
                <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
                    {getMsgText(msg)}
                </Text>
            </View>
        );
    }

    // Reply quote block
    const replyBlock = replyMsg ? (
        <View style={[styles.replyQuote, { borderLeftColor: theme.colors.textSecondary }]}>
            {replySenderName ? (
                <Text style={[styles.replySender, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                    {replySenderName}
                </Text>
            ) : null}
            <Text style={[styles.replyText, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                {getMsgText(replyMsg)}
            </Text>
        </View>
    ) : null;

    // Render content based on message type
    let content: React.ReactNode = null;

    switch (msg.type) {
        case 'text': {
            const text = getMsgText(msg);
            const isHtml = (typeof msg.msg === 'object' && msg.msg?.type === 'html') || /<[^>]+>/.test(text);
            if (isHtml) {
                content = <HtmlContent html={text} theme={theme} onImagePress={onImagePress} />;
            } else {
                content = (
                    <Text style={[styles.msgText, { color: isSelf ? theme.colors.text : theme.colors.text }]}>
                        {text}
                    </Text>
                );
            }
            break;
        }
        case 'image': {
            const imageUrl = getMsgImageUrl(msg, serverUrl);
            if (imageUrl) {
                content = (
                    <Pressable onPress={() => onImagePress?.(imageUrl)}>
                        <Image
                            source={{ uri: imageUrl }}
                            style={{ width: 200, height: 200, borderRadius: 8 }}
                            contentFit="cover"
                        />
                    </Pressable>
                );
            }
            break;
        }
        case 'file': {
            const fileName = msg.msg?.name || '';
            const fileSize = msg.msg?.size ? formatFileSize(msg.msg.size) : '';
            const filePath = msg.msg?.path || msg.msg?.url || '';
            const fileUrl = filePath
                ? (filePath.startsWith('http') ? filePath : serverUrl.replace(/\/+$/, '') + '/' + filePath.replace(/^\/+/, ''))
                : null;
            content = (
                <Pressable
                    style={styles.fileRow}
                    onPress={() => { if (fileUrl) WebBrowser.openBrowserAsync(fileUrl); }}
                >
                    <Ionicons name="document-outline" size={24} color={theme.colors.textSecondary} />
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
            break;
        }
        case 'record':
        case 'meeting':
        case 'longtext':
        case 'template': {
            content = (
                <Text style={[styles.unsupportedText, { color: theme.colors.textSecondary }]}>
                    {t('dootask.unsupportedMessage')}
                </Text>
            );
            break;
        }
        default: {
            content = (
                <Text style={[styles.unsupportedText, { color: theme.colors.textSecondary }]}>
                    {t('dootask.unsupportedMessage')}
                </Text>
            );
            break;
        }
    }

    const bubbleBg = isSelf
        ? (theme.dark ? '#2C3E50' : '#DCF8C6')
        : theme.colors.surface;

    return (
        <View style={[styles.row, isSelf ? styles.rowSelf : styles.rowOther]}>
            <Pressable
                onLongPress={() => onLongPress?.(msg)}
                style={[styles.bubble, { backgroundColor: bubbleBg }]}
            >
                {!isSelf && senderName ? (
                    <Text style={[styles.senderName, { color: theme.colors.textSecondary }]}>
                        {senderName}
                    </Text>
                ) : null}
                {replyBlock}
                {content}
            </Pressable>
        </View>
    );
});

// --- Styles ---

const styles = StyleSheet.create((_theme) => ({
    row: {
        paddingHorizontal: 12,
        paddingVertical: 3,
    },
    rowSelf: {
        alignItems: 'flex-end',
    },
    rowOther: {
        alignItems: 'flex-start',
    },
    bubble: {
        maxWidth: '80%',
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    senderName: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        marginBottom: 2,
    },
    replyQuote: {
        borderLeftWidth: 2,
        paddingLeft: 8,
        marginBottom: 6,
    },
    replySender: {
        ...Typography.default('semiBold'),
        fontSize: 11,
    },
    replyText: {
        ...Typography.default(),
        fontSize: 12,
    },
    msgText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
    },
    noticeContainer: {
        alignItems: 'center',
        paddingVertical: 6,
        paddingHorizontal: 16,
    },
    noticeText: {
        ...Typography.default(),
        fontSize: 12,
        textAlign: 'center',
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    fileInfo: {
        flex: 1,
    },
    fileName: {
        ...Typography.default(),
        fontSize: 14,
    },
    fileSize: {
        ...Typography.default(),
        fontSize: 12,
    },
    unsupportedText: {
        ...Typography.default('italic'),
        fontSize: 13,
    },
}));
