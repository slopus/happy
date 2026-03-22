/**
 * OpenClaw Chat Page
 *
 * Chat view for an OpenClaw session.
 * Handles message display, input, and real-time streaming.
 *
 * Uses a single messages list approach:
 * - User messages are added directly to the list with status tracking
 * - Streaming AI responses are managed as a temporary message in the list
 * - On completion, the entire list is replaced with server history (single atomic update)
 */

import React from 'react';
import {
    View,
    Text,
    FlatList,
    Pressable,
    ActivityIndicator,
    Platform,
    useWindowDimensions,
    Animated,
    Easing,
} from 'react-native';
import { AgentContentView } from '@/components/AgentContentView';
import { randomUUID } from 'expo-crypto';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { MultiTextInput, KeyPressEvent } from '@/components/MultiTextInput';
import { useOpenClawConnection } from '@/openclaw/connection';
import { useOpenClawMachine } from '@/sync/storage';
import type { OpenClawChatMessage, OpenClawChatEvent } from '@/openclaw/types';

// Header button width constants
const HEADER_BUTTON_WIDTH = 40; // 24px icon + 16px padding
const HEADER_PADDING = Platform.OS === 'ios' ? 16 : 32;
const HEADER_CENTER_PADDING = 24;

// Special ID for streaming message
const STREAMING_MESSAGE_ID = '__streaming__';

// Local message type with status tracking
type MessageStatus = 'sending' | 'sent' | 'failed';

interface LocalMessage extends OpenClawChatMessage {
    localId: string;           // Unique ID for tracking
    status?: MessageStatus;    // For user messages: sending/sent/failed
    isStreaming?: boolean;     // For AI messages: true if currently streaming
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
        color: theme.colors.button.primary.tint,
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
    readingIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 4,
        paddingVertical: 6,
        gap: 4,
    },
    readingDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.textSecondary,
    },
    // Typing indicator for streaming messages - inside bubble at bottom right
    typingIndicator: {
        position: 'absolute',
        right: 8,
        bottom: 6,
    },
}));

// Animated dot component for smooth animations (used in ReadingIndicator)
const AnimatedDot = React.memo(({ delay }: { delay: number }) => {
    const opacity = React.useRef(new Animated.Value(0.3)).current;

    React.useEffect(() => {
        const animation = Animated.loop(
            Animated.sequence([
                Animated.delay(delay),
                Animated.timing(opacity, {
                    toValue: 1,
                    duration: 300,
                    easing: Easing.ease,
                    useNativeDriver: true,
                }),
                Animated.timing(opacity, {
                    toValue: 0.3,
                    duration: 300,
                    easing: Easing.ease,
                    useNativeDriver: true,
                }),
                Animated.delay(600 - delay),
            ])
        );
        animation.start();
        return () => animation.stop();
    }, [opacity, delay]);

    return (
        <Animated.View style={[styles.readingDot, { opacity }]} />
    );
});

// Reading indicator with animated dots (used when waiting for first content)
const ReadingIndicator = React.memo(() => {
    return (
        <View style={[styles.messageRow, styles.messageRowAssistant]}>
            <View style={[styles.messageBubble, styles.assistantBubble]}>
                <View style={styles.readingIndicator}>
                    <AnimatedDot delay={0} />
                    <AnimatedDot delay={200} />
                    <AnimatedDot delay={400} />
                </View>
            </View>
        </View>
    );
});

// Typing indicator shown at the end of streaming messages
const TypingIndicator = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <View style={styles.typingIndicator}>
            <ActivityIndicator size={14} color={theme.colors.textSecondary} />
        </View>
    );
});

interface MessageItemProps {
    message: LocalMessage;
    onRetry?: (localId: string) => void;
}

