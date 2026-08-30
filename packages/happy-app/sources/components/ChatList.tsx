import * as React from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@/utils/responsive';
import { useSession, useSessionMessages, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/storageTypes';
import { isSessionTurnActive } from '@/hooks/useGroupedMessages';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { ChatFooter } from './ChatFooter';
import { ConversationTranscript } from './ConversationTranscript';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasMoreOlder, isLoadingOlder } = useSessionMessages(props.session.id);
    const session = useSession(props.session.id);
    const groupToolCalls = useSetting('groupToolCalls');
    const hasPendingPermission = Boolean(
        session?.agentState?.requests && Object.keys(session.agentState.requests).length > 0,
    );
    const { canFork, forkFromMessage } = useSessionQuickActions(session!, {});
    const handleForkFromMessage = React.useCallback((
        messageId: string,
        rewindPointId: string | undefined,
        messageText: string,
        retainSelectedTurn?: boolean,
        messageCreatedAt?: number,
    ) => {
        forkFromMessage({
            messageId,
            messageText,
            messageCreatedAt: messageCreatedAt ?? 0,
            rewindPointId,
            retainSelectedTurn,
        });
    }, [forkFromMessage]);
    const handleEditUserMessage = React.useCallback(async (messageId: string, messageText: string) => {
        await sync.sendMessage(props.session.id, messageText, {
            source: 'chat',
            editedFromMessageId: messageId,
        });
    }, [props.session.id]);
    const handleLoadOlder = React.useCallback(() => {
        if (!hasMoreOlder || isLoadingOlder) return;
        void sync.loadOlderMessages(props.session.id);
    }, [hasMoreOlder, isLoadingOlder, props.session.id]);

    return (
        <ConversationTranscript
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            groupToolCalls={groupToolCalls}
            currentTurnActive={isSessionTurnActive(session)}
            hasPendingPermission={hasPendingPermission}
            onLoadOlder={handleLoadOlder}
            visualTop={<ListHeader isLoadingOlder={isLoadingOlder} />}
            visualBottom={<ListFooter sessionId={props.session.id} />}
            showMessageActions={Platform.OS === 'web'}
            canEditLatestUserMessage={session?.thinking !== true}
            onEditUserMessage={handleEditUserMessage}
            onForkFromMessage={canFork ? handleForkFromMessage : undefined}
        />
    );
});

const ListHeader = React.memo((props: { isLoadingOlder: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return (
        <View>
            {props.isLoadingOlder ? (
                <View style={{ paddingVertical: 12, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator size="small" />
                </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />;
});
