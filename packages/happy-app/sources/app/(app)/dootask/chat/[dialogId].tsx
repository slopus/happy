import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { AgentContentView } from '@/components/AgentContentView';
import { storage, useDootaskProfile, useDootaskUserCache, useDootaskUserAvatars, useDootaskUserDisabledAt } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { dootaskFetchDialogMessages, dootaskSendTextMessage, dootaskSendFileMessage, dootaskSendFileByUri, dootaskToggleEmoji, dootaskFetchDialogOne, dootaskFetchDialogUsers } from '@/sync/dootask/api';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { DialogDetailModal } from '@/components/dootask/DialogDetailModal';
import { useDootaskWebSocket } from '@/hooks/useDootaskWebSocket';
import { ChatMessageList } from '@/components/dootask/ChatMessageList';
import { thumbRestore } from '@/components/dootask/ChatBubble';
import { ChatInput } from '@/components/dootask/ChatInput';
import { ImageViewer } from '@/components/ImageViewer';
import { MessageContextMenu, ContextMenuAction, MessagePreview } from '@/components/dootask/MessageContextMenu';
import { layout } from '@/components/layout';
import type { DooTaskDialogMsg, PendingMessage, DisplayMessage, DooTaskDialog, DooTaskDialogUser } from '@/sync/dootask/types';
import { generateMockMessages, MOCK_USER_NAMES, MOCK_USER_AVATARS } from '@/components/dootask/__dev__/mockChatMessages';

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
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default React.memo(function DooTaskChat() {
    const { dialogId, taskName } = useLocalSearchParams<{ dialogId: string; taskName?: string }>();
    const { theme } = useUnistyles();
    const router = useRouter();
    const profile = useDootaskProfile();
    const userCache = useDootaskUserCache();
    const userAvatars = useDootaskUserAvatars();
    const userDisabledAt = useDootaskUserDisabledAt();
    const isMock = dialogId === 'mock';
    const id = isMock ? 0 : Number(dialogId);
    const idRef = React.useRef(id);
    idRef.current = id;

    // Live task name from store (updates when task title changes via WebSocket)
    const liveTaskName = storage(useShallow((s) =>
        s.dootaskTasks.find((t) => t.dialog_id === id)?.name
    ));
    const subtitle = liveTaskName || taskName;

    // Message state
    const [messages, setMessages] = React.useState<DooTaskDialogMsg[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [wsEnabled, setWsEnabled] = React.useState(false);

    // Dialog detail state — reset when dialogId changes
    const [dialogInfo, setDialogInfo] = React.useState<DooTaskDialog | null>(null);
    const [dialogMembers, setDialogMembers] = React.useState<DooTaskDialogUser[]>([]);
    const [dialogMembersLoading, setDialogMembersLoading] = React.useState(false);
    const detailModalRef = React.useRef<BottomSheetModal>(null);

    React.useEffect(() => {
        setDialogInfo(null);
        setDialogMembers([]);
        setDialogMembersLoading(false);
        detailModalRef.current?.dismiss();
    }, [id]);

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

    // Long-press context menu
    const [contextMenu, setContextMenu] = React.useState<{
        msg: DooTaskDialogMsg;
        actions: ContextMenuAction[];
        preview: MessagePreview;
        y: number;
        height: number;
    } | null>(null);

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
        const requestId = id;
        // Mock mode: load generated preview data, skip API/WS
        if (isMock) {
            setMessages(generateMockMessages(profile.userId));
            setHasMore(false);
            setLoading(false);
            return;
        }
        try {
            const res = await dootaskFetchDialogMessages(profile.serverUrl, profile.token, {
                dialog_id: id,
                take: 50,
            });
            if (requestId !== idRef.current) return;
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
            if (requestId !== idRef.current) return;
            setError(e instanceof Error ? e.message : t('dootask.errorLoadChat'));
        } finally {
            if (requestId === idRef.current) {
                setLoading(false);
                setWsEnabled(true);
            }
        }
    }, [profile, id, isMock]);

    React.useEffect(() => {
        fetchMessages();
    }, [fetchMessages]);

    // Fetch dialog info for header icon
    React.useEffect(() => {
        if (!profile || isMock) return;
        let stale = false;
        dootaskFetchDialogOne(profile.serverUrl, profile.token, id).then(res => {
            if (stale) return;
            if (res.ret === 1 && res.data) {
                setDialogInfo({
                    id: res.data.id,
                    name: res.data.name,
                    type: res.data.type,
                    group_type: res.data.group_type,
                    avatar: res.data.avatar || null,
                    owner_id: res.data.owner_id || 0,
                });
            }
        }).catch(() => {});
        return () => { stale = true; };
    }, [profile, id, isMock]);

    // Fetch dialog members for header count
    React.useEffect(() => {
        if (!profile || isMock) return;
        let stale = false;
        dootaskFetchDialogUsers(profile.serverUrl, profile.token, id).then(res => {
            if (stale) return;
            if (res.ret === 1 && Array.isArray(res.data)) {
                setDialogMembers(res.data);
            }
        }).catch(() => {});
        return () => { stale = true; };
    }, [profile, id, isMock]);

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

    // WebSocket for real-time — subscribes to global WS,
    // only enabled after initial REST fetch to prevent race conditions
    useDootaskWebSocket({
        dialogId: id,
        enabled: wsEnabled,
        onMessage: React.useCallback((msg: DooTaskDialogMsg) => {
            setMessages(prev => {
                if (prev.some(m => m.id === msg.id)) return prev;
                return [msg, ...prev];
            });
            // If WS delivers a message from us, clean up the oldest matching pending
            // (including 'error' — WS proves the message succeeded even if HTTP failed).
            // Search backwards: pending array is newest-first, oldest = last index = FIFO order.
            if (msg.userid === (profile?.userId || 0)) {
                setPendingMessages(prev => {
                    let idx = -1;
                    for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].type === msg.type) { idx = i; break; }
                    }
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

    // Long press context menu -> reply / copy / emoji
    const handleMessageLongPress = React.useCallback((msg: DooTaskDialogMsg, layout?: { y: number; height: number }) => {
        const isSelf = msg.userid === (profile?.userId || 0);
        const senderName = msg.userid === -1 ? t('dootask.aiAssistant') : (userCache[msg.userid] || String(msg.userid));
        const actions: ContextMenuAction[] = [
            {
                label: t('dootask.reply'),
                icon: 'arrow-undo',
                onPress: () => { setReplyTo({ msg, senderName }); },
            },
        ];
        const rawText = typeof msg.msg === 'string' ? msg.msg : (msg.msg?.text || '');
        let plainText = '';
        if (rawText) {
            plainText = rawText
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            if (plainText) {
                actions.push({
                    label: t('dootask.copyMessage'),
                    icon: 'copy-outline',
                    onPress: () => { Clipboard.setStringAsync(plainText); },
                });
            }
        }

        // Build preview content — always plain text to avoid WebView layout issues
        let previewLabel = '';
        switch (msg.type) {
            case 'text':
            case 'longtext':
                previewLabel = plainText || '';
                break;
            case 'image': previewLabel = plainText || '[Photo]'; break;
            case 'file': previewLabel = msg.msg?.name || '[File]'; break;
            case 'record': previewLabel = t('dootask.voiceMessage'); break;
            default: previewLabel = plainText || '';
        }
        const previewContent = (
            <Text style={{ color: theme.colors.text, fontSize: 15, lineHeight: 22 }} numberOfLines={3}>
                {previewLabel}
            </Text>
        );

        setContextMenu({
            msg,
            actions,
            preview: { content: previewContent, senderName: isSelf ? undefined : senderName, isSelf },
            y: layout?.y ?? 200,
            height: layout?.height ?? 60,
        });
    }, [userCache, profile?.userId, theme]);

    // Emoji toggle handler
    const handleEmojiToggle = React.useCallback(async (msgId: number, symbol: string) => {
        if (!profile) return;
        try {
            const res = await dootaskToggleEmoji(profile.serverUrl, profile.token, { msg_id: msgId, symbol });
            if (res.ret === 1 && res.data) {
                setMessages(prev => prev.map(m => m.id === res.data.id ? { ...m, emoji: res.data.emoji } : m));
            }
        } catch {
            // Silent fail — WS update will sync eventually
        }
    }, [profile]);

    const handleOpenDetail = React.useCallback(async () => {
        detailModalRef.current?.present();
        // Members already loaded on mount; only re-fetch if empty
        if (!profile || dialogMembersLoading || dialogMembers.length > 0) return;
        const requestId = id;
        setDialogMembersLoading(true);
        try {
            const res = await dootaskFetchDialogUsers(profile.serverUrl, profile.token, id);
            if (requestId !== idRef.current) return;
            if (res.ret === 1 && Array.isArray(res.data)) {
                setDialogMembers(res.data);
            }
        } catch {} finally {
            if (requestId === idRef.current) {
                setDialogMembersLoading(false);
            }
        }
    }, [profile, id, dialogMembersLoading, dialogMembers.length]);

    // Render ChatHeaderView directly (same style as SessionView)
    // Right side: DooTask icon / dialog avatar (tappable to open detail modal)
    const resolvedDialogAvatar = React.useMemo(() => {
        if (!dialogInfo?.avatar || !profile?.serverUrl) return null;
        const base = profile.serverUrl.replace(/\/+$/, '') + '/';
        const resolved = dialogInfo.avatar.replace(/\{\{RemoteURL\}\}/g, base);
        if (resolved.startsWith('http') || resolved.startsWith('//')) return resolved;
        return base + resolved.replace(/^\/+/, '');
    }, [dialogInfo?.avatar, profile?.serverUrl]);

    const chatTitle = dialogMembers.length > 0
        ? `${t('dootask.taskChat')} (${dialogMembers.length})`
        : t('dootask.taskChat');

    const header = React.useMemo(() => (
        <ChatHeaderView
            title={chatTitle}
            subtitle={subtitle}
            onBackPress={() => router.back()}
            headerRight={() => (
                <Pressable style={styles.headerIconButton} onPress={handleOpenDetail}>
                    {resolvedDialogAvatar ? (
                        <Image
                            source={{ uri: resolvedDialogAvatar }}
                            style={{ width: 28, height: 28, borderRadius: 14 }}
                            contentFit="cover"
                        />
                    ) : (
                        <Image
                            source={require('@/assets/images/icon-dootask.png')}
                            style={{ width: 28, height: 28 }}
                            contentFit="contain"
                        />
                    )}
                </Pressable>
            )}
        />
    ), [chatTitle, subtitle, router, resolvedDialogAvatar, handleOpenDetail]);

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

    // In mock mode, merge mock user info with real caches
    const effectiveUserNames = isMock ? { ...userCache, ...MOCK_USER_NAMES } : userCache;
    const effectiveUserAvatars = isMock ? { ...userAvatars, ...MOCK_USER_AVATARS } : userAvatars;
    const effectiveUserDisabledAt = isMock ? {} : userDisabledAt;

    const content = !(error && messages.length === 0) ? (
        <ChatMessageList
            messages={displayMessages}
            currentUserId={profile?.userId || 0}
            userNames={effectiveUserNames}
            userAvatars={effectiveUserAvatars}
            userDisabledAt={effectiveUserDisabledAt}
            onLoadMore={handleLoadMore}
            loading={loading}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onMessageLongPress={handleMessageLongPress}
            onImagePress={handleImagePress}
            onEmojiPress={handleEmojiToggle}
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
            <View style={[styles.body, { backgroundColor: theme.colors.surface, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }]}>
                <AgentContentView
                    content={content}
                    placeholder={placeholder}
                    input={input}
                />
            </View>
            <MessageContextMenu
                visible={contextMenu !== null}
                messageY={contextMenu?.y ?? 0}
                messageHeight={contextMenu?.height ?? 0}
                actions={contextMenu?.actions ?? []}
                preview={contextMenu?.preview}
                onEmojiSelect={(symbol) => {
                    if (contextMenu?.msg) handleEmojiToggle(contextMenu.msg.id, symbol);
                }}
                onClose={() => setContextMenu(null)}
            />
            <ImageViewer
                images={viewerImages}
                initialIndex={imageViewerIndex}
                visible={imageViewerVisible}
                onClose={() => setImageViewerVisible(false)}
            />
            <DialogDetailModal
                ref={detailModalRef}
                dialogName={subtitle || dialogInfo?.name || ''}
                dialogId={id}
                groupType={dialogInfo?.group_type || ''}
                ownerId={dialogInfo?.owner_id || 0}
                members={dialogMembers}
                loading={dialogMembersLoading}
                serverUrl={profile?.serverUrl || ''}
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
