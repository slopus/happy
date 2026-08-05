import * as React from 'react';
import { FlatList, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MessageView } from '@/components/MessageView';
import { debugMessages } from '@/dev/messages-demo-data';
import { Message } from '@/sync/typesMessage';
import { useDemoMessages } from '@/hooks/useDemoMessages';
import { AttachmentGalleryView } from '@/components/AttachmentGalleryView';
import { useLocalSearchParams } from 'expo-router';
import { activityStatusDemoEnvelopes } from '@/dev/messages-demo-data';
import { normalizeRawMessage, NormalizedMessage } from '@/sync/typesRaw';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { DisplayItem, groupMessagesForDisplay } from '@/hooks/useGroupedMessages';
import { AgentWorkGroupView, ToolGroupView } from '@/components/ToolGroupView';

export default React.memo(function MessagesDemoScreen() {
    const { demo } = useLocalSearchParams<{ demo?: string }>();
    const isActivityStatusDemo = demo === 'activity-status';
    const activityMessages = React.useMemo(() => {
        if (!isActivityStatusDemo) {
            return [];
        }
        const normalized = activityStatusDemoEnvelopes
            .map((envelope, index) => normalizeRawMessage(
                `activity-db-${index}`,
                null,
                Number(envelope.time),
                { role: 'session', content: envelope } as any,
            ))
            .filter((message): message is NormalizedMessage => message !== null);
        return reducer(createReducer(), normalized).messages.sort((a, b) => b.createdAt - a.createdAt);
    }, [isActivityStatusDemo]);
    // Combine all demo messages
    const allMessages = isActivityStatusDemo
        ? activityMessages
        : [...debugMessages];
    const activityItems = React.useMemo(
        () => isActivityStatusDemo
            ? [...groupMessagesForDisplay(activityMessages, true)].reverse()
            : [],
        [activityMessages, isActivityStatusDemo],
    );

    // Load demo messages into session storage
    const sessionId = useDemoMessages(allMessages);

    const renderActivityItem = React.useCallback(({ item }: { item: DisplayItem }) => {
        if (item.type === 'agent-work-group') {
            return (
                <AgentWorkGroupView
                    group={item}
                    metadata={null}
                    sessionId={sessionId}
                    expanded
                    onToggle={() => {}}
                />
            );
        }
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    group={item}
                    metadata={null}
                    sessionId={sessionId}
                    expanded={false}
                    onToggle={() => {}}
                />
            );
        }
        if (item.type === 'image-group') {
            return null;
        }
        return <MessageView message={item.message} metadata={null} sessionId={sessionId} />;
    }, [sessionId]);

    if (isActivityStatusDemo) {
        return (
            <View style={styles.container}>
                <FlatList
                    data={activityItems}
                    keyExtractor={(item) => item.id}
                    renderItem={renderActivityItem}
                    style={{ flexGrow: 1, flexBasis: 0 }}
                    contentContainerStyle={{ paddingVertical: 20 }}
                />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {allMessages.length > 0 && (
                <FlatList
                    data={allMessages}
                    keyExtractor={(item) => item.id}
                    ListHeaderComponent={(
                        <View testID="dev-featured-gallery-host" style={styles.galleryHost}>
                            <AttachmentGalleryView
                                messages={[]}
                                sessionId={sessionId}
                                presentation="featured"
                                pendingCount={1}
                            />
                        </View>
                    )}
                    renderItem={({ item }) => (
                        <MessageView
                            message={item}
                            metadata={null}
                            sessionId={sessionId}
                            getMessageById={(id: string): Message | null => {
                                return allMessages.find((m)=>m.id === id) || null;
                            }}
                        />
                    )}
                    style={{ flexGrow: 1, flexBasis: 0 }}
                    contentContainerStyle={{ paddingVertical: 20 }}
                />
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    galleryHost: {
        width: '100%',
    },
}));
