import * as React from 'react';
import { View, FlatList, Platform, KeyboardAvoidingView, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ClawdbotSocket, useClawdbotStatus, useClawdbotChatEvents } from '@/clawdbot';
import type { ClawdbotChatMessage } from '@/clawdbot';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout } from '@/components/layout';
import { MultiTextInput } from '@/components/MultiTextInput';
import { hapticsLight } from '@/components/haptics';

interface DisplayMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
    isStreaming?: boolean;
}

export default React.memo(function ClawdbotChatScreen() {
    const { sessionKey } = useLocalSearchParams<{ sessionKey: string }>();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { isConnected } = useClawdbotStatus();
    const { events, currentRunId, clearEvents } = useClawdbotChatEvents(sessionKey ?? null);

    const [messages, setMessages] = React.useState<DisplayMessage[]>([]);
    const [inputText, setInputText] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(true);
    const [isSending, setIsSending] = React.useState(false);
    const [streamingContent, setStreamingContent] = React.useState('');
    const flatListRef = React.useRef<FlatList>(null);

    // Set navigation title
    React.useEffect(() => {
        const label = sessionKey?.includes('/')
            ? sessionKey.split('/').pop()
            : sessionKey;
        navigation.setOptions({
            headerTitle: label ?? t('clawdbot.chat'),
        });
    }, [navigation, sessionKey]);

    // Load history on mount
    React.useEffect(() => {
        if (!sessionKey || !isConnected) return;

        setIsLoading(true);
        ClawdbotSocket.getHistory(sessionKey)
            .then((history) => {
                const displayMessages: DisplayMessage[] = history.map((msg, idx) => ({
                    id: `history-${idx}`,
                    role: msg.role,
                    content: extractTextContent(msg.content),
                    timestamp: msg.timestamp,
                }));
                setMessages(displayMessages);
            })
            .catch((err) => {
                console.error('Failed to load history:', err);
            })
            .finally(() => {
                setIsLoading(false);
            });
    }, [sessionKey, isConnected]);

    // Handle streaming events
    React.useEffect(() => {
        if (events.length === 0) return;

        const latestEvent = events[events.length - 1];

        if (latestEvent.state === 'started') {
            setStreamingContent('');
        } else if (latestEvent.state === 'delta' && latestEvent.delta) {
            setStreamingContent((prev) => prev + latestEvent.delta);
        } else if (latestEvent.state === 'final' && latestEvent.message) {
            // Add final message to list
            const finalContent = extractTextContent(latestEvent.message.content);
            setMessages((prev) => [
                ...prev,
                {
                    id: `msg-${Date.now()}`,
                    role: 'assistant',
                    content: finalContent,
                    timestamp: Date.now(),
                },
            ]);
            setStreamingContent('');
            setIsSending(false);
            clearEvents();
        } else if (latestEvent.state === 'error') {
            setStreamingContent('');
            setIsSending(false);
            clearEvents();
        }
    }, [events, clearEvents]);

    // Auto-scroll to bottom
    React.useEffect(() => {
        if (flatListRef.current && (messages.length > 0 || streamingContent)) {
            setTimeout(() => {
                flatListRef.current?.scrollToEnd({ animated: true });
            }, 100);
        }
    }, [messages, streamingContent]);

    const hasText = inputText.trim().length > 0;

    const handleSend = React.useCallback(async () => {
        if (!sessionKey || !inputText.trim() || isSending) return;

        const userMessage = inputText.trim();
        setInputText('');
        setIsSending(true);
        hapticsLight();

        // Add user message immediately
        setMessages((prev) => [
            ...prev,
            {
                id: `user-${Date.now()}`,
                role: 'user',
                content: userMessage,
                timestamp: Date.now(),
            },
        ]);

        try {
            await ClawdbotSocket.sendMessage(sessionKey, userMessage);
        } catch (err) {
            console.error('Failed to send message:', err);
            setIsSending(false);
        }
    }, [sessionKey, inputText, isSending]);

    const handleAbort = React.useCallback(async () => {
        if (!sessionKey || !currentRunId) return;

        try {
            await ClawdbotSocket.abortRun(sessionKey, currentRunId);
        } catch (err) {
            console.error('Failed to abort:', err);
        }
    }, [sessionKey, currentRunId]);

    const renderMessage = React.useCallback(({ item }: { item: DisplayMessage }) => {
        const isUser = item.role === 'user';
        return (
            <View style={[
                styles.messageContainer,
                isUser ? styles.userMessage : styles.assistantMessage,
            ]}>
                <View style={[
                    styles.messageBubble,
                    { backgroundColor: isUser ? theme.colors.button.primary.background : theme.colors.surface },
                ]}>
                    <Text style={[
                        styles.messageText,
                        { color: isUser ? '#FFFFFF' : theme.colors.text },
                    ]}>
                        {item.content}
                    </Text>
                </View>
            </View>
        );
    }, [theme]);

    if (!isConnected) {
        return (
            <View style={[styles.centered, { backgroundColor: theme.colors.groupped.background }]}>
                <Ionicons name="cloud-offline-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                    {t('clawdbot.notConnected')}
                </Text>
            </View>
        );
    }

    if (isLoading) {
        return (
            <View style={[styles.centered, { backgroundColor: theme.colors.groupped.background }]}>
                <ActivityIndicator size="large" color={theme.colors.button.primary.background} />
            </View>
        );
    }

    // Prepare data with streaming message if present
    const displayData = [...messages];
    if (streamingContent) {
        displayData.push({
            id: 'streaming',
            role: 'assistant',
            content: streamingContent,
            isStreaming: true,
        });
    }

    return (
        <KeyboardAvoidingView
            style={[styles.container, { backgroundColor: theme.colors.groupped.background }]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
            <FlatList
                ref={flatListRef}
                data={displayData}
                renderItem={renderMessage}
                keyExtractor={(item) => item.id}
                contentContainerStyle={[
                    styles.listContent,
                    { paddingBottom: 16 },
                ]}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Ionicons name="chatbubbles-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                            {t('clawdbot.startConversation')}
                        </Text>
                    </View>
                }
            />

            {/* Input Area - matching AgentInput unified panel style */}
            <View style={[
                styles.inputOuter,
                { paddingBottom: Math.max(insets.bottom, 8) },
            ]}>
                <View style={[styles.inputInner, { maxWidth: layout.maxWidth }]}>
                    <View style={[styles.unifiedPanel, { backgroundColor: theme.colors.input.background }]}>
                        {/* Input field */}
                        <View style={styles.inputFieldContainer}>
                            <MultiTextInput
                                value={inputText}
                                onChangeText={setInputText}
                                placeholder={t('clawdbot.messagePlaceholder')}
                                paddingTop={Platform.OS === 'web' ? 10 : 8}
                                paddingBottom={Platform.OS === 'web' ? 10 : 8}
                                maxHeight={120}
                            />
                        </View>

                        {/* Action buttons row */}
                        <View style={styles.actionRow}>
                            {/* Abort button when running */}
                            <View style={styles.actionLeft}>
                                {currentRunId && (
                                    <Pressable
                                        onPress={handleAbort}
                                        style={(p) => [
                                            styles.abortButton,
                                            p.pressed && styles.buttonPressed,
                                        ]}
                                    >
                                        <Octicons name="stop" size={16} color={theme.colors.button.secondary.tint} />
                                    </Pressable>
                                )}
                            </View>

                            {/* Send button */}
                            <View
                                style={[
                                    styles.sendButton,
                                    (hasText || isSending)
                                        ? { backgroundColor: theme.colors.button.primary.background }
                                        : { backgroundColor: theme.colors.button.primary.disabled }
                                ]}
                            >
                                <Pressable
                                    style={(p) => [
                                        styles.sendButtonInner,
                                        p.pressed && styles.buttonPressed,
                                    ]}
                                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                    onPress={handleSend}
                                    disabled={!hasText || isSending}
                                >
                                    {isSending ? (
                                        <ActivityIndicator
                                            size="small"
                                            color={theme.colors.button.primary.tint}
                                        />
                                    ) : (
                                        <Octicons
                                            name="arrow-up"
                                            size={16}
                                            color={theme.colors.button.primary.tint}
                                            style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                                        />
                                    )}
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
});

function extractTextContent(content: ClawdbotChatMessage['content']): string {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n');
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
    },
    listContent: {
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    messageContainer: {
        marginBottom: 12,
        maxWidth: '85%',
    },
    userMessage: {
        alignSelf: 'flex-end',
    },
    assistantMessage: {
        alignSelf: 'flex-start',
    },
    messageBubble: {
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    messageText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 22,
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 100,
        gap: 12,
    },
    emptyText: {
        ...Typography.default(),
        fontSize: 14,
        textAlign: 'center',
    },
    // Unified panel input styles (matching AgentInput)
    inputOuter: {
        alignItems: 'center',
        paddingBottom: 8,
        paddingTop: 8,
        paddingHorizontal: 8,
    },
    inputInner: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    inputFieldContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },
    actionRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionLeft: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
    },
    abortButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 8,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
        marginRight: 8,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        opacity: 0.7,
    },
}));
