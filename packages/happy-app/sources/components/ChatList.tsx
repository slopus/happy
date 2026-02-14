import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, Platform, Pressable, Text, View } from 'react-native';
import { useCallback, useRef, useState } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { layout } from './layout';

export const ChatList = React.memo((props: { session: Session; onFillInput?: (text: string, allOptions?: string[]) => void; onLoadMore?: () => void }) => {
    const { messages, hasMore } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            hasMore={hasMore}
            onFillInput={props.onFillInput}
            onLoadMore={props.onLoadMore}
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

// Threshold in pixels for showing the scroll-to-bottom button
const SCROLL_THRESHOLD = 100;

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasMore: boolean,
    onFillInput?: (text: string, allOptions?: string[]) => void,
    onLoadMore?: () => void,
}) => {
    const { theme } = useUnistyles();
    const flatListRef = useRef<FlatList>(null);

    // Track if scroll-to-bottom button should be visible
    const [showScrollButton, setShowScrollButton] = useState(false);

    // Track the newest message timestamp when button became visible (for unread count)
    const lastSeenTimestampRef = useRef<number>(props.messages[0]?.createdAt ?? 0);

    // Prevent duplicate load-more calls
    const isLoadingMoreRef = useRef(false);

    // Calculate unread count: count messages newer than the last seen timestamp
    let unreadCount = 0;
    if (showScrollButton) {
        for (const msg of props.messages) {
            if (msg.createdAt > lastSeenTimestampRef.current) {
                unreadCount++;
            } else {
                break; // messages are sorted newest-first, no need to continue
            }
        }
    }

    const keyExtractor = useCallback((item: any) => item.id, []);
    const renderItem = useCallback(({ item, index }: { item: any, index: number }) => (
        <MessageView
            message={item}
            metadata={props.metadata}
            sessionId={props.sessionId}
            isNewestMessage={index === 0}
            onFillInput={props.onFillInput}
        />
    ), [props.metadata, props.sessionId, props.onFillInput]);

    // Handle scroll position changes
    const handleScroll = useCallback((event: any) => {
        const offsetY = event.nativeEvent.contentOffset.y;
        const shouldShow = offsetY > SCROLL_THRESHOLD;

        setShowScrollButton(prev => {
            // When button becomes visible, record newest message timestamp
            if (shouldShow && !prev) {
                lastSeenTimestampRef.current = props.messages[0]?.createdAt ?? 0;
            }
            return shouldShow;
        });
    }, [props.messages]);

    // Scroll to bottom when button is pressed
    const handleScrollToBottom = useCallback(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    }, []);

    // Handle load more when scrolling to top (oldest messages)
    const handleEndReached = useCallback(() => {
        if (!props.hasMore || !props.onLoadMore || isLoadingMoreRef.current) {
            return;
        }
        isLoadingMoreRef.current = true;
        Promise.resolve(props.onLoadMore()).finally(() => {
            isLoadingMoreRef.current = false;
        });
    }, [props.hasMore, props.onLoadMore]);

    // Loading indicator shown at the top (oldest end) of the list
    const listFooter = React.useMemo(() => (
        <View>
            <ListHeader />
            {props.hasMore && (
                <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            )}
        </View>
    ), [props.hasMore, theme.colors.textSecondary]);

    return (
        <View style={{ flex: 1 }}>
            <FlatList
                ref={flatListRef}
                data={props.messages}
                inverted={true}
                keyExtractor={keyExtractor}
                maintainVisibleContentPosition={{
                    minIndexForVisible: 0,
                    autoscrollToTopThreshold: 100,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
                ListFooterComponent={listFooter}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onEndReached={handleEndReached}
                onEndReachedThreshold={0.5}
            />

            {/* Scroll to bottom button - positioned relative to content area */}
            {showScrollButton && (
                <View
                    pointerEvents="box-none"
                    style={{
                        position: 'absolute',
                        bottom: 16,
                        left: 0,
                        right: 0,
                        alignItems: 'center',
                    }}
                >
                    <View
                        pointerEvents="box-none"
                        style={{
                            width: '100%',
                            maxWidth: layout.maxWidth,
                            alignItems: 'flex-end',
                            paddingRight: 16,
                        }}
                    >
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
                                    <Text style={{
                                        color: '#fff',
                                        fontSize: 12,
                                        fontWeight: '600',
                                    }}>
                                        {unreadCount > 99 ? '99+' : unreadCount}
                                    </Text>
                                </View>
                            )}
                        </Pressable>
                    </View>
                </View>
            )}
        </View>
    )
});