import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, Platform, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { EmptyMessages } from './EmptyMessages';
import { useUnistyles } from 'react-native-unistyles';
import { FlashList } from '@shopify/flash-list';
import { LegendList } from '@legendapp/list';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, isLoaded } = useSessionMessages(props.session.id);
    const { theme } = useUnistyles();
    // const placeholder = messages.length === 0 ? (
    //     <>
    //         {isLoaded ? (
    //             <EmptyMessages session={props.session} />
    //         ) : (
    //             <ActivityIndicator size="small" color={theme.colors.textSecondary} />
    //         )}
    //     </>
    // ) : null;

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
    return <View style={{ flexDirection: 'row', alignItems: 'center', height: (Platform.OS === 'web' ? 0 : (headerHeight + safeArea.top)) + 32 }} />;
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
    const keyExtractor = useCallback((item: any) => item.id, []);
    const renderItem = useCallback(({ item }: { item: any }) => (
        <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
    ), [props.metadata, props.sessionId]);
    const maintainVisibleContentPosition = React.useMemo(() => ({
        minIndexForVisible: 0,
        // autoscrollToBottomThreshold: 10,
    }), []);
    return (
        <FlatList
            // removeClippedSubviews={true}
            data={props.messages}
            inverted={true}
            keyExtractor={keyExtractor}
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="none"
            renderItem={renderItem}
            // contentContainerStyle={contentContainerStyle}
            ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
            ListFooterComponent={<ListHeader />}
        />
    )

    // return (
    //     <FlashList
    //         // removeClippedSubviews={true}
    //         data={props.messages}
    //         // inverted={true}
    //         keyExtractor={keyExtractor}
    //         // maintainVisibleContentPosition={maintainVisibleContentPosition}
    //         keyboardShouldPersistTaps="handled"
    //         keyboardDismissMode="none"
    //         renderItem={renderItem}
    //         // contentContainerStyle={contentContainerStyle}
    //         ListHeaderComponent={<ListHeader />}
    //         ListFooterComponent={<ListFooter sessionId={props.sessionId} />}
    //     />
    // )

    // return (
    //     <LegendList
    //         // removeClippedSubviews={true}
    //         data={props.messages}
    //         // inverted={true}
    //         keyExtractor={keyExtractor}
            
    //         // maintainVisibleContentPosition={maintainVisibleContentPosition}
    //         keyboardShouldPersistTaps="handled"
    //         keyboardDismissMode="none"
    //         renderItem={renderItem}
    //         // contentContainerStyle={contentContainerStyle}
    //         ListHeaderComponent={<ListHeader />}
    //         ListFooterComponent={<ListFooter sessionId={props.sessionId} />}
    //     />
    // )
});