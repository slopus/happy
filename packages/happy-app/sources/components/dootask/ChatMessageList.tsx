import * as React from 'react';
import { View, Text, FlatList, ActivityIndicator, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { ChatBubble } from './ChatBubble';
import type { DooTaskDialogMsg, DisplayMessage, PendingMessage } from '@/sync/dootask/types';

// Threshold in pixels for showing the scroll-to-bottom button
const SCROLL_THRESHOLD = 100;

const AI_ASSISTANT_USERID = -1;

function isPending(msg: DisplayMessage): msg is PendingMessage {
    return '_pendingId' in msg;
}

/** Convert a PendingMessage into a DooTaskDialogMsg shape so ChatBubble renderers work unchanged. */
function buildFakeDooTaskMsg(pending: PendingMessage): DooTaskDialogMsg {
    let msg: any;
    if (pending.type === 'text') {
        msg = { text: pending.msg, type: 'md' };
    } else if (pending.type === 'image') {
        msg = { url: pending.msg }; // base64 data URI works as Image source
    } else {
        msg = { name: pending.msg.name, size: 0 };
    }
    return {
        id: 0,
        dialog_id: pending.dialog_id,
        userid: pending.userid,
        type: pending.type,
        msg,
        reply_id: pending.reply_id,
        reply_num: 0,
        created_at: pending.created_at,
        emoji: [],
        bot: 0,
        modify: 0,
        forward_id: null,
        forward_num: 0,
    };
}

type ChatMessageListProps = {
    messages: DisplayMessage[];
    currentUserId: number;
    userNames: Record<number, string>;
    userAvatars: Record<number, string | null>;
    userDisabledAt: Record<number, string | null>;
    onLoadMore: () => void;
    loadingMore: boolean;
    loading?: boolean;
    hasMore: boolean;
    onMessageLongPress: (msg: DooTaskDialogMsg, layout?: { y: number; height: number }) => void;
    onImagePress: (url: string) => void;
    onEmojiPress?: (msgId: number, symbol: string) => void;
    onRetry?: (pendingId: string) => void;
    serverUrl: string;
};

/** Resolve a potentially relative avatar URL to an absolute one, handling {{RemoteURL}} placeholder. */
function resolveAvatarUrl(avatarPath: string | null | undefined, serverUrl: string): string | null {
    if (!avatarPath) return null;
    const base = serverUrl.replace(/\/+$/, '') + '/';
    const resolved = avatarPath.replace(/\{\{RemoteURL\}\}/g, base);
    if (resolved.startsWith('http') || resolved.startsWith('//')) return resolved;
    return base + resolved.replace(/^\/+/, '');
}

/**
 * Inverted FlatList that renders a scrollable chat message list with date separators.
 * Messages array is expected newest-first (index 0 = newest).
 * The inverted FlatList renders newest at the bottom of the screen.
 */
export const ChatMessageList = React.memo(({
    messages,
    currentUserId,
    userNames,
    userAvatars,
    userDisabledAt,
    onLoadMore,
    loadingMore,
    loading,
    hasMore,
    onMessageLongPress,
    onImagePress,
    onEmojiPress,
    onRetry,
    serverUrl,
}: ChatMessageListProps) => {
    const { theme } = useUnistyles();
    const flatListRef = React.useRef<FlatList>(null);

    // Scroll-to-bottom button visibility
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    // Track the newest message created_at when button became visible (for unread count)
    const lastSeenCreatedAtRef = React.useRef<string>(messages[0]?.created_at ?? '');

    // Calculate unread count: only messages newer than when button appeared
    let unreadCount = 0;
    if (showScrollButton) {
        for (const msg of messages) {
            if (msg.created_at > lastSeenCreatedAtRef.current) {
                unreadCount++;
            } else {
                break; // messages sorted newest-first
            }
        }
    }

    const handleScroll = React.useCallback((event: any) => {
        const offsetY = event.nativeEvent.contentOffset.y;
        const shouldShow = offsetY > SCROLL_THRESHOLD;
        setShowScrollButton(prev => {
            if (shouldShow && !prev) {
                lastSeenCreatedAtRef.current = messages[0]?.created_at ?? '';
            }
            return shouldShow;
        });
    }, [messages]);

    const handleScrollToBottom = React.useCallback(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    }, []);

    // Build a map from message id -> message for resolving reply_id references
    const replyMsgMap = React.useMemo(() => {
        const map = new Map<number, DooTaskDialogMsg>();
        for (const msg of messages) {
            if (!isPending(msg)) {
                map.set(msg.id, msg);
            }
        }
        return map;
    }, [messages]);

    const handleEndReached = React.useCallback(() => {
        if (hasMore && !loadingMore) {
            onLoadMore();
        }
    }, [hasMore, loadingMore, onLoadMore]);

    const renderItem = React.useCallback(({ item, index }: { item: DisplayMessage; index: number }) => {
        const pending = isPending(item);
        const bubbleMsg = pending ? buildFakeDooTaskMsg(item) : item;
        // 'sending-quiet' behaves like a real message for layout purposes (no forced avatar/spacing)
        const isQuietPending = pending && item._pending === 'sending-quiet';
        const isVisiblePending = pending && !isQuietPending;

        // Date separator logic:
        // Since the list is inverted, the NEXT item in the array (index + 1) appears ABOVE in the UI.
        // We show a date separator above the current bubble when the date differs from the next item.
        const currentDate = item.created_at.substring(0, 10); // YYYY-MM-DD
        const nextMsg = index < messages.length - 1 ? messages[index + 1] : null;
        const nextDate = nextMsg ? nextMsg.created_at.substring(0, 10) : null;
        const showDateSeparator = !pending && (!nextDate || nextDate !== currentDate);

        // Avatar grouping: show avatar on the FIRST message of a sender group (reading top-to-bottom).
        // In inverted FlatList, "above" = index + 1. Show avatar when the message above is
        // from a different user or doesn't exist, OR when a date separator breaks the group.
        const isSystemMsg = (type: string) => type === 'notice' || type === 'tag' || type === 'top' || type === 'todo';
        const showAvatar = isVisiblePending || !nextMsg || nextMsg.userid !== item.userid || isSystemMsg(nextMsg.type) || showDateSeparator;

        // Spacing rule:
        // - Compact spacing for consecutive messages from the same sender (same date block)
        // - Larger spacing when a new sender group starts
        const isConsecutiveSameSender =
            !isVisiblePending &&
            !!nextMsg &&
            nextMsg.userid === item.userid &&
            !isSystemMsg(nextMsg.type) &&
            !isSystemMsg(item.type) &&
            !showDateSeparator;

        // Resolve reply message
        const replyMsg = item.reply_id ? replyMsgMap.get(item.reply_id) ?? null : null;
        const replySenderName = replyMsg
            ? (replyMsg.userid === AI_ASSISTANT_USERID ? t('dootask.aiAssistant') : userNames[replyMsg.userid])
            : undefined;

        return (
            <View style={isConsecutiveSameSender ? styles.itemWithoutAvatar : styles.itemWithAvatar}>
                {showDateSeparator && (
                    <View style={styles.dateSeparator}>
                        <Text style={[styles.dateText, { color: theme.colors.textSecondary, backgroundColor: theme.colors.header.background }]}>
                            {currentDate.startsWith(new Date().getFullYear().toString()) ? currentDate.substring(5) : currentDate}
                        </Text>
                    </View>
                )}
                <ChatBubble
                    msg={bubbleMsg}
                    currentUserId={currentUserId}
                    senderName={userNames[item.userid]}
                    avatarUrl={resolveAvatarUrl(userAvatars[item.userid], serverUrl)}
                    disabledAt={userDisabledAt[item.userid]}
                    showAvatar={showAvatar}
                    replyMsg={replyMsg}
                    replySenderName={replySenderName}
                    onImagePress={onImagePress}
                    onLongPress={onMessageLongPress}
                    onEmojiPress={onEmojiPress}
                    serverUrl={serverUrl}
                    pending={pending ? item._pending : undefined}
                    onRetry={pending ? () => onRetry?.(item._pendingId) : undefined}
                    userNames={userNames}
                />
            </View>
        );
    }, [messages, currentUserId, userNames, userAvatars, userDisabledAt, replyMsgMap, onImagePress, onMessageLongPress, onEmojiPress, onRetry, serverUrl, theme]);

    const keyExtractor = React.useCallback((msg: DisplayMessage) =>
        isPending(msg) ? msg._pendingId : msg.id.toString()
    , []);

    const listFooter = React.useMemo(() => {
        if (!loadingMore) return null;
        return (
            <View style={styles.loadingFooter}>
                <ActivityIndicator size="small" />
            </View>
        );
    }, [loadingMore]);

    const listEmpty = React.useMemo(() => (
        <View style={styles.emptyContainer}>
            {loading ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : (
                <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                    {t('dootask.chatEmpty')}
                </Text>
            )}
        </View>
    ), [loading, theme]);

    // Force FlatList to re-render when avatar data loads asynchronously
    const extraData = React.useMemo(() => ({ userAvatars, userNames, userDisabledAt }), [userAvatars, userNames, userDisabledAt]);

    return (
        <View style={styles.wrapper}>
            <FlatList
                ref={flatListRef}
                data={messages}
                inverted={true}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                extraData={extraData}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onEndReached={handleEndReached}
                onEndReachedThreshold={0.3}
                ListFooterComponent={listFooter}
                ListEmptyComponent={listEmpty}
                contentContainerStyle={styles.contentContainer}
                initialNumToRender={50}
                maxToRenderPerBatch={50}
                windowSize={11}
            />

            {/* Scroll to bottom button */}
            {showScrollButton && (
                <View pointerEvents="box-none" style={{ position: 'absolute', bottom: 16, right: 16 }}>
                    <Pressable
                        onPress={handleScrollToBottom}
                        style={{
                            backgroundColor: theme.colors.surfaceHighest,
                            borderRadius: 20,
                            width: 40,
                            height: 40,
                            alignItems: 'center',
                            justifyContent: 'center',
                            shadowColor: theme.colors.shadow.color,
                            shadowOffset: { width: 0, height: 2 },
                            shadowOpacity: theme.colors.shadow.opacity,
                            shadowRadius: 4,
                            elevation: 4,
                        }}
                    >
                        <Ionicons name="chevron-down" size={24} color={theme.colors.text} />
                        {unreadCount > 0 && (
                            <View style={{
                                position: 'absolute',
                                top: -4,
                                right: -4,
                                backgroundColor: theme.colors.status.connected,
                                borderRadius: 10,
                                minWidth: 20,
                                height: 20,
                                alignItems: 'center',
                                justifyContent: 'center',
                                paddingHorizontal: 4,
                            }}>
                                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                                    {unreadCount > 99 ? '99+' : unreadCount}
                                </Text>
                            </View>
                        )}
                    </Pressable>
                </View>
            )}
        </View>
    );
});

// --- Styles ---

const styles = StyleSheet.create((theme) => ({
    wrapper: {
        flex: 1,
    },
    contentContainer: {
        paddingVertical: theme.margins.sm,
        flexGrow: 1,
    },
    itemWithAvatar: {
        marginBottom: 22,
    },
    itemWithoutAvatar: {
        marginBottom: 10,
    },
    dateSeparator: {
        alignItems: 'center',
        marginVertical: theme.margins.lg,
    },
    dateText: {
        ...Typography.default(),
        fontSize: 12,
        paddingHorizontal: theme.margins.md,
        paddingVertical: theme.margins.xs,
        borderRadius: 999,
    },
    loadingFooter: {
        paddingVertical: theme.margins.lg,
        alignItems: 'center',
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ scaleY: -1 }],
    },
    emptyText: {
        ...Typography.default(),
        fontSize: 14,
    },
}));
