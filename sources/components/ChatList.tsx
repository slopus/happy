import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { FlatList, Platform, View } from 'react-native';
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

    const keyExtractor = useCallback((item: any) => item.id, []);
    const renderItem = useCallback(({ item }: { item: any }) => (
        <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
    ), [props.metadata, props.sessionId]);

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
                data={props.messages}
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