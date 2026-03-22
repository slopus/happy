import * as React from 'react';
import { useSession, useV3SessionMessages } from "@/sync/storage";
import { FlatList, Platform, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { V3MessageView } from './parts/V3MessageView';
import { Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { type v3 } from '@slopus/happy-sync';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages } = useV3SessionMessages(props.session.id);

    return (
        <V3ChatListInternal
            sessionId={props.session.id}
            messages={messages}
        />
    );
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

// v3: renders MessageWithParts directly via PartView — no conversion
const V3ChatListInternal = React.memo((props: {
    sessionId: string,
    messages: v3.MessageWithParts[],
}) => {
    const keyExtractor = useCallback((item: v3.MessageWithParts) => item.info.id as string, []);
    const renderItem = useCallback(({ item }: { item: v3.MessageWithParts }) => (
        <V3MessageView message={item} sessionId={props.sessionId} />
    ), [props.sessionId]);
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
            ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
            ListFooterComponent={<ListHeader />}
        />
    );
});