const MessageItem = React.memo(({ message, onRetry }: MessageItemProps) => {
    const { theme } = useUnistyles();
    const isUser = message.role === 'user';
    const isFailed = message.status === 'failed';
    const isSending = message.status === 'sending';
    const isStreaming = message.isStreaming;

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

    const textContent = getTextContent();

    // For streaming messages with no content yet, show reading indicator
    if (isStreaming && !textContent) {
        return <ReadingIndicator />;
    }

    // Skip empty assistant messages (tool calls without text)
    if (!isUser && !textContent) {
        return null;
    }

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

    // User messages
    if (isUser) {
        return (
            <View style={[styles.messageRow, styles.messageRowUser]}>
                {renderStatusIndicator()}
                <View
                    style={[
                        styles.messageBubble,
                        styles.userBubble,
                        isFailed && { opacity: 0.7 },
                    ]}
                >
                    <Text style={[styles.messageText, styles.userMessageText]}>
                        {textContent}
                    </Text>
                </View>
            </View>
        );
    }

    // Assistant messages - with typing indicator inside the bubble at bottom right
    return (
        <View style={[styles.messageRow, styles.messageRowAssistant]}>
            <View style={[styles.messageBubble, styles.assistantBubble]}>
                <MarkdownView markdown={textContent} />
                {isStreaming && <TypingIndicator />}
            </View>
        </View>
    );
});

