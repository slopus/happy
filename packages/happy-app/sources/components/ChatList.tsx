import * as React from 'react';
import { useSessionMessages, useSyncSessionState } from "@/sync/storage";
import { FlatList, Platform, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { FlowView } from './FlowView';
import { type SessionMessage } from '@slopus/happy-sync';
import { makeSessionMessageId } from '@/sync/syncNodeStore';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages } = useSessionMessages(props.session.id);

    return (
        <ChatListInternal
            sessionId={props.session.id}
            messages={messages}
            metadata={props.session.metadata}
        />
    );
});

const ListHeader = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />;
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const syncSession = useSyncSessionState(props.sessionId);
    return (
        <>
            <FlowView flow={syncSession?.flow} />
            <ChatFooter controlledByUser={syncSession?.controlledByUser || false} />
        </>
    )
});

const ChatListInternal = React.memo((props: {
    sessionId: string,
    messages: SessionMessage[],
    metadata: Session['metadata'],
}) => {
    React.useEffect(() => {
        if (Platform.OS !== 'web') {
            return;
        }

        const target = globalThis as typeof globalThis & {
            __HAPPY_TRANSCRIPT_RENDER_COUNTS__?: Record<string, number>;
        };
        const counts = target.__HAPPY_TRANSCRIPT_RENDER_COUNTS__ ?? {};
        counts[props.sessionId] = (counts[props.sessionId] ?? 0) + 1;
        target.__HAPPY_TRANSCRIPT_RENDER_COUNTS__ = counts;
    });

    const keyExtractor = useCallback((_: SessionMessage, index: number) => makeSessionMessageId(index), []);
    const renderItem = useCallback(({ item, index }: { item: SessionMessage; index: number }) => (
        <MessageView
            message={item}
            sessionId={props.sessionId}
            messageId={makeSessionMessageId(index)}
            metadata={props.metadata}
        />
    ), [props.metadata, props.sessionId]);
    return (
        <FlatList
            testID="chat-transcript"
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
        />
    );
});
