import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Session } from '@/sync/types';
import { LegendList } from '@legendapp/list';

interface SessionsListProps {
    sessions: Session[];
}

interface SessionListItem {
    type: 'header' | 'item';
    title?: string;
    session?: Session;
}

export function SessionsList({ sessions }: SessionsListProps) {
    const router = useRouter();

    // Create flat list data with headers
    const listData = React.useMemo(() => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const lastWeek = new Date(today);
        lastWeek.setDate(lastWeek.getDate() - 7);

        const data: SessionListItem[] = [];
        const todaySessions: Session[] = [];
        const yesterdaySessions: Session[] = [];
        const lastWeekSessions: Session[] = [];
        const olderSessions: Session[] = [];

        sessions.forEach(session => {
            const sessionDate = new Date(session.updatedAt);
            if (sessionDate >= today) {
                todaySessions.push(session);
            } else if (sessionDate >= yesterday) {
                yesterdaySessions.push(session);
            } else if (sessionDate >= lastWeek) {
                lastWeekSessions.push(session);
            } else {
                olderSessions.push(session);
            }
        });

        if (todaySessions.length > 0) {
            data.push({ type: 'header', title: 'Today' });
            todaySessions.forEach(session => data.push({ type: 'item', session }));
        }
        if (yesterdaySessions.length > 0) {
            data.push({ type: 'header', title: 'Yesterday' });
            yesterdaySessions.forEach(session => data.push({ type: 'item', session }));
        }
        if (lastWeekSessions.length > 0) {
            data.push({ type: 'header', title: 'Last Week' });
            lastWeekSessions.forEach(session => data.push({ type: 'item', session }));
        }
        if (olderSessions.length > 0) {
            data.push({ type: 'header', title: 'Older' });
            olderSessions.forEach(session => data.push({ type: 'item', session }));
        }

        return data;
    }, [sessions]);

    const renderItem = ({ item }: { item: SessionListItem }) => {
        if (item.type === 'header') {
            return (
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>{item.title}</Text>
                </View>
            );
        }

        const session = item.session!;
        const lastMessage = session.lastMessage;
        const lastMessageText = JSON.stringify(lastMessage);
        const messagePreview = lastMessageText.length > 50 
            ? lastMessageText.substring(0, 50) + '...' 
            : lastMessageText;
        const isFromAssistant = lastMessage?.content?.role === 'agent';

        return (
            <Pressable
                style={({ pressed }) => [
                    styles.sessionItem,
                    pressed && styles.sessionItemPressed
                ]}
                onPress={() => router.push(`/session/${session.id}` as any)}
            >
                <View style={styles.sessionIcon}>
                    <Ionicons name="chatbox-outline" size={24} color="#666" />
                </View>
                <View style={styles.sessionContent}>
                    <Text style={styles.sessionTitle} numberOfLines={1}>
                        Session {session.id.slice(-6)}
                    </Text>
                    {lastMessage ? (
                        <View style={styles.messagePreviewContainer}>
                            <Text style={[styles.senderLabel, isFromAssistant ? styles.assistantLabel : styles.humanLabel]}>
                                {isFromAssistant ? 'Claude' : 'You'}:
                            </Text>
                            <Text style={styles.sessionPreview} numberOfLines={1}>
                                {' ' + messagePreview}
                            </Text>
                        </View>
                    ) : (
                        <Text style={styles.sessionPreview}>No messages yet</Text>
                    )}
                </View>
                <Ionicons name="chevron-forward" size={20} color="#999" />
            </Pressable>
        );
    };

    return (
        <LegendList
            data={listData}
            renderItem={renderItem}
            estimatedItemSize={68}
            keyExtractor={(item, index) => 
                item.type === 'header' ? `header-${item.title}` : `session-${item.session!.id}`
            }
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={({ leadingItem }) => 
                leadingItem.type === 'item' ? <View style={styles.separator} /> : null
            }
        />
    );
}

const styles = StyleSheet.create({
    listContent: {
        paddingBottom: 20,
    },
    sectionHeader: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: '#f8f8f8',
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: '#666',
        textTransform: 'uppercase',
    },
    sessionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: 'white',
    },
    sessionItemPressed: {
        backgroundColor: '#f5f5f5',
    },
    sessionIcon: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: '#f0f0f0',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    sessionContent: {
        flex: 1,
        marginRight: 8,
    },
    sessionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: '#000',
        marginBottom: 2,
    },
    sessionPreview: {
        fontSize: 14,
        color: '#666',
        flex: 1,
    },
    messagePreviewContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    senderLabel: {
        fontSize: 14,
        fontWeight: '600',
    },
    assistantLabel: {
        color: '#007AFF',
    },
    humanLabel: {
        color: '#34C759',
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: '#e0e0e0',
        marginLeft: 68,
    },
});