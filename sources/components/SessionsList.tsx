import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
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
                <View style={styles.sectionHeader}>
                    <View style={styles.sectionTitleContainer}>
                        {isActive && <View style={styles.activeIndicator} />}
                        <Text style={styles.sectionTitle}>{item.title}</Text>
                    </View>
                </View>
            );
        }

        if (item.type === 'empty') {
            return (
                <View style={styles.emptySection}>
                    <Text style={styles.emptySectionText}>{item.title}</Text>
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
                style={({ pressed }) => [
                    styles.sessionItem,
                    pressed && styles.sessionItemPressed
                ]}
                onPress={() => router.push(`/session/${session.id}` as any)}
            >
                <View style={styles.sessionIcon}>
                    <Ionicons name="chatbox-outline" size={24} color="#666" />
                    <View style={{ position: 'absolute', top: 0, right: 0, backgroundColor: online ? '#34C759' : 'transparent', width: 10, height: 10, borderRadius: 5 }} />
                </View>
                <View style={styles.sessionContent}>
                    <View style={styles.sessionHeader}>
                        <Text style={styles.sessionTitle} numberOfLines={1}>
                            {sessionName}
                        </Text>
                        <Text style={styles.lastSeenText}>
                            {lastSeenText}
                        </Text>
                    </View>
                    {lastMessage ? (
                        <View style={styles.messagePreviewContainer}>
                            <Text style={[styles.senderLabel, isFromAssistant ? styles.assistantLabel : styles.humanLabel]}>
                                {isFromAssistant ? 'Claude' : 'You'}:
                            </Text>

                            {thinking && (
                                <Text style={styles.thinkingLabel}>
                                    {' thinking...'}
                                </Text>
                            )}

                            {!thinking && (
                                <Text style={styles.sessionPreview} numberOfLines={1}>
                                    {' ' + messagePreview}
                                </Text>
                            )}

                        </View>
                    ) : (
                        <Text style={styles.sessionPreview}>No messages yet</Text>
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
    sectionTitleContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: '#666',
        textTransform: 'uppercase',
    },
    activeIndicator: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#34C759',
        marginRight: 8,
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
    },
    sessionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 2,
    },
    sessionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: '#000',
        flex: 1,
        marginRight: 8,
    },
    lastSeenText: {
        fontSize: 12,
        color: '#999',
    },
    sessionPreview: {
        fontSize: 14,
        color: '#666',
        flex: 1,
    },
    thinkingLabel: {
        fontSize: 14,
        color: '#007AFF',
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
    emptySection: {
        paddingHorizontal: 16,
        paddingVertical: 32,
        alignItems: 'center',
    },
    emptySectionText: {
        fontSize: 14,
        color: '#999',
        fontStyle: 'italic',
    },
});