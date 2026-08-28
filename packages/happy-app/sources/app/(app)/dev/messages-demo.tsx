import * as React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MessageView } from '@/components/MessageView';
import { createGeneratedBatchDemoMessages, debugMessages } from '@/dev/messages-demo-data';
import { Message } from '@/sync/typesMessage';
import { useDemoMessages } from '@/hooks/useDemoMessages';
import { AttachmentGalleryView } from '@/components/AttachmentGalleryView';
import { useLocalSearchParams } from 'expo-router';
import { activityStatusDemoEnvelopes } from '@/dev/messages-demo-data';
import { normalizeRawMessage, NormalizedMessage } from '@/sync/typesRaw';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { DisplayItem, groupMessagesForDisplay } from '@/hooks/useGroupedMessages';
import { AgentWorkGroupView, ToolGroupView } from '@/components/ToolGroupView';
import { MermaidRenderer } from '@/components/markdown/MermaidRenderer';

const MERMAID_INTERACTION_DEMO = `flowchart LR
    source[Source] --> plan[Plan]
    plan --> build[Build]
    plan --> test[Test]
    build --> release[Release]
    test --> release`;

export default React.memo(function MessagesDemoScreen() {
    const { demo } = useLocalSearchParams<{ demo?: string }>();
    const isActivityStatusDemo = demo === 'activity-status';
    const isGeneratedBatchDemo = demo === 'generated-batch';
    const isMermaidDemo = demo === 'mermaid';
    const [generatedCount, setGeneratedCount] = React.useState(1);
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
    const generatedBatchMessages = React.useMemo(
        () => isGeneratedBatchDemo ? createGeneratedBatchDemoMessages(generatedCount) : [],
        [generatedCount, isGeneratedBatchDemo],
    );
    // Combine all demo messages
    const allMessages = isActivityStatusDemo
        ? activityMessages
        : isGeneratedBatchDemo
            ? generatedBatchMessages
            : [...debugMessages];
    const activityItems = React.useMemo(
        () => isActivityStatusDemo
            ? [...groupMessagesForDisplay(activityMessages, true)].reverse()
            : [],
        [activityMessages, isActivityStatusDemo],
    );
    const generatedBatchItems = React.useMemo(
        () => isGeneratedBatchDemo
            ? [...groupMessagesForDisplay(generatedBatchMessages, true, { currentTurnActive: true })].reverse()
            : [],
        [generatedBatchMessages, isGeneratedBatchDemo],
    );

    // Load demo messages into session storage
    const sessionId = useDemoMessages(allMessages);

    const renderGroupedItem = React.useCallback(({ item }: { item: DisplayItem }) => {
        if (item.type === 'agent-work-group') {
            return (
                <AgentWorkGroupView
                    group={item}
                    metadata={null}
                    sessionId={sessionId}
                    expanded={isActivityStatusDemo}
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
            return (
                <AttachmentGalleryView
                    messages={item.messages}
                    sessionId={isGeneratedBatchDemo ? '' : sessionId}
                    presentation={item.presentation}
                    pendingCount={item.pendingCount}
                    pendingStartedAt={item.pendingStartedAt}
                />
            );
        }
        return <MessageView message={item.message} metadata={null} sessionId={sessionId} />;
    }, [isActivityStatusDemo, isGeneratedBatchDemo, sessionId]);

    if (isActivityStatusDemo) {
        return (
            <View style={styles.container}>
                <FlatList
                    data={activityItems}
                    keyExtractor={(item) => item.id}
                    renderItem={renderGroupedItem}
                    style={{ flexGrow: 1, flexBasis: 0 }}
                    contentContainerStyle={{ paddingVertical: 20 }}
                />
            </View>
        );
    }

    if (isGeneratedBatchDemo) {
        return (
            <View testID="dev-generated-batch-demo" style={styles.container}>
                <View style={styles.batchControls}>
                    <View style={styles.batchCopy}>
                        <Text style={styles.batchTitle}>56 张图片增量生成</Text>
                        <Text testID="dev-generated-batch-count" style={styles.batchSubtitle}>
                            当前已收到 {generatedCount}/56 张；每次点击模拟一张新的 send_image 事件
                        </Text>
                    </View>
                    <Pressable
                        testID="dev-generated-batch-add-image"
                        accessibilityRole="button"
                        accessibilityLabel="模拟生成下一张"
                        disabled={generatedCount >= 56}
                        onPress={() => setGeneratedCount((count) => Math.min(56, count + 1))}
                        style={[styles.batchButton, generatedCount >= 56 ? styles.batchButtonDisabled : null]}
                    >
                        <Text style={styles.batchButtonText}>下一张</Text>
                    </Pressable>
                </View>
                <FlatList
                    data={generatedBatchItems}
                    keyExtractor={(item) => item.id}
                    renderItem={renderGroupedItem}
                    style={{ flexGrow: 1, flexBasis: 0 }}
                    contentContainerStyle={{ paddingBottom: 20 }}
                />
            </View>
        );
    }

    if (isMermaidDemo) {
        return (
            <View testID="dev-mermaid-demo" style={[styles.container, styles.mermaidDemo]}>
                <MermaidRenderer content={MERMAID_INTERACTION_DEMO} />
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
    mermaidDemo: {
        justifyContent: 'center',
        padding: 24,
    },
    batchControls: {
        minHeight: 76,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    batchCopy: {
        flex: 1,
        gap: 3,
    },
    batchTitle: {
        color: theme.colors.text,
        fontSize: 16,
        fontWeight: '700',
    },
    batchSubtitle: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 17,
    },
    batchButton: {
        minWidth: 76,
        minHeight: 40,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
    },
    batchButtonDisabled: {
        opacity: 0.45,
    },
    batchButtonText: {
        color: theme.colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
}));
