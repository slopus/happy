/**
 * Moltbot Chat Page
 *
 * Chat view for a Moltbot session.
 * Handles message display, input, and real-time streaming.
 */

import React from 'react';
import {
    View,
    Text,
    TextInput,
    FlatList,
    Pressable,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { useMoltbotConnection } from '@/moltbot/connection';
import { useMoltbotMachine } from '@/sync/storage';
import type { MoltbotChatMessage, MoltbotChatEvent } from '@/moltbot/types';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    messageList: {
        flex: 1,
    },
    messageListContent: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    messageBubble: {
        maxWidth: '85%',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 16,
        marginVertical: 4,
    },
    userBubble: {
        alignSelf: 'flex-end',
        backgroundColor: theme.colors.button.primary.background,
        borderBottomRightRadius: 4,
    },
    assistantBubble: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfacePressed,
        borderBottomLeftRadius: 4,
    },
    messageText: {
        fontSize: 16,
        lineHeight: 22,
        ...Typography.default(),
    },
    userMessageText: {
        color: '#FFFFFF',
    },
    assistantMessageText: {
        color: theme.colors.text,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    inputWrapper: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'flex-end',
        backgroundColor: theme.colors.input.background,
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 8,
        minHeight: 40,
        maxHeight: 120,
    },
    textInput: {
        flex: 1,
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default(),
        paddingTop: 0,
        paddingBottom: 0,
    },
    sendButton: {
        marginLeft: 8,
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: theme.colors.button.primary.background,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonDisabled: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    streamingIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginVertical: 4,
    },
    streamingText: {
        marginLeft: 8,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyTitle: {
        fontSize: 18,
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    emptyDescription: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    connectionBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
        paddingHorizontal: 16,
        backgroundColor: theme.colors.groupped.background,
        gap: 8,
    },
    connectionText: {
        fontSize: 14,
        ...Typography.default(),
    },
}));

interface MessageItemProps {
    message: MoltbotChatMessage;
}

const MessageItem = React.memo(({ message }: MessageItemProps) => {
    const { theme } = useUnistyles();
    const isUser = message.role === 'user';

    // Extract text content from message
    const getTextContent = () => {
        if (typeof message.content === 'string') {
            return message.content;
        }
        return message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    };

    return (
        <View
            style={[
                styles.messageBubble,
                isUser ? styles.userBubble : styles.assistantBubble,
            ]}
        >
            <Text
                style={[
                    styles.messageText,
                    isUser ? styles.userMessageText : styles.assistantMessageText,
                ]}
            >
                {getTextContent()}
            </Text>
        </View>
    );
});

