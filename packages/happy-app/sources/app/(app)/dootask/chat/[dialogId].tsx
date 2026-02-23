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
import { dootaskFetchDialogMessages, dootaskSendTextMessage, dootaskSendFileMessage, dootaskSendFileByUri } from '@/sync/dootask/api';
import { useDootaskWebSocket } from '@/hooks/useDootaskWebSocket';
import { ChatMessageList } from '@/components/dootask/ChatMessageList';
import { thumbRestore } from '@/components/dootask/ChatBubble';
import { ChatInput } from '@/components/dootask/ChatInput';
import { ImageViewer } from '@/components/ImageViewer';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import type { DooTaskDialogMsg, PendingMessage, DisplayMessage } from '@/sync/dootask/types';

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

function nowTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
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
    const [loading, setLoading] = React.useState(true);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [wsEnabled, setWsEnabled] = React.useState(false);

    // Optimistic pending messages
    const [pendingMessages, setPendingMessages] = React.useState<PendingMessage[]>([]);
    const retryFnsRef = React.useRef<Map<string, () => void>>(new Map());
    const pendingIdCounter = React.useRef(0);
    const pendingTimersRef = React.useRef(new Set<ReturnType<typeof setTimeout>>());

    // Clean up all pending timers on unmount
    React.useEffect(() => {
        return () => {
            for (const id of pendingTimersRef.current) clearTimeout(id);
        };
    }, []);

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

    // Merge pending + real messages for display (pending at front = bottom of inverted list)
    const displayMessages: DisplayMessage[] = React.useMemo(
        () => [...pendingMessages, ...messages],
        [pendingMessages, messages],
    );

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
            setLoading(false);
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
                if (prev.some(m => m.id === msg.id)) return prev;
                return [msg, ...prev];
            });
            // If WS delivers a message from us, clean up any matching pending
            // (including 'error' — WS proves the message succeeded even if HTTP failed).
            if (msg.userid === (profile?.userId || 0)) {
                setPendingMessages(prev => {
                    const idx = prev.findIndex(p => p.type === msg.type);
                    if (idx === -1) return prev;
                    retryFnsRef.current.delete(prev[idx]._pendingId);
                    return prev.filter((_, i) => i !== idx);
                });
            }
            if (msg.userid) storage.getState().fetchDootaskUsers([msg.userid]);
        }, [profile?.userId]),
        onMessageUpdate: React.useCallback((msg: DooTaskDialogMsg) => {
            setMessages(prev => prev.map(m => m.id === msg.id ? msg : m));
        }, []),
        onMessageDelete: React.useCallback((msgId: number) => {
            setMessages(prev => prev.filter(m => m.id !== msgId));
        }, []),
    });

    // --- Optimistic send helpers ---

    const createPending = React.useCallback((type: 'text' | 'image' | 'file', msg: any): PendingMessage => {
        const pendingId = `pending-${++pendingIdCounter.current}-${Date.now()}`;
        return {
            _pendingId: pendingId,
            _pending: type === 'text' ? 'sending-quiet' : 'sending',
            dialog_id: id,
            userid: profile?.userId || 0,
            type,
            msg,
            reply_id: replyTo?.msg.id ?? null,
            created_at: nowTimestamp(),
        };
    }, [id, profile?.userId, replyTo]);

    const markPendingError = React.useCallback((pendingId: string, errorMsg: string) => {
        setPendingMessages(prev =>
            prev.map(m => m._pendingId === pendingId
                ? { ...m, _pending: 'error' as const, _errorMsg: errorMsg }
                : m,
            ),
        );
    }, []);

    const removePending = React.useCallback((pendingId: string) => {
        setPendingMessages(prev => prev.filter(m => m._pendingId !== pendingId));
        retryFnsRef.current.delete(pendingId);
    }, []);

    // Send text (optimistic — quiet for 2s, then show spinner)
    const handleSendText = React.useCallback((text: string) => {
        if (!profile) return;
        const pending = createPending('text', text);
        const replyId = replyTo?.msg.id;
        setPendingMessages(prev => [pending, ...prev]);
        setReplyTo(null);

        // After 2s, upgrade 'sending-quiet' → 'sending' to show spinner
        const timers = pendingTimersRef.current;
        const quietTimer = setTimeout(() => {
            timers.delete(quietTimer);
            setPendingMessages(prev =>
                prev.map(m => m._pendingId === pending._pendingId && m._pending === 'sending-quiet'
                    ? { ...m, _pending: 'sending' as const }
                    : m,
                ),
            );
        }, 2000);
        timers.add(quietTimer);

        const doSend = async () => {
            try {
                const res = await dootaskSendTextMessage(profile.serverUrl, profile.token, {
                    dialog_id: id,
                    text,
                    reply_id: replyId,
                });
                if (res.ret !== 1) {
                    clearTimeout(quietTimer); timers.delete(quietTimer);
                    markPendingError(pending._pendingId, res.msg || t('dootask.errorSendMessage'));
                    return;
                }
                clearTimeout(quietTimer); timers.delete(quietTimer);
                // Upgrade: replace pending with real message from API response
                const realMsg: DooTaskDialogMsg = res.data;
                removePending(pending._pendingId);
                setMessages(prev => {
                    if (prev.some(m => m.id === realMsg.id)) return prev;
                    return [realMsg, ...prev];
                });
            } catch (e) {
                clearTimeout(quietTimer); timers.delete(quietTimer);
                markPendingError(pending._pendingId, e instanceof Error ? e.message : t('dootask.errorSendMessage'));
            }
        };

        retryFnsRef.current.set(pending._pendingId, () => {
            setPendingMessages(prev =>
                prev.map(m => m._pendingId === pending._pendingId ? { ...m, _pending: 'sending' as const } : m),
            );
            doSend();
        });

        doSend();
    }, [profile, id, replyTo, createPending, markPendingError, removePending]);

    // Send image (optimistic)
    const handleSendImage = React.useCallback((base64DataUri: string) => {
        if (!profile) return;
        const pending = createPending('image', base64DataUri);
        const replyId = replyTo?.msg.id;
        setPendingMessages(prev => [pending, ...prev]);
        setReplyTo(null);

        const doSend = async () => {
            try {
                const res = await dootaskSendFileMessage(profile.serverUrl, profile.token, {
                    dialog_id: id,
                    image64: base64DataUri,
                    reply_id: replyId,
                });
                if (res.ret !== 1) {
                    markPendingError(pending._pendingId, res.msg || t('dootask.errorSendMessage'));
                    return;
                }
                // Upgrade: replace pending with real message from API response
                const realMsg: DooTaskDialogMsg = res.data;
                removePending(pending._pendingId);
                setMessages(prev => {
                    if (prev.some(m => m.id === realMsg.id)) return prev;
                    return [realMsg, ...prev];
                });
            } catch (e) {
                markPendingError(pending._pendingId, e instanceof Error ? e.message : t('dootask.errorSendMessage'));
            }
        };

        retryFnsRef.current.set(pending._pendingId, () => {
            setPendingMessages(prev =>
                prev.map(m => m._pendingId === pending._pendingId ? { ...m, _pending: 'sending' as const } : m),
            );
            doSend();
        });

        doSend();
    }, [profile, id, replyTo, createPending, markPendingError, removePending]);

    // Send file (optimistic)
    const handleSendFile = React.useCallback((file: { uri: string; name: string; mimeType: string }) => {
        if (!profile) return;
        const pending = createPending('file', file);
        const replyId = replyTo?.msg.id;
        setPendingMessages(prev => [pending, ...prev]);
        setReplyTo(null);

        const doSend = async () => {
            try {
                const res = await dootaskSendFileByUri(profile.serverUrl, profile.token, {
                    dialog_id: id,
                    fileUri: file.uri,
                    fileName: file.name,
                    mimeType: file.mimeType,
                    reply_id: replyId,
                });
                if (res.ret !== 1) {
                    markPendingError(pending._pendingId, res.msg || t('dootask.errorSendMessage'));
                    return;
                }
                // Upgrade: replace pending with real message from API response
                const realMsg: DooTaskDialogMsg = res.data;
                removePending(pending._pendingId);
                setMessages(prev => {
                    if (prev.some(m => m.id === realMsg.id)) return prev;
                    return [realMsg, ...prev];
                });
            } catch (e) {
                markPendingError(pending._pendingId, e instanceof Error ? e.message : t('dootask.errorSendMessage'));
            }
        };

        retryFnsRef.current.set(pending._pendingId, () => {
            setPendingMessages(prev =>
                prev.map(m => m._pendingId === pending._pendingId ? { ...m, _pending: 'sending' as const } : m),
            );
            doSend();
        });

        doSend();
    }, [profile, id, replyTo, createPending, markPendingError, removePending]);

    // Retry a failed pending message
    const handleRetry = React.useCallback((pendingId: string) => {
        const fn = retryFnsRef.current.get(pendingId);
        if (fn) fn();
    }, []);

    // Long press menu -> reply / copy
    const handleMessageLongPress = React.useCallback((msg: DooTaskDialogMsg) => {
        const items: ActionMenuItem[] = [
            {
                label: t('dootask.reply'),
                onPress: () => {
                    setReplyTo({
                        msg,
                        senderName: msg.userid === -1 ? t('dootask.aiAssistant') : (userCache[msg.userid] || String(msg.userid)),
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
            messages={displayMessages}
            currentUserId={profile?.userId || 0}
            userNames={userCache}
            userAvatars={userAvatars}
            onLoadMore={handleLoadMore}
            loading={loading}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onMessageLongPress={handleMessageLongPress}
            onImagePress={handleImagePress}
            onRetry={handleRetry}
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
            onSendFile={handleSendFile}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
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
