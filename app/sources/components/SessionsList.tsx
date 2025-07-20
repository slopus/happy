import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { SessionListItem } from '@/sync/storage';
import { getSessionName, isSessionOnline, formatLastSeen } from '@/utils/sessionUtils';
import { getMessagePreview, isMessageFromAssistant } from '@/utils/messageUtils';
import { Avatar } from './Avatar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { Typography } from '@/constants/Typography';

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
        const lastMessage = session.lastMessage;
        const messagePreview = getMessagePreview(lastMessage, 50);
        const online = isSessionOnline(session);
        const sessionName = getSessionName(session);
        const lastSeenText = formatLastSeen(session.active, session.activeAt);
        const thinking = session.thinking && session.thinkingAt > Date.now() - 1000 * 30; // 30 seconds timeout
        const isFromAssistant = isMessageFromAssistant(lastMessage) || thinking;
        const isSelected = selectedSessionId === session.id;

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
                    if (onSessionPress) {
                        onSessionPress(session.id);
                    } else {
                        router.push(`/session/${session.id}` as any);
                    }
                }}
            >
                <Avatar id={session.id} size={56} monochrome={!online} />
                <View style={{ flex: 1, marginLeft: 16 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <Text style={{ fontSize: 20, fontWeight: '600', opacity: online ? 1 : 0.5, flex: 1, marginRight: 8, ...Typography.default('semiBold') }} numberOfLines={1}>
                            /{sessionName}
                        </Text>
                        <Text style={{ fontSize: 14, color: '#999', ...Typography.default() }}>
                            {lastSeenText}
                        </Text>
                    </View>
                    {lastMessage ? (
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
                                    {' ' + messagePreview}
                                </Text>
                            )}

                        </Text>
                    ) : (
                        <Text style={{ fontSize: 14, color: '#999' }}>No messages yet</Text>
                    )}
                </View>
            </Pressable>
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