export default function OpenClawChatPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { width: screenWidth } = useWindowDimensions();
    const { machineId, sessionKey, sessionName: sessionNameParam } = useLocalSearchParams<{
        machineId: string;
        sessionKey: string;
        sessionName?: string;
    }>();

    // Left: back button (1), Right: loading indicator (1)
    const headerTitleMaxWidth = screenWidth - (HEADER_BUTTON_WIDTH * 2) - HEADER_PADDING - HEADER_CENTER_PADDING;

    // Get machine data
    const machine = useOpenClawMachine(machineId ?? '');

    // Ref for handling chat events - must be before useOpenClawConnection
    const handleChatEventRef = React.useRef<(event: OpenClawChatEvent) => void>(() => {});

    // Stable callback for onEvent - uses ref to always call latest handler
    const onEventCallback = React.useCallback((event: string, payload: unknown) => {
        if (event === 'chat' && payload) {
            // Direct chat events from gateway
            const p = payload as Record<string, unknown>;
            if (p.state && p.sessionKey) {
                handleChatEventRef.current(payload as OpenClawChatEvent);
            }
        } else if (event === 'agent' && payload) {
            // Agent events - convert to chat event format
            const p = payload as Record<string, unknown>;

            if (p.stream === 'assistant' && p.data && p.sessionKey) {
                // Assistant stream contains cumulative text
                const data = p.data as { delta?: string; text?: string };
                handleChatEventRef.current({
                    state: 'delta',
                    sessionKey: p.sessionKey as string,
                    runId: p.runId as string,
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: data.text || '' }],
                    },
                } as OpenClawChatEvent);
            } else if (p.stream === 'lifecycle' && p.data) {
                // Lifecycle events: completed, error
                const data = p.data as { state?: string; error?: string };
                if (data.state === 'completed') {
                    handleChatEventRef.current({
                        state: 'final',
                        sessionKey: p.sessionKey as string,
                        runId: p.runId as string,
                    } as OpenClawChatEvent);
                } else if (data.state === 'error') {
                    handleChatEventRef.current({
                        state: 'error',
                        sessionKey: p.sessionKey as string,
                        errorMessage: data.error,
                    } as OpenClawChatEvent);
                }
            }
        }
    }, []);

    // Connection hook
    const {
        isConnected,
        isConnecting,
        send,
    } = useOpenClawConnection(machineId ?? '', {
        autoConnect: true,
        onEvent: onEventCallback,
    });

    // Single source of truth: messages list
    // Contains: history messages + pending user message + streaming AI message
    const [messages, setMessages] = React.useState<LocalMessage[]>([]);
    const [inputText, setInputText] = React.useState('');
    // Initial loading state: true until first history fetch completes
    const [isLoading, setIsLoading] = React.useState(true);

    // Track current run for streaming (not used for rendering, only for event filtering)
    const chatRunIdRef = React.useRef<string | null>(null);

    const flatListRef = React.useRef<FlatList<LocalMessage>>(null);
    // Scroll state
    const userNearBottomRef = React.useRef(true);
    const shouldForceScrollRef = React.useRef(false);

    // Extract text from message content
    const extractText = (message: unknown): string | null => {
        if (!message || typeof message !== 'object') return null;
        const msg = message as { content?: unknown };
        if (!msg.content) return null;

        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
            const textBlocks = msg.content
                .filter((block): block is { type: 'text'; text: string } =>
                    block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
                )
                .map((block) => block.text);
            return textBlocks.length > 0 ? textBlocks.join('\n') : null;
        }
        return null;
    };

    // Fetch chat history and replace messages list
    const fetchHistory = React.useCallback(async () => {
        try {
            const result = await send('chat.history', { sessionKey, limit: 100 });
            if (!result || !result.ok) {
                // Request failed, keep existing messages
                return;
            }
            const history = (result.payload as { messages?: OpenClawChatMessage[] }).messages ?? [];
            // Convert to LocalMessage format - use stable IDs based on index + role + timestamp
            const localMessages: LocalMessage[] = history.map((msg, index) => ({
                ...msg,
                localId: `${msg.role}-${index}-${msg.timestamp ?? index}`,
                status: msg.role === 'user' ? 'sent' : undefined,
            }));
            // Single atomic update - replaces entire list
            setMessages(localMessages);
            // Clear run ID
            chatRunIdRef.current = null;
        } catch (err) {
            console.error('Failed to fetch chat history:', err);
        }
    }, [send, sessionKey]);

    // Handle incoming chat events
    const handleChatEvent = React.useCallback((event: OpenClawChatEvent) => {
        if (event.sessionKey !== sessionKey) return;

        // Handle events from different runId (e.g., sub-agent) - refresh history on final
        if (event.runId && chatRunIdRef.current && event.runId !== chatRunIdRef.current) {
            if (event.state === 'final') {
                fetchHistory();
            }
            return;
        }

        switch (event.state) {
            case 'delta':
                const text = extractText(event.message);
                if (typeof text === 'string') {
                    setMessages((prev) => {
                        const lastMsg = prev[prev.length - 1];
                        // If last message is streaming, update it
                        if (lastMsg?.isStreaming) {
                            const currentText = typeof lastMsg.content === 'string'
                                ? lastMsg.content
                                : '';
                            // Only update if new text is longer (cumulative)
                            if (text.length >= currentText.length) {
                                return [
                                    ...prev.slice(0, -1),
                                    { ...lastMsg, content: text },
                                ];
                            }
                            return prev;
                        }
                        // Otherwise, create new streaming message
                        return [
                            ...prev,
                            {
                                role: 'assistant',
                                content: text,
                                localId: STREAMING_MESSAGE_ID,
                                timestamp: Date.now(),
                                isStreaming: true,
                            },
                        ];
                    });
                }
                break;

            case 'final':
                // Fetch history - this will replace the entire list in one atomic update
                fetchHistory();
                break;

            case 'error':
                // Remove streaming message and show error
                setMessages((prev) => prev.filter((msg) => !msg.isStreaming));
                chatRunIdRef.current = null;
                console.error('[OpenClaw Chat] error:', event.errorMessage);
                break;
        }
    }, [sessionKey, fetchHistory]);

    // Keep ref updated with latest handleChatEvent
    handleChatEventRef.current = handleChatEvent;

    // Fetch chat history when connected
    React.useEffect(() => {
        if (isConnected && sessionKey) {
            setIsLoading(true);
            userNearBottomRef.current = true;
            fetchHistory().finally(() => setIsLoading(false));
        }
    }, [isConnected, sessionKey, fetchHistory]);

    // Scroll when messages change (if user is near bottom)
    React.useEffect(() => {
        if (messages.length > 0 && userNearBottomRef.current) {
            flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
        }
    }, [messages]);

    // Check if currently streaming
    const isStreaming = messages.some((msg) => msg.isStreaming);

    // Send a message
    const sendMessage = React.useCallback(async (localId: string, text: string) => {
        const runId = randomUUID();

        // Send to gateway
        const result = await send('chat.send', {
            sessionKey,
            message: text,
            idempotencyKey: runId,
        });

        if (!result || !result.ok) {
            // Mark message as failed
            setMessages((prev) =>
                prev.map((msg) =>
                    msg.localId === localId
                        ? { ...msg, status: 'failed' as MessageStatus, errorMessage: result?.error }
                        : msg
                )
            );
        } else {
            // Mark message as sent, set up for streaming
            chatRunIdRef.current = runId;
            setMessages((prev) => {
                const updated = prev.map((msg) =>
                    msg.localId === localId
                        ? { ...msg, status: 'sent' as MessageStatus }
                        : msg
                );
                // Add streaming placeholder
                return [
                    ...updated,
                    {
                        role: 'assistant' as const,
                        content: '',
                        localId: STREAMING_MESSAGE_ID,
                        timestamp: Date.now(),
                        isStreaming: true,
                    },
                ];
            });
        }
    }, [sessionKey, send]);

    // Handle scroll event - track if user is near bottom
    const handleScroll = React.useCallback((event: { nativeEvent: { contentOffset: { y: number } } }) => {
        const { contentOffset } = event.nativeEvent;
        // In inverted list, near bottom means near offset 0
        userNearBottomRef.current = contentOffset.y < 200;
    }, []);

    // Handle new message send
    const handleSend = React.useCallback(async () => {
        const text = inputText.trim();
        if (!text || !isConnected || isStreaming) {
            return;
        }

        // Force scroll when sending a message
        shouldForceScrollRef.current = true;

        // Create user message with sending status
        const localId = randomUUID();
        const userMessage: LocalMessage = {
            role: 'user',
            content: text,
            timestamp: Date.now(),
            localId,
            status: 'sending',
        };

        // Add to messages list
        setMessages((prev) => [...prev, userMessage]);
        setInputText('');

        // Scroll to show the new message
        setTimeout(() => {
            flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
        }, 50);

        // Send the message
        await sendMessage(localId, text);
    }, [inputText, isConnected, isStreaming, sendMessage]);

    // Handle retry for failed messages
    const handleRetry = React.useCallback((localId: string) => {
        const message = messages.find((msg) => msg.localId === localId);
        if (!message || message.status !== 'failed') return;

        // Update status to sending
        setMessages((prev) =>
            prev.map((msg) =>
                msg.localId === localId
                    ? { ...msg, status: 'sending' as MessageStatus, errorMessage: undefined }
                    : msg
            )
        );

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
    const sessionName = sessionNameParam
        ? decodeURIComponent(sessionNameParam)
        : sessionKey
            ? decodeURIComponent(sessionKey)
            : t('openclaw.sessions');
    // Machine name for header subtitle
    const machineName = machine?.metadata?.name;

    const canSend = inputText.trim().length > 0 && isConnected && !isStreaming;

    // Content: message list (only when we have messages)
    const content = messages.length > 0 ? (
        <FlatList
            ref={flatListRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            data={[...messages].reverse()}
            keyExtractor={(item) => item.localId}
            renderItem={({ item }) => (
                <MessageItem
                    message={item}
                    onRetry={handleRetry}
                />
            )}
            inverted
            onScroll={handleScroll}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
                if (shouldForceScrollRef.current || userNearBottomRef.current) {
                    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
                    shouldForceScrollRef.current = false;
                }
            }}
            maintainVisibleContentPosition={{
                minIndexForVisible: 0,
            }}
        />
    ) : null;

    // Placeholder: loading or empty state
    const placeholder = isLoading ? (
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
    ) : null;

    // Input area
    const input = (
        <View style={[styles.inputContainer, { paddingBottom: safeArea.bottom + 16 }]}>
            <View style={styles.inputInner}>
                <View style={styles.inputPanel}>
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
                            color={canSend ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                        />
                    </Pressable>
                </View>
            </View>
        </View>
    );

    return (
        <View style={styles.container}>
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
                    headerRight: () => null,
                }}
            />
            <AgentContentView
                content={content}
                input={input}
                placeholder={placeholder}
            />
        </View>
    );
}
