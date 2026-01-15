import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { ActivityIndicator, FlatList, Platform, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, isLoaded } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            isLoaded={isLoaded}
        />
    )
});

const ListHeader = React.memo((props: { isLoadingOlder: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return (
        <View>
            {props.isLoadingOlder && (
                <View style={{ paddingVertical: 12 }}>
                    <ActivityIndicator size="small" />
                </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
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
    isLoaded: boolean,
}) => {
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);

    const keyExtractor = useCallback((item: any) => item.id, []);
    const renderItem = useCallback(({ item }: { item: any }) => (
        <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
    ), [props.metadata, props.sessionId]);

    const loadOlder = useCallback(async () => {
        if (!props.isLoaded || props.messages.length === 0) {
            return;
        }
        if (isLoadingOlder || hasMoreOlder === false) {
            return;
        }

        setIsLoadingOlder(true);
        try {
            const result = await sync.loadOlderMessages(props.sessionId);
            if (result.status === 'no_more') {
                setHasMoreOlder(false);
            } else if (result.status === 'loaded') {
                setHasMoreOlder(result.hasMore);
            }
        } catch (error) {
            console.error('Failed to load older messages:', error);
        } finally {
            setIsLoadingOlder(false);
        }
    }, [props.isLoaded, props.messages.length, props.sessionId, isLoadingOlder, hasMoreOlder]);

    const handleScroll = useCallback((e: any) => {
        const n = e?.nativeEvent;
        if (!n?.contentOffset || !n?.layoutMeasurement || !n?.contentSize) {
            return;
        }
        const distanceFromEnd = n.contentSize.height - (n.contentOffset.y + n.layoutMeasurement.height);
        if (distanceFromEnd < 200) {
            void loadOlder();
        }
    }, [loadOlder]);

    return (
        <FlatList
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
            onEndReachedThreshold={0.2}
            onEndReached={() => {
                void loadOlder();
            }}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
            ListFooterComponent={<ListHeader isLoadingOlder={isLoadingOlder} />}
        />
    )
});
