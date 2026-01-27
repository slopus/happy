import * as React from 'react';
import { useSession, useSessionMessages, useSessionPendingMessages } from "@/sync/storage";
import { FlatList, Platform, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { buildChatListItems, type ChatListItem } from '@/components/sessions/chatListItems';
import { PendingUserTextMessageView } from '@/components/sessions/pending/PendingUserTextMessageView';

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

export const ChatList = React.memo((props: { session: Session; bottomNotice?: ChatListBottomNotice | null }) => {
    const { messages } = useSessionMessages(props.session.id);
    const { messages: pendingMessages } = useSessionPendingMessages(props.session.id);
    const items = React.useMemo(() => buildChatListItems({ messages, pendingMessages }), [messages, pendingMessages]);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            items={items}
            bottomNotice={props.bottomNotice}
        />
    )
});

const ListHeader = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />;
});

const ListFooter = React.memo((props: { sessionId: string; bottomNotice?: ChatListBottomNotice | null }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter
            controlledByUser={session.agentState?.controlledByUser || false}
            notice={props.bottomNotice ?? null}
        />
    )
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    items: ChatListItem[],
    bottomNotice?: ChatListBottomNotice | null,
}) => {
    const keyExtractor = useCallback((item: ChatListItem) => item.id, []);
    const renderItem = useCallback(({ item }: { item: ChatListItem }) => {
        if (item.kind === 'pending-user-text') {
            return (
                <PendingUserTextMessageView
                    sessionId={props.sessionId}
                    message={item.pending}
                    otherPendingCount={item.otherPendingCount}
                />
            );
        }
        return <MessageView message={item.message} metadata={props.metadata} sessionId={props.sessionId} />;
    }, [props.metadata, props.sessionId]);
    return (
        <FlatList
            data={props.items}
            inverted={true}
            keyExtractor={keyExtractor}
            maintainVisibleContentPosition={{
                minIndexForVisible: 0,
                autoscrollToTopThreshold: 10,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            renderItem={renderItem}
            ListHeaderComponent={<ListFooter sessionId={props.sessionId} bottomNotice={props.bottomNotice} />}
            ListFooterComponent={<ListHeader />}
        />
    )
});
