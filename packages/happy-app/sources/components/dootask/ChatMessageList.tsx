import * as React from 'react';
import { View, Text, FlatList, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { ChatBubble } from './ChatBubble';
import type { DooTaskDialogMsg } from '@/sync/dootask/types';

type ChatMessageListProps = {
    messages: DooTaskDialogMsg[];
    currentUserId: number;
    userNames: Record<number, string>;
    onLoadMore: () => void;
    loadingMore: boolean;
    hasMore: boolean;
    onMessageLongPress: (msg: DooTaskDialogMsg) => void;
    onImagePress: (url: string) => void;
    serverUrl: string;
};

/**
 * Inverted FlatList that renders a scrollable chat message list with date separators.
 * Messages array is expected newest-first (index 0 = newest).
 * The inverted FlatList renders newest at the bottom of the screen.
 */
export const ChatMessageList = React.memo(({
    messages,
    currentUserId,
    userNames,
    onLoadMore,
    loadingMore,
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

        // Resolve reply message
        const replyMsg = item.reply_id ? replyMsgMap.get(item.reply_id) ?? null : null;
        const replySenderName = replyMsg ? userNames[replyMsg.userid] : undefined;

        return (
            <View>
                {showDateSeparator && (
                    <View style={styles.dateSeparator}>
                        <Text style={[styles.dateText, { color: theme.colors.textSecondary }]}>
                            {currentDate}
                        </Text>
                    </View>
                )}
                <ChatBubble
                    msg={item}
                    currentUserId={currentUserId}
                    senderName={userNames[item.userid]}
                    replyMsg={replyMsg}
                    replySenderName={replySenderName}
                    onImagePress={onImagePress}
                    onLongPress={onMessageLongPress}
                    serverUrl={serverUrl}
                />
            </View>
        );
    }, [messages, currentUserId, userNames, replyMsgMap, onImagePress, onMessageLongPress, serverUrl, theme]);

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
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                {t('dootask.chatEmpty')}
            </Text>
        </View>
    ), [theme]);

    return (
        <FlatList
            data={messages}
            inverted={true}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.3}
            ListFooterComponent={listFooter}
            ListEmptyComponent={listEmpty}
            contentContainerStyle={styles.contentContainer}
        />
    );
});

// --- Styles ---

const styles = StyleSheet.create((_theme) => ({
    contentContainer: {
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    dateSeparator: {
        alignItems: 'center',
        marginVertical: 8,
    },
    dateText: {
        ...Typography.default(),
        fontSize: 12,
    },
    loadingFooter: {
        paddingVertical: 12,
        alignItems: 'center',
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 32,
    },
    emptyText: {
        ...Typography.default(),
        fontSize: 14,
    },
}));
