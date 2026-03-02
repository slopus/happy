import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, View } from 'react-native';
import { useCallback, useRef, useState } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';

export const ChatList = React.memo((props: { session: Session; onEditMessage?: (text: string) => void }) => {
    const { messages, hasMore } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            hasMore={hasMore}
            onEditMessage={props.onEditMessage}
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

const LoadingMore = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: headerHeight + safeArea.top + 32, paddingVertical: 16 }}>
            <ActivityIndicator size="small" />
        </View>
    );
});

const SCROLL_THRESHOLD = 300;

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasMore: boolean,
    onEditMessage?: (text: string) => void,
}) => {
    const { theme } = useUnistyles();
    const flatListRef = useRef<FlatList>(null);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hiddenMessages, setHiddenMessages] = useState<Set<string>>(new Set());

    const keyExtractor = useCallback((item: any) => item.id, []);
    const handleRegenerate = useCallback((messageId: string) => {
        const idx = props.messages.findIndex(m => m.id === messageId);
        if (idx < 0) return;
        const msg = props.messages[idx];
        // If it's a user message, resend its text directly
        if (msg.kind === 'user-text') {
            sync.sendMessage(props.sessionId, msg.text);
            return;
        }
        // For agent messages, find the preceding user message
        for (let i = idx - 1; i >= 0; i--) {
            const prev = props.messages[i];
            if (prev.kind === 'user-text') {
                sync.sendMessage(props.sessionId, prev.text);
                return;
            }
        }
        sync.sendMessage(props.sessionId, 'Повтори последний ответ');
    }, [props.messages, props.sessionId]);

    const handleDelete = useCallback((messageId: string) => {
        setHiddenMessages(prev => new Set(prev).add(messageId));
    }, []);

    const handleEdit = useCallback((messageId: string, text: string) => {
        props.onEditMessage?.(text);
    }, [props.onEditMessage]);

    const visibleMessages = React.useMemo(() =>
        props.messages.filter(m => !hiddenMessages.has(m.id)),
    [props.messages, hiddenMessages]);

    const renderItem = useCallback(({ item }: { item: any }) => (
        <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} onRegenerate={handleRegenerate} onDelete={handleDelete} onEdit={handleEdit} />
    ), [props.metadata, props.sessionId, handleRegenerate, handleDelete, handleEdit]);

    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offset = e.nativeEvent.contentOffset.y;
        setShowScrollButton(offset > SCROLL_THRESHOLD);
    }, []);

    const scrollToBottom = useCallback(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, []);

    const handleEndReached = useCallback(async () => {
        if (!props.hasMore || loadingMore) return;
        setLoadingMore(true);
        try {
            await sync.fetchOlderMessages(props.sessionId);
        } catch (e) {
            console.error('Failed to load older messages:', e);
        } finally {
            setLoadingMore(false);
        }
    }, [props.hasMore, props.sessionId, loadingMore]);

    return (
        <View style={{ flex: 1 }}>
            <FlatList
                ref={flatListRef}
                data={visibleMessages}
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
                ListFooterComponent={loadingMore ? <LoadingMore /> : <ListHeader />}
                onScroll={handleScroll}
                scrollEventThrottle={100}
                onEndReached={handleEndReached}
                onEndReachedThreshold={0.5}
            />
            {showScrollButton && (
                <Pressable
                    onPress={scrollToBottom}
                    style={{
                        position: 'absolute',
                        bottom: 16,
                        right: 16,
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: theme.colors.surface,
                        alignItems: 'center',
                        justifyContent: 'center',
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.2,
                        shadowRadius: 4,
                        elevation: 4,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                    }}
                >
                    <Ionicons name="chevron-down" size={22} color={theme.colors.text} />
                </Pressable>
            )}
        </View>
    )
});
