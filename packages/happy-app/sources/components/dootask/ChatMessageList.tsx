import * as React from 'react';
import { View, Text, FlatList, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { ChatBubble } from './ChatBubble';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

const AI_ASSISTANT_USERID = -1;

type ChatMessageListProps = {
    messages: DooTaskDialogMsg[];
    currentUserId: number;
    userNames: Record<number, string>;
    userAvatars: Record<number, string | null>;
    onLoadMore: () => void;
    loadingMore: boolean;
    loading?: boolean;
    hasMore: boolean;
    onMessageLongPress: (msg: DooTaskDialogMsg) => void;
    onImagePress: (url: string) => void;
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
    onLoadMore,
    loadingMore,
    loading,
    hasMore,
    onMessageLongPress,
    onImagePress,
    serverUrl,
}: ChatMessageListProps) => {
    const { theme } = useUnistyles();

    // Build a map from message id -> message for resolving reply_id references
    const replyMsgMap = React.useMemo(() => {
        const map = new Map<number, DooTaskDialogMsg>();
        for (const msg of messages) {
            map.set(msg.id, msg);
        }
        return map;
    }, [messages]);

    const handleEndReached = React.useCallback(() => {
        if (hasMore && !loadingMore) {
            onLoadMore();
        }
    }, [hasMore, loadingMore, onLoadMore]);

    const renderItem = React.useCallback(({ item, index }: { item: DooTaskDialogMsg; index: number }) => {
        // Date separator logic:
        // Since the list is inverted, the NEXT item in the array (index + 1) appears ABOVE in the UI.
        // We show a date separator above the current bubble when the date differs from the next item.
        const currentDate = item.created_at.substring(0, 10); // YYYY-MM-DD
        const nextMsg = index < messages.length - 1 ? messages[index + 1] : null;
        const nextDate = nextMsg ? nextMsg.created_at.substring(0, 10) : null;
        const showDateSeparator = !nextDate || nextDate !== currentDate;

        // Avatar grouping: show avatar on the FIRST message of a sender group (reading top-to-bottom).
        // In inverted FlatList, "above" = index + 1. Show avatar when the message above is
        // from a different user or doesn't exist, OR when a date separator breaks the group.
        const showAvatar = !nextMsg || nextMsg.userid !== item.userid || nextMsg.type === 'notice' || showDateSeparator;

        // Spacing rule:
        // - Compact spacing for consecutive messages from the same sender (same date block)
        // - Larger spacing when a new sender group starts
        const isConsecutiveSameSender =
            !!nextMsg &&
            nextMsg.userid === item.userid &&
            nextMsg.type !== 'notice' &&
            item.type !== 'notice' &&
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
                            {currentDate}
                        </Text>
                    </View>
                )}
                <ChatBubble
                    msg={item}
                    currentUserId={currentUserId}
                    senderName={userNames[item.userid]}
                    avatarUrl={resolveAvatarUrl(userAvatars[item.userid], serverUrl)}
                    showAvatar={showAvatar}
                    replyMsg={replyMsg}
                    replySenderName={replySenderName}
                    onImagePress={onImagePress}
                    onLongPress={onMessageLongPress}
                    serverUrl={serverUrl}
                />
            </View>
        );
    }, [messages, currentUserId, userNames, userAvatars, replyMsgMap, onImagePress, onMessageLongPress, serverUrl, theme]);

    const keyExtractor = React.useCallback((msg: DooTaskDialogMsg) => msg.id.toString(), []);

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
    const extraData = React.useMemo(() => ({ userAvatars, userNames }), [userAvatars, userNames]);

    return (
        <FlatList
            data={messages}
            inverted={true}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            extraData={extraData}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.3}
            ListFooterComponent={listFooter}
            ListEmptyComponent={listEmpty}
            contentContainerStyle={styles.contentContainer}
            initialNumToRender={50}
            maxToRenderPerBatch={50}
            windowSize={11}
        />
    );
});

// --- Styles ---

const styles = StyleSheet.create((theme) => ({
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
