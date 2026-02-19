import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { FlatList, Platform, Text, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { FastScrollbar, useFastScrollbar } from './FastScrollbar';
import { useCollapseListener } from '@/hooks/useCollapsedTools';
import Animated from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';

type DateSeparatorItem = {
    kind: 'date-separator';
    id: string;
    timestamp: number;
};

type ChatListItem = Message | DateSeparatorItem;

const MS_PER_DAY = 86400000;
const MS_PER_MINUTE = 60000;
const MIN_SEPARATOR_GAP_MS = 5 * MS_PER_MINUTE;

const dayStamp = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());

const isSameDay = (a: number, b: number) => {
    const dateA = new Date(a);
    const dateB = new Date(b);
    return dateA.getFullYear() === dateB.getFullYear()
        && dateA.getMonth() === dateB.getMonth()
        && dateA.getDate() === dateB.getDate();
};

const formatSeparatorLabel = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const timeLabel = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diffDays = Math.floor((dayStamp(now) - dayStamp(date)) / MS_PER_DAY);

    if (diffDays <= 0) {
        return timeLabel;
    }

    if (diffDays === 1) {
        return `${t('sessionHistory.yesterday')} ${timeLabel}`;
    }

    if (diffDays < 7) {
        const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
        return `${weekday} ${timeLabel}`;
    }

    const includeYear = date.getFullYear() !== now.getFullYear();
    const dateLabel = date.toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        ...(includeYear ? { year: 'numeric' } : {})
    });
    return `${dateLabel} ${timeLabel}`;
};

const isDateSeparator = (item: ChatListItem): item is DateSeparatorItem => item.kind === 'date-separator';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
        />
    )
});

const ListHeader = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />;
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
}) => {
    const flatListRef = React.useRef<FlatList>(null);
    const [contentHeight, setContentHeight] = React.useState(0);
    const [containerHeight, setContainerHeight] = React.useState(0);

    // Track scroll position in a ref for reliable JS thread access
    const lastScrollOffset = React.useRef(0);

    // Callback to update scroll offset ref from UI thread
    const handleScrollOffsetChange = useCallback((offset: number) => {
        lastScrollOffset.current = offset;
    }, []);

    // Use shared value for scroll position to avoid re-renders
    const { scrollY, scrollHandler } = useFastScrollbar(handleScrollOffsetChange);

    // Track scroll state before collapse to preserve scroll position
    const scrollStateBeforeCollapse = React.useRef<{
        contentHeight: number;
        scrollOffset: number;
    } | null>(null);

    // Listen for collapse events to preserve scroll position
    const handleCollapseEvent = useCallback((isCollapsing: boolean) => {
        // Store current scroll state IMMEDIATELY before any re-render happens
        // Use the ref value which is always up-to-date on JS thread
        scrollStateBeforeCollapse.current = {
            contentHeight: contentHeight,
            scrollOffset: lastScrollOffset.current
        };
    }, [contentHeight]);

    useCollapseListener(handleCollapseEvent);

    const listItems = React.useMemo(() => {
        if (!props.messages.length) {
            return props.messages as ChatListItem[];
        }

        const items: ChatListItem[] = [];
        for (let i = 0; i < props.messages.length; i++) {
            const message = props.messages[i];
            const next = props.messages[i + 1];
            items.push(message);

            const shouldInsertSeparator = !next
                || !isSameDay(message.createdAt, next.createdAt)
                || (message.createdAt - next.createdAt > MIN_SEPARATOR_GAP_MS);

            if (shouldInsertSeparator) {
                items.push({
                    kind: 'date-separator',
                    id: `date-${message.id}`,
                    timestamp: message.createdAt
                });
            }
        }

        return items;
    }, [props.messages]);

    const keyExtractor = useCallback((item: ChatListItem) => item.id, []);
    const renderItem = useCallback(({ item }: { item: ChatListItem }) => {
        if (isDateSeparator(item)) {
            return <DateSeparator timestamp={item.timestamp} />;
        }
        return <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />;
    }, [props.metadata, props.sessionId]);

    const handleContentSizeChange = useCallback((width: number, height: number) => {
        // If we have stored scroll state from before collapse, adjust scroll position
        if (scrollStateBeforeCollapse.current !== null && flatListRef.current) {
            const { contentHeight: oldHeight, scrollOffset: oldOffset } = scrollStateBeforeCollapse.current;
            const heightDiff = oldHeight - height;

            // For inverted list: adjust scroll to maintain visual position
            if (heightDiff !== 0 && oldOffset > 0) {
                const newOffset = Math.max(0, oldOffset - heightDiff);
                // Use requestAnimationFrame to ensure adjustment happens after FlatList internal updates
                requestAnimationFrame(() => {
                    flatListRef.current?.scrollToOffset({ offset: newOffset, animated: false });
                });
            }
            scrollStateBeforeCollapse.current = null;
        }
        setContentHeight(height);
    }, []);

    const handleLayout = useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
        setContainerHeight(event.nativeEvent.layout.height);
    }, []);

    const handleScrollbarDrag = useCallback((offset: number) => {
        flatListRef.current?.scrollToOffset({ offset, animated: false });
    }, []);

    return (
        <View style={{ flex: 1 }}>
            <Animated.FlatList
                ref={flatListRef as any}
                data={listItems}
                inverted={true}
                keyExtractor={keyExtractor}
                maintainVisibleContentPosition={{
                    minIndexForVisible: 0,
                    autoscrollToTopThreshold: 10,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
                ListFooterComponent={<ListHeader />}
                onScroll={scrollHandler}
                onContentSizeChange={handleContentSizeChange}
                onLayout={handleLayout}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
            />
            <FastScrollbar
                scrollY={scrollY}
                contentHeight={contentHeight}
                containerHeight={containerHeight}
                onScrollTo={handleScrollbarDrag}
                inverted={true}
            />
        </View>
    )
});

const DateSeparator = React.memo((props: { timestamp: number }) => {
    return (
        <View style={styles.dateSeparatorContainer}>
            <View style={styles.dateSeparatorPill}>
                <Text style={styles.dateSeparatorText}>{formatSeparatorLabel(props.timestamp)}</Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    dateSeparatorContainer: {
        alignItems: 'center',
        paddingVertical: 6,
    },
    dateSeparatorPill: {
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 10,
    },
    dateSeparatorText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
}));
