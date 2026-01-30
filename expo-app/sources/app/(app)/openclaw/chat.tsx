/**
 * OpenClaw Chat Page
 *
 * Chat view for an OpenClaw session.
 * Handles message display, input, and real-time streaming.
 */

import React from 'react';
import {
    View,
    Text,
    FlatList,
    Pressable,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    useWindowDimensions,
} from 'react-native';
import { randomUUID } from 'expo-crypto';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { MultiTextInput, KeyPressEvent } from '@/components/MultiTextInput';
import { useOpenClawConnection } from '@/openclaw/connection';
import { useOpenClawMachine } from '@/sync/storage';
import type { OpenClawChatMessage, OpenClawChatEvent } from '@/openclaw/types';

// Header button width constants
const HEADER_BUTTON_WIDTH = 40; // 24px icon + 16px padding
const HEADER_PADDING = Platform.OS === 'ios' ? 16 : 32;
const HEADER_CENTER_PADDING = 24;

// Local message type with send status for UI tracking
type MessageStatus = 'sending' | 'sent' | 'failed';

interface LocalMessage extends OpenClawChatMessage {
    localId: string;           // Unique ID for tracking
    status?: MessageStatus;    // Only for user messages
    errorMessage?: string;     // Error details for failed messages
}

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
        paddingTop: 8,
        paddingBottom: 16,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
        rowGap: 12,
    },
    messageBubble: {
        flexShrink: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 16,
    },
    userBubble: {
        backgroundColor: theme.colors.button.primary.background,
        borderBottomRightRadius: 4,
    },
    assistantBubble: {
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
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
    },
    inputInner: {
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    inputPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
    },
    inputWrapper: {
        flex: 1,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonDisabled: {
        backgroundColor: theme.colors.surfacePressed,
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
    messageRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        maxWidth: '85%',
    },
    messageRowUser: {
        alignSelf: 'flex-end',
    },
    messageRowAssistant: {
        alignSelf: 'flex-start',
    },
    statusContainer: {
        width: 28,
        height: 30,
        marginTop: 6,
        alignItems: 'center',
        justifyContent: 'center',
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
}));

interface MessageItemProps {
    message: LocalMessage;
    onRetry?: (localId: string) => void;
}

