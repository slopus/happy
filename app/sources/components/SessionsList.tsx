import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Session } from '@/sync/storageTypes';
import { LegendList } from '@legendapp/list';
import { getSessionName, isSessionOnline, formatLastSeen } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface SessionsListProps {
    active: Session[];
    inactive: Session[];
}

interface SessionListItem {
    type: 'header' | 'item' | 'empty';
    title?: string;
    session?: Session;
    last: boolean;
}

export function SessionsList({ active, inactive }: SessionsListProps) {
    const router = useRouter();
    const safeArea = useSafeAreaInsets();

    // Create flat list data with headers
    const listData = React.useMemo(() => {
        const data: SessionListItem[] = [];

        // Add active sessions section (always show header)
        data.push({ type: 'header', title: 'Active Sessions', last: false });
        if (active.length > 0) {
            active.forEach((session, index) => data.push({ type: 'item', session, last: index === active.length - 1 }));
        } else {
            data.push({ type: 'empty', title: 'No active sessions', last: false });
        }

        // Add offline sessions
        if (inactive.length > 0) {
            data.push({ type: 'header', title: 'Offline Sessions', last: false });
            inactive.forEach((session, index) => data.push({ type: 'item', session, last: index === inactive.length - 1 }));
        }

        return data;
    }, [active, inactive]);

    // Memoize keyExtractor
    const keyExtractor = React.useCallback((item: SessionListItem, index: number) => {
        if (item.type === 'header') return `header-${item.title}`;
        if (item.type === 'empty') return `empty-${index}`;
        return `session-${item.session!.id}`;
    }, []);

    // Memoize ItemSeparatorComponent
    const ItemSeparatorComponent = React.useCallback(({ leadingItem }: { leadingItem: SessionListItem }) => {
        if (leadingItem.type === 'item' && !leadingItem.last) {
            return <View style={{ height: 1, backgroundColor: 'black', opacity: 0.05, marginLeft: 16 }} />;
        }
        return null;
    }, []);

    const renderItem = ({ item }: { item: SessionListItem }) => {
        if (item.type === 'header') {
            const isActive = item.title === 'Active Sessions';
            return (
                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        {isActive && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#34C759', marginRight: 8 }} />}
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#999' }}>{item.title}</Text>
                    </View>
                </View>
            );
        }

        if (item.type === 'empty') {
            return (
                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <Text style={{ fontSize: 14, color: '#999', fontStyle: 'italic' }}>{item.title}</Text>
                </View>
            );
        }

        const session = item.session!;
        const lastMessage = session.lastMessage;
        const lastMessageText = JSON.stringify(lastMessage);
        const messagePreview = lastMessageText.length > 50
            ? lastMessageText.substring(0, 50) + '...'
            : lastMessageText;
        const online = isSessionOnline(session);
        const sessionName = getSessionName(session);
        const lastSeenText = formatLastSeen(session.active, session.activeAt);
        const thinking = session.thinking && session.thinkingAt > Date.now() - 1000 * 30; // 30 seconds timeout
        const isFromAssistant = lastMessage?.content?.role === 'agent' || thinking;

        return (
            <Pressable
                style={{ height: 96, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}
                onPress={() => router.push(`/session/${session.id}` as any)}
            >
                <Avatar id={session.id} size={56} monochrome={!online} />
                <View style={{ flex: 1, marginLeft: 16 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <Text style={{ fontSize: 20, fontWeight: '600', opacity: online ? 1 : 0.5, flex: 1, marginRight: 8 }} numberOfLines={1}>
                            {sessionName}
                        </Text>
                        <Text style={{ fontSize: 14, color: '#999' }}>
                            {lastSeenText}
                        </Text>
                    </View>
                    {lastMessage ? (
                        <Text style={{ fontSize: 14, color: '#999' }} numberOfLines={1}>
                            <Text style={{ color: online ? (isFromAssistant ? '#007AFF' : '#34C759') : '#999', fontWeight: '600' }}>
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
    };

    return (
        <LegendList
            data={listData}
            renderItem={renderItem}
            estimatedItemSize={68}
            keyExtractor={keyExtractor}
            contentContainerStyle={{ paddingBottom: safeArea.bottom + 16 }}
            ItemSeparatorComponent={ItemSeparatorComponent}
        />
    );
}