import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, Platform, Pressable, Text, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { Typography } from '@/constants/Typography';
import { sync } from '@/sync/sync';

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasOlderMessages, isLoadingOlder } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            hasOlderMessages={hasOlderMessages}
            isLoadingOlder={isLoadingOlder}
        />
    )
});

const LoadOlderMessages = React.memo((props: { sessionId: string; hasOlderMessages: boolean; isLoadingOlder: boolean }) => {
    const { theme } = useUnistyles();
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();

    const handlePress = useCallback(() => {
        void sync.fetchOlderMessages(props.sessionId).catch(() => {});
    }, [props.sessionId]);

    return (
        <View style={{ alignItems: 'center', paddingTop: headerHeight + safeArea.top + 16, paddingBottom: 16 }}>
            {props.hasOlderMessages && (
                props.isLoadingOlder ? (
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                ) : (
                    <Pressable
                        onPress={handlePress}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: theme.colors.surface,
                        }}
                    >
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() }}>
                            Load older messages
                        </Text>
                    </Pressable>
                )
            )}
            {!props.hasOlderMessages && (
                <View style={{ height: 16 }} />
            )}
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
    hasOlderMessages: boolean,
    isLoadingOlder: boolean,
}) => {
    const keyExtractor = useCallback((item: any) => item.id, []);
    const renderItem = useCallback(({ item }: { item: any }) => (
        <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
    ), [props.metadata, props.sessionId]);
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
            ListFooterComponent={
                <LoadOlderMessages
                    sessionId={props.sessionId}
                    hasOlderMessages={props.hasOlderMessages}
                    isLoadingOlder={props.isLoadingOlder}
                />
            }
        />
    )
});