const MessageItem = React.memo(({ message, onRetry }: MessageItemProps) => {
    const { theme } = useUnistyles();
    const isUser = message.role === 'user';
    const isFailed = message.status === 'failed';
    const isSending = message.status === 'sending';

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

    // Render status indicator for user messages
    const renderStatusIndicator = () => {
        if (!isUser) return null;

        if (isSending) {
            return (
                <View style={styles.statusContainer}>
                    <ActivityIndicator
                        size={14}
                        color={theme.colors.textSecondary}
                    />
                </View>
            );
        }

        if (isFailed) {
            return (
                <Pressable
                    style={styles.statusContainer}
                    onPress={() => onRetry?.(message.localId)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <Ionicons
                        name="alert-circle"
                        size={20}
                        color={theme.colors.status.disconnected}
                    />
                </Pressable>
            );
        }

        return null;
    };

    return (
        <View
            style={[
                styles.messageRow,
                isUser ? styles.messageRowUser : styles.messageRowAssistant,
            ]}
        >
            {/* Status indicator before bubble for user messages */}
            {isUser && renderStatusIndicator()}

            <View
                style={[
                    styles.messageBubble,
                    isUser ? styles.userBubble : styles.assistantBubble,
                    isFailed && { opacity: 0.7 },
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
        </View>
    );
});

export default function OpenClawChatPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { width: screenWidth } = useWindowDimensions();
    const { machineId, sessionKey } = useLocalSearchParams<{
        machineId: string;
        sessionKey: string;
    }>();

    // Left: back button (1), Right: loading indicator (1)
    const headerTitleMaxWidth = screenWidth - (HEADER_BUTTON_WIDTH * 2) - HEADER_PADDING - HEADER_CENTER_PADDING;

    // Get machine data
    const machine = useOpenClawMachine(machineId ?? '');

    // Connection hook
    const {
        isConnected,
        isConnecting,
        send,
    } = useOpenClawConnection(machineId ?? '', {
        autoConnect: true,
        onEvent: (event, payload) => {
            // Handle real-time chat events
            if (event === 'chat' && payload) {
                handleChatEvent(payload as OpenClawChatEvent);
            }
        },
    });

    // Chat state
    const [messages, setMessages] = React.useState<LocalMessage[]>([]);
    const [inputText, setInputText] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(false);
    const [isStreaming, setIsStreaming] = React.useState(false);
    const [streamingText, setStreamingText] = React.useState('');

    const flatListRef = React.useRef<FlatList<LocalMessage>>(null);

    // Handle incoming chat events
    const handleChatEvent = React.useCallback((event: OpenClawChatEvent) => {
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
                // Gateway sends delta text in message.content[0].text
                if (event.message) {
                    const content = event.message.content;
                    if (Array.isArray(content) && content.length > 0 && content[0].text) {
                        setStreamingText(content[0].text);
                    }
                } else if (event.delta) {
                    // Fallback for legacy format
                    setStreamingText((prev) => prev + event.delta);
                }
                break;
            case 'final':
                setIsStreaming(false);
                if (event.message) {
                    const finalMessage: LocalMessage = {
                        ...event.message,
                        localId: randomUUID(),
                    };
                    setMessages((prev) => [...prev, finalMessage]);
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
                const history = (result.payload as { messages?: OpenClawChatMessage[] }).messages ?? [];
                // Convert to LocalMessage format
                const localMessages: LocalMessage[] = history.map((msg) => ({
                    ...msg,
                    localId: randomUUID(),
                    status: msg.role === 'user' ? 'sent' : undefined,
                }));
                setMessages(localMessages);
            }
        } catch (err) {
            console.error('Failed to fetch chat history:', err);
        } finally {
            setIsLoading(false);
        }
    };

    // Send a message (new or retry)
    const sendMessage = React.useCallback(async (localId: string, text: string) => {
        // Mark message as sending
        setMessages((prev) =>
            prev.map((msg) =>
                msg.localId === localId
                    ? { ...msg, status: 'sending' as MessageStatus, errorMessage: undefined }
                    : msg
            )
        );

        // Send to gateway
        const result = await send('chat.send', {
            sessionKey,
            message: text,
            idempotencyKey: randomUUID(),
        });

        if (!result.ok) {
            // Mark message as failed
            setMessages((prev) =>
                prev.map((msg) =>
                    msg.localId === localId
                        ? { ...msg, status: 'failed' as MessageStatus, errorMessage: result.error }
                        : msg
                )
            );
        } else {
            // Mark message as sent
            setMessages((prev) =>
                prev.map((msg) =>
                    msg.localId === localId
                        ? { ...msg, status: 'sent' as MessageStatus }
                        : msg
                )
            );
        }
    }, [sessionKey, send]);

    // Handle new message send
    const handleSend = React.useCallback(async () => {
        const text = inputText.trim();
        if (!text || !isConnected || isStreaming) {
            return;
        }

        // Create user message with sending status
        const localId = randomUUID();
        const userMessage: LocalMessage = {
            role: 'user',
            content: text,
            timestamp: Date.now(),
            localId,
            status: 'sending',
        };
        setMessages((prev) => [...prev, userMessage]);
        setInputText('');

        // Send the message
        await sendMessage(localId, text);
    }, [inputText, isConnected, isStreaming, sendMessage]);

    // Handle retry for failed messages
    const handleRetry = React.useCallback((localId: string) => {
        const message = messages.find((msg) => msg.localId === localId);
        if (!message || message.status !== 'failed') return;

        const text = typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');

        sendMessage(localId, text);
    }, [messages, sendMessage]);

    // Handle keyboard shortcuts: Enter to send, Shift+Enter for newline
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        if (Platform.OS === 'web' && event.key === 'Enter' && !event.shiftKey) {
            if (inputText.trim() && isConnected && !isStreaming) {
                handleSend();
                return true;
            }
        }
        return false;
    }, [inputText, isConnected, isStreaming, handleSend]);

    // Session name for header title (decode URL encoding)
    const sessionName = sessionKey ? decodeURIComponent(sessionKey) : t('openclaw.sessions');
    // Machine name for header subtitle
    const machineName = machine?.metadata?.name;

    const canSend = inputText.trim().length > 0 && isConnected && !isStreaming;

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={100}
        >
            <Stack.Screen
                options={{
                    headerLeft: () => (
                        <Pressable
                            onPress={() => router.back()}
                            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                        >
                            <Ionicons
                                name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                                size={Platform.OS === 'ios' ? 28 : 24}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    ),
                    headerTitle: () => (
                        <View style={{ alignItems: 'center', justifyContent: 'center', maxWidth: headerTitleMaxWidth }}>
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={[Typography.default('semiBold'), { fontSize: 17, lineHeight: 24, color: theme.colors.header.tint, flexShrink: 1 }]}
                            >
                                {sessionName}
                            </Text>
                            {machineName && (
                                <Text
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    style={[Typography.default(), { fontSize: 12, color: theme.colors.header.tint, opacity: 0.7, marginTop: -2 }]}
                                >
                                    {machineName}
                                </Text>
                            )}
                        </View>
                    ),
                    headerRight: isConnecting ? () => (
                        <ActivityIndicator size="small" color={theme.colors.header.tint} />
                    ) : undefined,
                }}
            />

            {/* Messages list */}
            {isLoading ? (
                <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                </View>
            ) : messages.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Ionicons name="chatbubbles-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={[styles.emptyTitle, { marginTop: 16 }]}>
                        {t('openclaw.noSessions')}
                    </Text>
                    <Text style={styles.emptyDescription}>
                        {t('openclaw.noSessionsDescription')}
                    </Text>
                </View>
            ) : (
                <FlatList
                    ref={flatListRef}
                    style={styles.messageList}
                    contentContainerStyle={styles.messageListContent}
                    data={messages}
                    keyExtractor={(item) => item.localId}
                    renderItem={({ item }) => <MessageItem message={item} onRetry={handleRetry} />}
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
            <View style={[styles.inputContainer, { paddingBottom: safeArea.bottom + 16 }]}>
                <View style={styles.inputInner}>
                    <View style={[
                        styles.inputPanel,
                        !(isConnected && !isStreaming) && { opacity: 0.5 },
                    ]}>
                        <View style={styles.inputWrapper}>
                            <MultiTextInput
                                value={inputText}
                                onChangeText={setInputText}
                                placeholder={t('session.inputPlaceholder')}
                                maxHeight={150}
                                lineHeight={24}
                                paddingTop={4}
                                paddingBottom={4}
                                onKeyPress={handleKeyPress}
                            />
                        </View>
                        <Pressable
                            style={({ pressed }) => [
                                styles.sendButton,
                                canSend ? styles.sendButtonActive : styles.sendButtonDisabled,
                                pressed && canSend && { opacity: 0.7 },
                            ]}
                            onPress={handleSend}
                            disabled={!canSend}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Ionicons
                                name="arrow-up"
                                size={18}
                                color={canSend ? '#FFFFFF' : theme.colors.textSecondary}
                            />
                        </Pressable>
                    </View>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}
