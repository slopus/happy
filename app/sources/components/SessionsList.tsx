import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Session } from '@/sync/types';
import { LegendList } from '@legendapp/list';
import { getSessionName, isSessionOnline, formatLastSeen } from '@/utils/sessionUtils';

interface SessionsListProps {
    sessions: Session[];
}

interface SessionListItem {
    type: 'header' | 'item' | 'empty';
    title?: string;
    session?: Session;
}

export function SessionsList({ sessions }: SessionsListProps) {
    const router = useRouter();

    // Create flat list data with headers
    const listData = React.useMemo(() => {
        const data: SessionListItem[] = [];
        const activeSessions: Session[] = [];
        const offlineSessions: Session[] = [];

        // Split sessions into active and offline
        sessions.forEach(session => {
            if (isSessionOnline(session)) {
                activeSessions.push(session);
            } else {
                offlineSessions.push(session);
            }
        });

        // Sort both arrays by updatedAt (most recent first)
        activeSessions.sort((a, b) => b.updatedAt - a.updatedAt);
        offlineSessions.sort((a, b) => b.updatedAt - a.updatedAt);

        // Add active sessions section (always show header)
        data.push({ type: 'header', title: 'Active Sessions' });
        if (activeSessions.length > 0) {
            activeSessions.forEach(session => data.push({ type: 'item', session }));
        } else {
            data.push({ type: 'empty', title: 'No active sessions' });
        }

        // Add offline sessions
        if (offlineSessions.length > 0) {
            data.push({ type: 'header', title: 'Offline Sessions' });
            offlineSessions.forEach(session => data.push({ type: 'item', session }));
        }

        return data;
    }, [sessions]);

    const renderItem = ({ item }: { item: SessionListItem }) => {
        if (item.type === 'header') {
            const isActive = item.title === 'Active Sessions';
            return (
                <View className="px-4 py-2 bg-gray-100">
                    <View className="flex-row items-center">
                        {isActive && <View className="w-2 h-2 rounded-full bg-green-500 mr-2" />}
                        <Text className="text-sm font-semibold text-gray-500 uppercase">{item.title}</Text>
                    </View>
                </View>
            );
        }

        if (item.type === 'empty') {
            return (
                <View className="px-4 py-8 items-center">
                    <Text className="text-sm text-gray-400 italic">{item.title}</Text>
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
                style={({ pressed }) => pressed ? { backgroundColor: '#f5f5f5' } : {}}
                className="flex-row items-center px-4 py-3 bg-white"
                onPress={() => router.push(`/session/${session.id}` as any)}
            >
                <View className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3">
                    <Ionicons name="chatbox-outline" size={24} color="#666" />
                    <View className={`absolute top-0 right-0 w-2.5 h-2.5 rounded-full ${online ? 'bg-green-500' : 'bg-transparent'}`} />
                </View>
                <View className="flex-1">
                    <View className="flex-row justify-between items-center mb-0.5">
                        <Text className="text-base font-semibold text-black flex-1 mr-2" numberOfLines={1}>
                            {sessionName}
                        </Text>
                        <Text className="text-xs text-gray-400">
                            {lastSeenText}
                        </Text>
                    </View>
                    {lastMessage ? (
                        <View className="flex-row items-center">
                            <Text className={`text-sm font-semibold ${isFromAssistant ? 'text-blue-500' : 'text-green-500'}`}>
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

                        </View>
                    ) : (
                        <Text className="text-sm text-gray-500">No messages yet</Text>
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
            keyExtractor={(item, index) =>
                item.type === 'header' ? `header-${item.title}` :
                    item.type === 'empty' ? `empty-${index}` :
                        `session-${item.session!.id}`
            }
            contentContainerStyle={{ paddingBottom: 20 }}
            ItemSeparatorComponent={({ leadingItem }) =>
                leadingItem.type === 'item' ? <View className="h-px bg-gray-300 ml-17" /> : null
            }
        />
    );
}