export default function MoltbotChatPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { machineId, sessionKey } = useLocalSearchParams<{
        machineId: string;
        sessionKey: string;
    }>();

    // Get machine data
    const machine = useMoltbotMachine(machineId ?? '');

    // Connection hook
    const {
        status,
        isConnected,
        isConnecting,
        send,
        connect,
    } = useMoltbotConnection(machineId ?? '', {
        autoConnect: true,
        onEvent: (event, payload) => {
            // Handle real-time chat events
            if (event === 'chat' && payload) {
                handleChatEvent(payload as MoltbotChatEvent);
            }
        },
    });

    // Chat state
    const [messages, setMessages] = React.useState<MoltbotChatMessage[]>([]);
    const [inputText, setInputText] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(false);
    const [isStreaming, setIsStreaming] = React.useState(false);
    const [streamingText, setStreamingText] = React.useState('');

    const flatListRef = React.useRef<FlatList>(null);

    // Handle incoming chat events
    const handleChatEvent = React.useCallback((event: MoltbotChatEvent) => {
        if (event.sessionKey !== sessionKey) return;

        switch (event.state) {
            case 'started':
                setIsStreaming(true);
                setStreamingText('');
                break;
            case 'thinking':
                setStreamingText('Thinking...');
                break;
            case 'delta':
                if (event.delta) {
                    setStreamingText((prev) => prev + event.delta);
                }
                break;
            case 'final':
                setIsStreaming(false);
                if (event.message) {
                    setMessages((prev) => [...prev, event.message!]);
                }
                setStreamingText('');
                break;
            case 'error':
                setIsStreaming(false);
                setStreamingText('');
                console.error('Chat error:', event.errorMessage);
                break;
        }
    }, [sessionKey]);

    // Fetch chat history when connected
    React.useEffect(() => {
        if (isConnected && sessionKey) {
            fetchHistory();
        }
    }, [isConnected, sessionKey]);

    const fetchHistory = async () => {
        setIsLoading(true);
        try {
            const result = await send('chat.history', { sessionKey });
            if (result.ok && result.payload) {
                const history = (result.payload as { messages?: MoltbotChatMessage[] }).messages ?? [];
                setMessages(history);
            }
        } catch (err) {
            console.error('Failed to fetch chat history:', err);
        } finally {
            setIsLoading(false);
        }
    };

    // Send message
    const handleSend = React.useCallback(async () => {
        const text = inputText.trim();
        if (!text || !isConnected || isStreaming) return;

        // Add user message immediately
        const userMessage: MoltbotChatMessage = {
            role: 'user',
            content: text,
            timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, userMessage]);
        setInputText('');

        // Scroll to bottom
        setTimeout(() => {
            flatListRef.current?.scrollToEnd({ animated: true });
        }, 100);

        // Send to gateway
        try {
            await send('chat.send', {
                sessionKey,
                message: text,
            });
        } catch (err) {
            console.error('Failed to send message:', err);
        }
    }, [inputText, isConnected, isStreaming, sessionKey, send]);

    // Get header title
    const headerTitle = machine?.metadata?.name || t('moltbot.sessions');

    const canSend = inputText.trim().length > 0 && isConnected && !isStreaming;

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={100}
        >
            <Stack.Screen
                options={{
                    headerTitle: headerTitle,
                    headerBackTitle: t('common.back'),
                }}
            />

            {/* Connection status banner */}
            {!isConnected && (
                <View style={styles.connectionBanner}>
                    {isConnecting ? (
                        <>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            <Text style={[styles.connectionText, { color: theme.colors.textSecondary }]}>
                                {t('moltbot.connecting')}
                            </Text>
                        </>
                    ) : (
                        <>
                            <Ionicons name="cloud-offline" size={18} color={theme.colors.status.disconnected} />
                            <Text style={[styles.connectionText, { color: theme.colors.status.disconnected }]}>
                                {t('moltbot.disconnected')}
                            </Text>
                            <Pressable onPress={() => connect()}>
                                <Text style={[styles.connectionText, { color: theme.colors.button.primary.background }]}>
                                    {t('moltbot.connect')}
                                </Text>
                            </Pressable>
                        </>
                    )}
                </View>
            )}

            {/* Messages list */}
            {isLoading ? (
                <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                </View>
            ) : messages.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Ionicons name="chatbubbles-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={[styles.emptyTitle, { marginTop: 16 }]}>
                        {t('moltbot.noSessions')}
                    </Text>
                    <Text style={styles.emptyDescription}>
                        {t('moltbot.noSessionsDescription')}
                    </Text>
                </View>
            ) : (
                <FlatList
                    ref={flatListRef}
                    style={styles.messageList}
                    contentContainerStyle={[
                        styles.messageListContent,
                        { paddingBottom: 16 },
                    ]}
                    data={messages}
                    keyExtractor={(item, index) => `${item.role}-${item.timestamp || index}`}
                    renderItem={({ item }) => <MessageItem message={item} />}
                    onContentSizeChange={() => {
                        flatListRef.current?.scrollToEnd({ animated: false });
                    }}
                    ListFooterComponent={
                        isStreaming ? (
                            <View style={styles.streamingIndicator}>
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                <Text style={styles.streamingText}>
                                    {streamingText || 'Thinking...'}
                                </Text>
                            </View>
                        ) : null
                    }
                />
            )}

            {/* Input area */}
            <View style={[styles.inputContainer, { paddingBottom: safeArea.bottom + 8 }]}>
                <View style={styles.inputWrapper}>
                    <TextInput
                        style={styles.textInput}
                        value={inputText}
                        onChangeText={setInputText}
                        placeholder={t('session.inputPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        multiline
                        maxLength={10000}
                        editable={isConnected && !isStreaming}
                        onSubmitEditing={handleSend}
                        blurOnSubmit={false}
                    />
                </View>
                <Pressable
                    style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
                    onPress={handleSend}
                    disabled={!canSend}
                >
                    <Ionicons
                        name="arrow-up"
                        size={24}
                        color={canSend ? '#FFFFFF' : theme.colors.textSecondary}
                    />
                </Pressable>
            </View>
        </KeyboardAvoidingView>
    );
}
