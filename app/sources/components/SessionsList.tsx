import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { SessionListItem } from '@/sync/storage';
import { getSessionName, isSessionOnline, formatLastSeen } from '@/utils/sessionUtils';
import { isMessageFromAssistant } from '@/utils/messageUtils';
import { Avatar } from './Avatar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';

interface SessionsListProps {
    data: SessionListItem[];
    selectedSessionId?: string | null;
    onSessionPress?: (sessionId: string) => void;
}

export function SessionsList({ data, selectedSessionId, onSessionPress }: SessionsListProps) {
    const router = useRouter();
    const safeArea = useSafeAreaInsets();

    const keyExtractor = React.useCallback((item: SessionListItem, index: number) => {
        if (typeof item === 'string') {
            return `header-${item}-${index}`;
        }
        return `session-${item.id}`;
    }, []);

    const renderItem = React.useCallback(({ item }: { item: SessionListItem }) => {
        if (typeof item === 'string') {
            const isOnline = item === 'online';
            const title = isOnline ? 'Active Sessions' : 'Previous Sessions';
            return (
                <View style={{ paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        {isOnline && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#34C759', marginRight: 8 }} />}
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#999', ...Typography.default() }}>{title}</Text>
                    </View>
                </View>
            );
        }

        const session = item;
        return (
            <SessionItem
                session={session}
                selectedSessionId={selectedSessionId}
                onSessionPress={onSessionPress}
                router={router}
            />
        );
    }, [router, selectedSessionId, onSessionPress]);

    const getItemType = React.useCallback((item: SessionListItem) => {
        return typeof item === 'string' ? 'header' : 'session';
    }, []);

    const ItemSeparatorComponent = React.useCallback(() => {
        return <View style={{ height: 1, backgroundColor: 'black', opacity: 0.05, marginLeft: 16 }} />;
    }, []);

    return (
        <FlashList
            data={data}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            estimatedItemSize={96}
            contentContainerStyle={{ paddingBottom: safeArea.bottom + 16 }}
            ItemSeparatorComponent={ItemSeparatorComponent}
        />
    );
}

// Sub-component that handles session message logic
function SessionItem({ session, selectedSessionId, router }: {
    session: Session;
    selectedSessionId?: string | null;
    onSessionPress?: (sessionId: string) => void;
    router: any;
}) {

    // Find the last non-summary message
    // const actualLastMessage = getLastNonSummaryMessage(messages, session.lastMessage);

    // Use the actual last message for preview
    const online = isSessionOnline(session);
    const sessionName = getSessionName(session);
    const lastSeenText = formatLastSeen(session.presence);
    const thinking = session.thinking && session.thinkingAt > Date.now() - 1000 * 30; // 30 seconds timeout
    const isFromAssistant = session.lastMessage?.role === 'agent' || thinking;
    const isSelected = selectedSessionId === session.id;
    let message: string | null = null;
    if (session.lastMessage) {
        if (session.lastMessage.role === 'user') {
            message = session.lastMessage.content.text;
        } else if (session.lastMessage.role === 'agent') {
            for (let c of session.lastMessage.content) {
                if (c.type === 'text') {
                    message = c.text;
                }
                if (c.type === 'tool-call') {
                    message = 'Tool call: ' + c.name;
                }
                if (c.type === 'tool-result') {
                    message = 'Tool result received';
                }
                if (c.type === 'summary') {
                    message = 'Summary: ' + c.summary;
                }
            }
        }
    }

    return (
        <Pressable
            style={{
                height: 96,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                backgroundColor: isSelected ? 'rgba(0, 0, 0, 0.05)' : 'transparent'
            }}
            onPress={() => {
                router.push(`/session/${session.id}`);
            }}
        >
            <Avatar id={session.id} size={56} monochrome={!online} />
            <View style={{ flex: 1, marginLeft: 16 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <Text style={{ fontSize: 20, fontWeight: '600', opacity: online ? 1 : 0.5, flex: 1, marginRight: 8, ...Typography.default('semiBold') }} numberOfLines={1}>
                        {sessionName}
                    </Text>
                    <Text style={{ fontSize: 14, color: '#999', ...Typography.default() }}>
                        {lastSeenText}
                    </Text>
                </View>
                {session.lastMessage ? (
                    <Text style={{ fontSize: 14, color: '#999' }} numberOfLines={1}>
                        <Text style={{ color: online ? (isFromAssistant ? '#007AFF' : '#34C759') : '#999', fontWeight: '600', ...Typography.default() }}>
                            {isFromAssistant ? 'Claude' : 'You'}:
                        </Text>

                        {thinking && (
                            <Text className="text-sm text-blue-500 flex-1">
                                {' thinking...'}
                            </Text>
                        )}

                        {!thinking && (
                            <Text className="text-sm text-gray-500 flex-1" numberOfLines={1}>
                                {' ' + (message ?? '<no message>')}
                            </Text>
                        )}

                    </Text>
                ) : (
                    <Text style={{ fontSize: 14, color: '#999' }}>No messages yet</Text>
                )}
            </View>
        </Pressable>
    );
}