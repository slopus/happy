import * as React from 'react';
import { useSession, useSessionMessages } from '@/sync/storage';
import { View } from 'react-native';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
        />
    );
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null;
    sessionId: string;
    messages: Message[];
}) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    const session = useSession(props.sessionId)!;

    // flex-direction: column-reverse gives us native browser reversed scroll
    // without scaleY(-1), so middle-click auto-scroll and wheel work correctly.
    // Messages are already newest-first from the store, which matches column-reverse order.
    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column-reverse',
                overflowY: 'auto',
                overflowX: 'hidden',
                height: '100%',
                WebkitOverflowScrolling: 'touch',
                scrollbarWidth: 'thin',
            }}
        >
            {/* In column-reverse, first DOM element = visual bottom */}
            <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
            {props.messages.map((message) => (
                <MessageView
                    key={message.id}
                    message={message}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                />
            ))}
            {/* Top spacer for header — last in DOM = visual top */}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </div>
    );
});
