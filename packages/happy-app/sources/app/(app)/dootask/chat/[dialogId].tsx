import * as React from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { AgentContentView } from '@/components/AgentContentView';
import { storage, useDootaskProfile, useDootaskUserCache, useDootaskUserAvatars } from '@/sync/storage';
import { dootaskFetchDialogMessages, dootaskSendTextMessage, dootaskSendFileMessage } from '@/sync/dootask/api';
import { useDootaskWebSocket } from '@/hooks/useDootaskWebSocket';
import { ChatMessageList } from '@/components/dootask/ChatMessageList';
import { thumbRestore } from '@/components/dootask/ChatBubble';
import { ChatInput } from '@/components/dootask/ChatInput';
import { ImageViewer } from '@/components/ImageViewer';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

function dedupeMessagesById(list: DooTaskDialogMsg[]): DooTaskDialogMsg[] {
    const seen = new Set<number>();
    const deduped: DooTaskDialogMsg[] = [];
    for (const msg of list) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        deduped.push(msg);
    }
    return deduped;
}

export default React.memo(function DooTaskChat() {
    const { dialogId, taskName } = useLocalSearchParams<{ dialogId: string; taskName?: string }>();
    const { theme } = useUnistyles();
    const router = useRouter();
    const profile = useDootaskProfile();
    const userCache = useDootaskUserCache();
    const userAvatars = useDootaskUserAvatars();
    const id = Number(dialogId);

    // Message state
    const [messages, setMessages] = React.useState<DooTaskDialogMsg[]>([]);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [sending, setSending] = React.useState(false);
    const [wsEnabled, setWsEnabled] = React.useState(false);

    // Ref for messages (used by handleLoadMore to avoid dependency on messages array)
    const messagesRef = React.useRef(messages);
    messagesRef.current = messages;

    // Reply state
    const [replyTo, setReplyTo] = React.useState<{ msg: DooTaskDialogMsg; senderName: string } | null>(null);

    // Long-press menu
    const [menuVisible, setMenuVisible] = React.useState(false);
    const [menuItems, setMenuItems] = React.useState<ActionMenuItem[]>([]);

    // Image viewer
    const [imageViewerVisible, setImageViewerVisible] = React.useState(false);
    const [imageViewerIndex, setImageViewerIndex] = React.useState(0);
    const [viewerImages, setViewerImages] = React.useState<{ uri: string }[]>([]);

    // Pre-collect file-upload image URLs (type='image' with path) for gallery browsing.
    // Uses a ref so handleImagePress doesn't depend on the array identity.
    const fileImageUrlsRef = React.useRef<{ uri: string }[]>([]);
    React.useMemo(() => {
        const urls: { uri: string }[] = [];
        const base = (profile?.serverUrl || '').replace(/\/+$/, '') + '/';
        for (const msg of messages) {
            if (msg.type === 'image') {
                const path = msg.msg?.path || msg.msg?.url || msg.msg?.thumb;
                if (path) {
                    const resolved = path.replace(/\{\{RemoteURL\}\}/g, base);
                    const url = resolved.startsWith('http') ? resolved : base + resolved.replace(/^\/+/, '');
                    urls.push({ uri: thumbRestore(url) });
                }
            }
        }
        fileImageUrlsRef.current = urls;
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
                // API returns newest-first, which is what inverted FlatList needs
                setMessages(dedupeMessagesById(list));
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
            setWsEnabled(true);
        }
    }, [profile, id]);

    React.useEffect(() => {
        fetchMessages();
    }, [fetchMessages]);

    // Load older messages
    const handleLoadMore = React.useCallback(async () => {
        if (!profile || loadingMore || !hasMore || messagesRef.current.length === 0) return;
        setLoadingMore(true);
        try {
            const oldestMsg = messagesRef.current[messagesRef.current.length - 1];
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
                    const prev = messagesRef.current;
                    const merged = dedupeMessagesById([...prev, ...list]);
                    const hasNewMessages = merged.length > prev.length;
                    if (hasNewMessages) {
                        setMessages(merged);
                        messagesRef.current = merged;
                    }
                    setHasMore(hasNewMessages && list.length >= 50);
                    const userIds = [...new Set(list.map(m => m.userid))];
                    if (userIds.length > 0) storage.getState().fetchDootaskUsers(userIds);
                }
            }
        } catch { /* ignore */ } finally {
            setLoadingMore(false);
        }
    }, [profile, id, loadingMore, hasMore]);

    // WebSocket for real-time — only connect after initial REST fetch completes
    // to prevent WS messages from being overwritten by setMessages()
    useDootaskWebSocket({
        serverUrl: profile?.serverUrl || '',
        token: profile?.token || '',
        dialogId: id,
        enabled: wsEnabled,
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

    // Long press menu -> reply / copy
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
        // Extract copyable text from the message
        const rawText = typeof msg.msg === 'string' ? msg.msg : (msg.msg?.text || '');
        if (rawText) {
            const plainText = rawText
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            if (plainText) {
                items.push({
                    label: t('dootask.copyMessage'),
                    onPress: () => { Clipboard.setStringAsync(plainText); },
                });
            }
        }
        setMenuItems(items);
        setMenuVisible(true);
    }, [userCache]);

    // Render ChatHeaderView directly (same style as SessionView)
    // Right side: DooTask icon (task dialogs show a task icon, matching DooTask web)
    const header = React.useMemo(() => (
        <ChatHeaderView
            title={t('dootask.taskChat')}
            subtitle={taskName}
            onBackPress={() => router.back()}
            headerRight={() => (
                <View style={styles.headerIconButton}>
                    <Image
                        source={require('@/assets/images/icon-dootask.png')}
                        style={{ width: 28, height: 28 }}
                        contentFit="contain"
                    />
                </View>
            )}
        />
    ), [taskName, router]);

    // Image press -> open viewer
    // For file-upload images: show all file images as a gallery
    // For HTML-embedded images: show just the clicked image
    const handleImagePress = React.useCallback((url: string) => {
        const original = thumbRestore(url);
        const fileImages = fileImageUrlsRef.current;
        const idx = fileImages.findIndex(img => img.uri === original);
        if (idx >= 0) {
            setViewerImages(fileImages);
            setImageViewerIndex(idx);
        } else {
            // Image from HTML content — not in the pre-collected gallery
            setViewerImages([{ uri: original }]);
            setImageViewerIndex(0);
        }
        setImageViewerVisible(true);
    }, []);

    const content = !(error && messages.length === 0) ? (
        <ChatMessageList
            messages={messages}
            currentUserId={profile?.userId || 0}
            userNames={userCache}
            userAvatars={userAvatars}
            onLoadMore={handleLoadMore}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onMessageLongPress={handleMessageLongPress}
            onImagePress={handleImagePress}
            serverUrl={profile?.serverUrl || ''}
        />
    ) : null;

    const placeholder = error && messages.length === 0 ? (
        <View style={styles.center}>
            <Text style={{ color: theme.colors.textDestructive }}>{error}</Text>
        </View>
    ) : null;

    const input = (
        <ChatInput
            onSendText={handleSendText}
            onSendImage={handleSendImage}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            sending={sending}
        />
    );

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            {header}
            <View style={[styles.body, { backgroundColor: theme.colors.surface }]}>
                <AgentContentView
                    content={content}
                    placeholder={placeholder}
                    input={input}
                />
            </View>
            <ActionMenuModal
                visible={menuVisible}
                items={menuItems}
                onClose={() => setMenuVisible(false)}
            />
            <ImageViewer
                images={viewerImages}
                initialIndex={imageViewerIndex}
                visible={imageViewerVisible}
                onClose={() => setImageViewerVisible(false)}
            />
        </>
    );
});

// --- Styles ---

const styles = StyleSheet.create((_theme) => ({
    body: {
        flex: 1,
    },
    center: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    headerIconButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
