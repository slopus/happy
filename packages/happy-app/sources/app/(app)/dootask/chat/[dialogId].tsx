import * as React from 'react';
import { View, ActivityIndicator, Text, KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { storage, useDootaskProfile, useDootaskUserCache } from '@/sync/storage';
import { dootaskFetchDialogMessages, dootaskSendTextMessage, dootaskSendFileMessage } from '@/sync/dootask/api';
import { useDootaskWebSocket } from '@/hooks/useDootaskWebSocket';
import { ChatMessageList } from '@/components/dootask/ChatMessageList';
import { ChatInput } from '@/components/dootask/ChatInput';
import { ImageViewer } from '@/components/ImageViewer';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

export default React.memo(function DooTaskChat() {
    const { dialogId } = useLocalSearchParams<{ dialogId: string }>();
    const { theme } = useUnistyles();
    const profile = useDootaskProfile();
    const userCache = useDootaskUserCache();
    const id = Number(dialogId);

    // Message state
    const [messages, setMessages] = React.useState<DooTaskDialogMsg[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [sending, setSending] = React.useState(false);

    // Reply state
    const [replyTo, setReplyTo] = React.useState<{ msg: DooTaskDialogMsg; senderName: string } | null>(null);

    // Long-press menu
    const [menuVisible, setMenuVisible] = React.useState(false);
    const [menuItems, setMenuItems] = React.useState<ActionMenuItem[]>([]);

    // Image viewer
    const [imageViewerVisible, setImageViewerVisible] = React.useState(false);
    const [imageViewerIndex, setImageViewerIndex] = React.useState(0);

    // Collect all image URLs from messages for the viewer
    const imageUrls = React.useMemo(() => {
        const urls: { uri: string }[] = [];
        for (const msg of messages) {
            if (msg.type === 'image') {
                const path = msg.msg?.path || msg.msg?.url || msg.msg?.thumb;
                if (path) {
                    const url = path.startsWith('http') ? path : (profile?.serverUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
                    urls.push({ uri: url });
                }
            }
        }
        return urls;
    }, [messages, profile?.serverUrl]);

    // Initial fetch
    const fetchMessages = React.useCallback(async () => {
        if (!profile) return;
        try {
            const res = await dootaskFetchDialogMessages(profile.serverUrl, profile.token, {
                dialog_id: id,
                take: 50,
            });
            if (res.ret === 1 && res.data?.list) {
                const list: DooTaskDialogMsg[] = res.data.list;
                // API returns oldest-first, we need newest-first for inverted FlatList
                const reversed = [...list].reverse();
                setMessages(reversed);
                setHasMore(list.length >= 50);
                // Fetch user names
                const userIds = [...new Set(list.map(m => m.userid))];
                if (userIds.length > 0) storage.getState().fetchDootaskUsers(userIds);
            } else {
                setError(res.msg || t('dootask.errorLoadChat'));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : t('dootask.errorLoadChat'));
        } finally {
            setLoading(false);
        }
    }, [profile, id]);

    React.useEffect(() => {
        fetchMessages();
    }, [fetchMessages]);

    // Load older messages
    const handleLoadMore = React.useCallback(async () => {
        if (!profile || loadingMore || !hasMore || messages.length === 0) return;
        setLoadingMore(true);
        try {
            // Oldest message is at the end of our newest-first array
            const oldestMsg = messages[messages.length - 1];
            const res = await dootaskFetchDialogMessages(profile.serverUrl, profile.token, {
                dialog_id: id,
                prev_id: oldestMsg.id,
                take: 50,
            });
            if (res.ret === 1 && res.data?.list) {
                const list: DooTaskDialogMsg[] = res.data.list;
                if (list.length === 0) {
                    setHasMore(false);
                } else {
                    const reversed = [...list].reverse();
                    setMessages(prev => [...prev, ...reversed]);
                    setHasMore(list.length >= 50);
                    const userIds = [...new Set(list.map(m => m.userid))];
                    if (userIds.length > 0) storage.getState().fetchDootaskUsers(userIds);
                }
            }
        } catch { /* ignore */ } finally {
            setLoadingMore(false);
        }
    }, [profile, id, loadingMore, hasMore, messages]);

    // WebSocket for real-time
    useDootaskWebSocket({
        serverUrl: profile?.serverUrl || '',
        token: profile?.token || '',
        dialogId: id,
        onMessage: React.useCallback((msg: DooTaskDialogMsg) => {
            setMessages(prev => {
                // Avoid duplicates
                if (prev.some(m => m.id === msg.id)) return prev;
                return [msg, ...prev]; // prepend (newest-first)
            });
            // Fetch user name if needed
            if (msg.userid) storage.getState().fetchDootaskUsers([msg.userid]);
        }, []),
        onMessageUpdate: React.useCallback((msg: DooTaskDialogMsg) => {
            setMessages(prev => prev.map(m => m.id === msg.id ? msg : m));
        }, []),
        onMessageDelete: React.useCallback((msgId: number) => {
            setMessages(prev => prev.filter(m => m.id !== msgId));
        }, []),
    });

    // Send text
    const handleSendText = React.useCallback(async (text: string) => {
        if (!profile || sending) return;
        setSending(true);
        try {
            const res = await dootaskSendTextMessage(profile.serverUrl, profile.token, {
                dialog_id: id,
                text,
                reply_id: replyTo?.msg.id,
            });
            if (res.ret !== 1) {
                setError(res.msg || t('dootask.errorSendMessage'));
            }
            setReplyTo(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('dootask.errorSendMessage'));
        } finally {
            setSending(false);
        }
    }, [profile, id, replyTo, sending]);

    // Send image
    const handleSendImage = React.useCallback(async (base64DataUri: string) => {
        if (!profile || sending) return;
        setSending(true);
        try {
            const res = await dootaskSendFileMessage(profile.serverUrl, profile.token, {
                dialog_id: id,
                image64: base64DataUri,
                reply_id: replyTo?.msg.id,
            });
            if (res.ret !== 1) {
                setError(res.msg || t('dootask.errorSendMessage'));
            }
            setReplyTo(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('dootask.errorSendMessage'));
        } finally {
            setSending(false);
        }
    }, [profile, id, replyTo, sending]);

    // Long press menu -> reply
    const handleMessageLongPress = React.useCallback((msg: DooTaskDialogMsg) => {
        const items: ActionMenuItem[] = [
            {
                label: t('dootask.reply'),
                onPress: () => {
                    setReplyTo({
                        msg,
                        senderName: userCache[msg.userid] || String(msg.userid),
                    });
                },
            },
        ];
        setMenuItems(items);
        setMenuVisible(true);
    }, [userCache]);

    // Image press -> open viewer
    const handleImagePress = React.useCallback((url: string) => {
        const idx = imageUrls.findIndex(img => img.uri === url);
        setImageViewerIndex(idx >= 0 ? idx : 0);
        setImageViewerVisible(true);
    }, [imageUrls]);

    if (loading) {
        return (
            <>
                <Stack.Screen options={{ title: t('dootask.chatTitle') }} />
                <ActivityIndicator style={{ flex: 1 }} />
            </>
        );
    }

    if (error && messages.length === 0) {
        return (
            <>
                <Stack.Screen options={{ title: t('dootask.chatTitle') }} />
                <View style={styles.center}>
                    <Text style={{ color: theme.colors.textDestructive }}>{error}</Text>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: t('dootask.chatTitle') }} />
            <KeyboardAvoidingView
                style={{ flex: 1, backgroundColor: theme.colors.surface }}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
            >
                <ChatMessageList
                    messages={messages}
                    currentUserId={profile?.userId || 0}
                    userNames={userCache}
                    onLoadMore={handleLoadMore}
                    loadingMore={loadingMore}
                    hasMore={hasMore}
                    onMessageLongPress={handleMessageLongPress}
                    onImagePress={handleImagePress}
                    serverUrl={profile?.serverUrl || ''}
                />
                <ChatInput
                    onSendText={handleSendText}
                    onSendImage={handleSendImage}
                    replyTo={replyTo}
                    onCancelReply={() => setReplyTo(null)}
                    sending={sending}
                />
            </KeyboardAvoidingView>
            <ActionMenuModal
                visible={menuVisible}
                items={menuItems}
                onClose={() => setMenuVisible(false)}
            />
            <ImageViewer
                images={imageUrls}
                initialIndex={imageViewerIndex}
                visible={imageViewerVisible}
                onClose={() => setImageViewerVisible(false)}
            />
        </>
    );
});

// --- Styles ---

const styles = StyleSheet.create((_theme) => ({
    center: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
}));
