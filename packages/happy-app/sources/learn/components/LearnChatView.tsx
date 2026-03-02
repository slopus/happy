import * as React from 'react';
import { Text, View, FlatList, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Linking } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { AgentInput } from '@/components/AgentInput';
import { startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { useRealtimeStatus, useVoiceContinuous, useVoiceTranscript, storage } from '@/sync/storage';
import { learnApi } from '../learnApi';
import { learnStorage, useLearnChatMessages, useLearnStreamingContent, useLearnStreamingSessionId } from '../learnStorage';
import type { ChatMessage } from '../learnTypes';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    messageList: {
        flex: 1,
    },
    messageContainer: {
        paddingHorizontal: 16,
        paddingVertical: 6,
    },
    userMessageContainer: {
        paddingHorizontal: 16,
        paddingVertical: 6,
        alignItems: 'flex-end' as const,
    },
    userMessage: {
        maxWidth: '80%',
        backgroundColor: theme.colors.userMessageBackground || 'rgba(255,255,255,0.12)',
        borderRadius: 16,
        borderBottomRightRadius: 4,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    userText: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
    assistantMessage: {
        alignSelf: 'flex-start',
        maxWidth: '90%',
        paddingHorizontal: 4,
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
    },
    emptyText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 12,
        ...Typography.default(),
    },
    typingIndicator: {
        paddingHorizontal: 20,
        paddingVertical: 8,
    },
    typingText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
        ...Typography.default(),
    },
    scrollDownButton: {
        position: 'absolute',
        bottom: 8,
        alignSelf: 'center',
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: theme.colors.surfaceHighest,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        opacity: 0.9,
    },
}));

interface LearnChatViewProps {
    sessionId?: string;
    lessonId?: string;
    courseId?: string;
    onInputFocus?: () => void;
    hideMessages?: boolean;
    onTimestampPress?: (seconds: number) => void;
    timestampColor?: string;
    courseColor?: string;
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function blobUrlToBase64(blobUrl: string): Promise<string> {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

const ChatMessageItem = React.memo(({ message, onOptionPress, onTimestampPress, timestampColor, courseColor }: { message: ChatMessage; onOptionPress?: (text: string) => void; onTimestampPress?: (seconds: number) => void; timestampColor?: string; courseColor?: string }) => {
    const { theme } = useUnistyles();
    const [previewImage, setPreviewImage] = React.useState<string | null>(null);

    if (message.role === 'user') {
        const hasImages = message.images && message.images.length > 0;
        const hasDocs = message.documents && message.documents.length > 0;
        const hasText = message.content && message.content !== '[attached files]';

        return (
            <View style={styles.userMessageContainer}>
                {/* Images above bubble */}
                {hasImages && (
                    <View style={{ maxWidth: '80%', flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4, justifyContent: 'flex-end' }}>
                        {message.images!.map((img, i) => {
                            const hasSize = img.width > 0 && img.height > 0;
                            const displayWidth = hasSize ? Math.min(220, img.width) : 200;
                            const displayHeight = hasSize ? displayWidth / (img.width / img.height) : 150;
                            return (
                                <Pressable key={i} onPress={() => setPreviewImage(img.url)}>
                                    <Image
                                        source={{ uri: img.url }}
                                        style={{
                                            width: displayWidth,
                                            height: displayHeight,
                                            borderRadius: 12,
                                        }}
                                        contentFit="cover"
                                        transition={200}
                                    />
                                </Pressable>
                            );
                        })}
                    </View>
                )}
                {/* Documents above bubble */}
                {hasDocs && (
                    <View style={{ maxWidth: '80%', gap: 4, marginBottom: 4 }}>
                        {message.documents!.map((doc, i) => (
                            <Pressable
                                key={i}
                                onPress={() => {
                                    if (Platform.OS === 'web') {
                                        window.open(doc.url, '_blank');
                                    } else {
                                        Linking.openURL(doc.url);
                                    }
                                }}
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: 8,
                                    paddingVertical: 8,
                                    paddingHorizontal: 12,
                                    backgroundColor: 'rgba(255,255,255,0.1)',
                                    borderRadius: 10,
                                }}
                            >
                                <Ionicons name="document-text-outline" size={20} color="#fff" />
                                <View style={{ flexShrink: 1 }}>
                                    <Text style={{ fontSize: 13, color: '#fff', maxWidth: 200, ...Typography.default('bold') }} numberOfLines={1}>
                                        {doc.fileName}
                                    </Text>
                                    <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 1, ...Typography.default() }}>
                                        {formatFileSize(doc.fileSize)}
                                    </Text>
                                </View>
                            </Pressable>
                        ))}
                    </View>
                )}
                {/* Text bubble */}
                {hasText && (
                    <View style={styles.userMessage}>
                        <Text style={styles.userText}>{message.content}</Text>
                    </View>
                )}
                {/* Image preview modal (web) */}
                {previewImage && Platform.OS === 'web' && (
                    <div
                        onClick={() => setPreviewImage(null)}
                        style={{
                            position: 'fixed' as any,
                            top: 0, left: 0, right: 0, bottom: 0,
                            backgroundColor: 'rgba(0,0,0,0.92)',
                            zIndex: 99999,
                            display: 'flex',
                            justifyContent: 'center',
                            alignItems: 'center',
                            cursor: 'zoom-out',
                        }}
                    >
                        <img
                            src={previewImage}
                            onClick={(e: any) => e.stopPropagation()}
                            style={{
                                maxWidth: '92%',
                                maxHeight: '90%',
                                objectFit: 'contain' as any,
                                borderRadius: 8,
                                cursor: 'default',
                            }}
                        />
                    </div>
                )}
            </View>
        );
    }

    return (
        <View style={styles.messageContainer}>
            <View style={styles.assistantMessage}>
                <MarkdownView markdown={message.content} onOptionPress={onOptionPress ? (opt) => onOptionPress(opt.title) : undefined} onTimestampPress={onTimestampPress} timestampColor={timestampColor} />
            </View>
        </View>
    );
});

const EMPTY_SUGGESTIONS = async () => [] as { key: string; text: string; component: React.ElementType }[];


export const LearnChatView = React.memo(({ sessionId: initialSessionId, lessonId, courseId, onInputFocus, hideMessages, onTimestampPress, timestampColor, courseColor }: LearnChatViewProps) => {
    const { theme } = useUnistyles();
    const [sessionId, setSessionId] = React.useState(initialSessionId || '');
    const messages = useLearnChatMessages(sessionId);
    const streamingContent = useLearnStreamingContent();
    const streamingSessionId = useLearnStreamingSessionId();
    const [text, setText] = React.useState('');
    const [waitingForResponse, setWaitingForResponse] = React.useState(false);
    const [loading, setLoading] = React.useState(!!initialSessionId);
    const flatListRef = React.useRef<FlatList>(null);
    const [showScrollDown, setShowScrollDown] = React.useState(false);
    const abortControllerRef = React.useRef<AbortController | null>(null);
    const [hasMore, setHasMore] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);

    // Attach state
    const [pendingImages, setPendingImages] = React.useState<Array<{ url: string; mediaType: string; width: number; height: number; localUri: string }>>([]);
    const [pendingDocuments, setPendingDocuments] = React.useState<Array<{ url: string; mediaType: string; fileName: string; fileSize: number }>>([]);

    const handleAttach = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,video/*,audio/*,application/pdf,text/*,.pdf,.txt,.csv,.md,.json,.yaml,.yml,.xml,.html,.mp4,.mov,.mp3,.m4a,.wav,.webm';
        input.multiple = true;
        input.onchange = () => {
            if (!input.files) return;
            for (let i = 0; i < Math.min(input.files.length, 10); i++) {
                const file = input.files[i];
                if (file.type.startsWith('image/')) {
                    const url = URL.createObjectURL(file);
                    const img = new window.Image();
                    img.onload = () => {
                        setPendingImages(prev => [...prev, {
                            url, mediaType: file.type,
                            width: img.naturalWidth, height: img.naturalHeight,
                            localUri: url,
                        }]);
                    };
                    img.src = url;
                } else {
                    const url = URL.createObjectURL(file);
                    setPendingDocuments(prev => [...prev, {
                        url, mediaType: file.type,
                        fileName: file.name, fileSize: file.size,
                    }]);
                }
            }
        };
        input.click();
    }, []);

    const handleRemoveImage = React.useCallback((index: number) => {
        setPendingImages(prev => { URL.revokeObjectURL(prev[index]?.url); return prev.filter((_, i) => i !== index); });
    }, []);

    const handleRemoveDocument = React.useCallback((index: number) => {
        setPendingDocuments(prev => { URL.revokeObjectURL(prev[index]?.url); return prev.filter((_, i) => i !== index); });
    }, []);

    // Voice state
    const realtimeStatus = useRealtimeStatus();
    const voiceContinuous = useVoiceContinuous();
    const voiceTranscript = useVoiceTranscript();

    // Track if this is a tap-mode voice session (auto-send after pause)
    const isTapModeRef = React.useRef(false);
    const tapSendTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Sync voice transcript to text input + auto-send for tap mode
    React.useEffect(() => {
        if (voiceTranscript) {
            setText(voiceTranscript);

            // In tap mode: reset the auto-send timer on each new transcript
            if (isTapModeRef.current) {
                if (tapSendTimerRef.current) clearTimeout(tapSendTimerRef.current);
                tapSendTimerRef.current = setTimeout(() => {
                    // Auto-send after 1.5s pause
                    const finalText = storage.getState().voiceTranscript.trim();
                    if (finalText) {
                        isTapModeRef.current = false;
                        storage.getState().clearVoiceTranscript();
                        stopRealtimeSession();
                        // Trigger send with the accumulated text
                        doSend(finalText);
                    }
                }, 1500);
            }
        }
    }, [voiceTranscript]);

    // Cleanup tap timer
    React.useEffect(() => {
        return () => {
            if (tapSendTimerRef.current) clearTimeout(tapSendTimerRef.current);
        };
    }, []);

    React.useEffect(() => {
        if (initialSessionId) {
            learnApi.getChatHistory(initialSessionId, { limit: 50 }).then((res) => {
                learnStorage.getState().setChatMessages(initialSessionId, res.messages);
                setHasMore(res.hasMore);
            }).catch(console.error).finally(() => setLoading(false));
        }
    }, [initialSessionId]);

    // Core send logic (used by both button send and voice auto-send)
    const doSend = React.useCallback(async (
        messageText: string,
        images?: ChatMessage['images'],
        documents?: ChatMessage['documents'],
    ) => {
        const trimmed = messageText.trim();
        if (!trimmed && !images?.length && !documents?.length) return;

        setText('');
        setWaitingForResponse(true);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        // Optimistic user message
        const tempId = `temp-${Date.now()}`;
        const currentSessionId = sessionId;
        const userMsg: ChatMessage = {
            id: tempId,
            sessionId: currentSessionId || 'new',
            role: 'user',
            content: trimmed || (images?.length || documents?.length ? '[attached files]' : ''),
            createdAt: new Date().toISOString(),
            ...(images?.length ? { images } : {}),
            ...(documents?.length ? { documents } : {}),
        };

        if (currentSessionId) {
            learnStorage.getState().addChatMessage(currentSessionId, userMsg);
        }

        // Upload images/docs first
        let apiImages: Array<{ url: string; mediaType: string }> | undefined;
        if (images?.length && Platform.OS === 'web') {
            apiImages = await Promise.all(images.map(async (img) => {
                const dataUrl = img.url.startsWith('blob:') ? await blobUrlToBase64(img.url) : img.url;
                const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    try {
                        const uploaded = await learnApi.uploadImage(match[2], match[1], currentSessionId || undefined);
                        return { url: uploaded.url, mediaType: uploaded.mediaType };
                    } catch (e) {
                        console.warn('[learn] Image upload failed, using inline:', e);
                        return { url: dataUrl, mediaType: img.mediaType };
                    }
                }
                return { url: dataUrl, mediaType: img.mediaType };
            }));
        }
        let apiDocs: Array<{ url: string; mediaType: string; fileName: string; fileSize: number }> | undefined;
        if (documents?.length && Platform.OS === 'web') {
            apiDocs = await Promise.all(documents.map(async (doc) => {
                const dataUrl = doc.url.startsWith('blob:') ? await blobUrlToBase64(doc.url) : doc.url;
                return { url: dataUrl, mediaType: doc.mediaType, fileName: doc.fileName, fileSize: doc.fileSize };
            }));
        }

        // Try streaming first, fallback to non-streaming
        let accumulated = '';
        let streamSessionId = currentSessionId;

        learnStorage.getState().setStreamingContent('');
        learnStorage.getState().setStreamingSessionId(currentSessionId || 'new');

        try {
            await learnApi.sendMessageStream(
                trimmed,
                {
                    sessionId: currentSessionId || undefined,
                    lessonId, courseId,
                    images: apiImages,
                    documents: apiDocs,
                },
                {
                    onSession: (sid) => {
                        streamSessionId = sid;
                        if (!currentSessionId) {
                            setSessionId(sid);
                            learnStorage.getState().setStreamingSessionId(sid);
                            // Add user message to the new session
                            learnStorage.getState().setChatMessages(sid, [{ ...userMsg, sessionId: sid }]);
                        }
                    },
                    onDelta: (content) => {
                        accumulated += content;
                        learnStorage.getState().setStreamingContent(accumulated);
                    },
                    onDone: (data) => {
                        const finalSessionId = streamSessionId || currentSessionId;
                        const assistantMsg: ChatMessage = {
                            id: data.messageId,
                            sessionId: finalSessionId || '',
                            role: 'assistant',
                            content: accumulated,
                            createdAt: new Date().toISOString(),
                        };
                        learnStorage.getState().addChatMessage(finalSessionId || '', assistantMsg);
                        learnStorage.getState().setStreamingContent(null);
                        learnStorage.getState().setStreamingSessionId(null);

                        // Refresh sessions list
                        learnApi.getChatSessions().then((sessRes) => {
                            learnStorage.getState().setChatSessions(sessRes.sessions);
                        }).catch(() => {});

                        // Refresh flashcard decks if cards were generated
                        if (data.cardsGenerated) {
                            learnApi.getDecks().then((decksRes) => {
                                learnStorage.getState().setDecks(decksRes.decks);
                            }).catch(() => {});
                        }
                    },
                    onError: (error) => {
                        console.error('[learn] Stream error:', error);
                        learnStorage.getState().setStreamingContent(null);
                        learnStorage.getState().setStreamingSessionId(null);
                    },
                },
            );
        } catch (e) {
            // Streaming failed entirely — fallback to non-streaming
            learnStorage.getState().setStreamingContent(null);
            learnStorage.getState().setStreamingSessionId(null);
            try {
                const res = await learnApi.sendMessage(trimmed, currentSessionId || undefined, lessonId, courseId, apiImages, apiDocs);
                if (controller.signal.aborted) return;

                const newSessionId = res.sessionId;
                if (!currentSessionId) {
                    setSessionId(newSessionId);
                    learnStorage.getState().setChatMessages(newSessionId, [
                        { ...userMsg, sessionId: newSessionId },
                        res.message,
                    ]);
                } else {
                    learnStorage.getState().addChatMessage(currentSessionId, res.message);
                }

                learnApi.getChatSessions().then((sessRes) => {
                    learnStorage.getState().setChatSessions(sessRes.sessions);
                }).catch(() => {});

                if (res.cardsGenerated) {
                    learnApi.getDecks().then((decksRes) => {
                        learnStorage.getState().setDecks(decksRes.decks);
                    }).catch(() => {});
                }
            } catch (e2) {
                if (!controller.signal.aborted) console.error(e2);
            }
        } finally {
            if (!controller.signal.aborted) {
                setWaitingForResponse(false);
            }
            learnStorage.getState().setStreamingContent(null);
            learnStorage.getState().setStreamingSessionId(null);
            abortControllerRef.current = null;
        }
    }, [sessionId, lessonId, courseId]);

    const handleSend = React.useCallback(async () => {
        const trimmed = text.trim();
        if (!trimmed && pendingImages.length === 0 && pendingDocuments.length === 0) return;

        // Clear voice if active
        storage.getState().clearVoiceTranscript();
        if (realtimeStatus === 'connected') {
            await stopRealtimeSession();
        }
        isTapModeRef.current = false;
        if (tapSendTimerRef.current) {
            clearTimeout(tapSendTimerRef.current);
            tapSendTimerRef.current = null;
        }

        // Capture pending files before clearing
        const imgsCopy = pendingImages.length > 0 ? pendingImages.map(({ url, mediaType, width, height }) => ({ url, mediaType, width, height })) : undefined;
        const docsCopy = pendingDocuments.length > 0 ? [...pendingDocuments] : undefined;

        // Clear pending files
        setPendingImages([]);
        setPendingDocuments([]);

        await doSend(trimmed, imgsCopy, docsCopy);
    }, [text, realtimeStatus, doSend, pendingImages, pendingDocuments]);

    // Abort waiting for response
    const handleAbort = React.useCallback(async () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setWaitingForResponse(false);
    }, []);

    // Voice handlers
    // Tap: start as continuous (for Web Speech compat), but treat as tap with auto-send
    const handleMicPress = React.useCallback(async () => {
        if (realtimeStatus === 'connecting') return;
        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            isTapModeRef.current = true;
            await startRealtimeSession('learn-voice', undefined, true);
        } else if (realtimeStatus === 'connected') {
            // Stop recording
            isTapModeRef.current = false;
            if (tapSendTimerRef.current) {
                clearTimeout(tapSendTimerRef.current);
                tapSendTimerRef.current = null;
            }
            await stopRealtimeSession();
        }
    }, [realtimeStatus]);

    // Long press: continuous mode, text goes to input, user sends manually
    const handleMicLongPress = React.useCallback(async () => {
        if (realtimeStatus === 'connecting') return;
        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            isTapModeRef.current = false; // Not tap mode — continuous
            await startRealtimeSession('learn-voice', undefined, true);
        }
    }, [realtimeStatus]);

    // Memoize mic button state to prevent flashing during transitions (same as Happy)
    // isMicContinuous: true only for long-press mode (not tap mode)
    // Both modes use continuous=true for Web Speech compat, but UI differs
    const isMicActive = realtimeStatus === 'connected' || realtimeStatus === 'connecting';
    const micButtonState = React.useMemo(() => ({
        onMicPress: handleMicPress,
        onMicLongPress: handleMicLongPress,
        isMicActive,
        isMicContinuous: isMicActive && !isTapModeRef.current,
    }), [handleMicPress, handleMicLongPress, isMicActive]);

    // Load older messages on scroll to top
    const loadOlderMessages = React.useCallback(async () => {
        if (!hasMore || loadingMore || !sessionId) return;
        const currentMessages = learnStorage.getState().chatMessages[sessionId] || [];
        if (currentMessages.length === 0) return;
        const oldestId = currentMessages[0]?.id;
        if (!oldestId) return;

        setLoadingMore(true);
        try {
            const res = await learnApi.getChatHistory(sessionId, { limit: 50, before: oldestId });
            if (res.messages.length > 0) {
                learnStorage.getState().prependChatMessages(sessionId, res.messages);
            }
            setHasMore(res.hasMore);
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingMore(false);
        }
    }, [hasMore, loadingMore, sessionId]);

    const optionPressRef = React.useRef((_text: string) => {});
    optionPressRef.current = (text: string) => { doSend(text); };

    const timestampPressRef = React.useRef((_seconds: number) => {});
    timestampPressRef.current = onTimestampPress || ((_seconds: number) => {});

    const renderMessage = React.useCallback(({ item }: { item: ChatMessage }) => {
        return <ChatMessageItem message={item} onOptionPress={(t: string) => optionPressRef.current(t)} onTimestampPress={(s: number) => timestampPressRef.current(s)} timestampColor={timestampColor} courseColor={courseColor} />;
    }, [timestampColor, courseColor]);

    // Reverse chronological order (newest first) for inverted FlatList
    const sortedMessages = React.useMemo(() =>
        [...messages].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
        [messages]
    );

    // Extract options from the last assistant message for keyboard mode
    const lastAssistantOptions = React.useMemo(() => {
        if (!hideMessages) return null;
        const lastAssistant = [...sortedMessages].reverse().find(m => m.role === 'assistant');
        if (!lastAssistant) return null;
        const optMatch = lastAssistant.content.match(/<options>([\s\S]*?)<\/options>/);
        if (!optMatch) return null;
        const items: string[] = [];
        const optRegex = /<option>(.*?)<\/option>/g;
        let m;
        while ((m = optRegex.exec(optMatch[1])) !== null) {
            items.push(m[1]);
        }
        return items.length > 0 ? items : null;
    }, [hideMessages, sortedMessages]);

    if (loading) {
        return (
            <View style={styles.emptyContainer}>
                <ActivityIndicator />
            </View>
        );
    }

    return (
        <View style={[styles.container, hideMessages && { justifyContent: 'flex-end' as const }]}>
            {hideMessages ? (
                // Keyboard mode: only show option buttons + input
                lastAssistantOptions ? (
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 6 }}>
                        {lastAssistantOptions.map((item, i) => (
                            <Pressable
                                key={i}
                                onPress={() => optionPressRef.current(item)}
                                style={({ pressed }) => ({
                                    backgroundColor: pressed ? theme.colors.surfaceHigh : theme.colors.surfaceHighest,
                                    borderRadius: 8,
                                    paddingHorizontal: 14,
                                    paddingVertical: 10,
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                })}
                            >
                                <Text style={{ fontSize: 14, color: theme.colors.text, ...Typography.default() }}>{item}</Text>
                            </Pressable>
                        ))}
                    </View>
                ) : null
            ) : sortedMessages.length === 0 && !waitingForResponse ? (
                <View style={styles.emptyContainer}>
                    <Ionicons name="chatbubble-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={styles.emptyText}>Спросите AI-тьютора</Text>
                </View>
            ) : (
                <FlatList
                    ref={flatListRef}
                    data={sortedMessages}
                    renderItem={renderMessage}
                    keyExtractor={(item) => item.id}
                    inverted
                    style={styles.messageList}
                    contentContainerStyle={{ paddingVertical: 8 }}
                    keyboardShouldPersistTaps="handled"
                    onEndReached={loadOlderMessages}
                    onEndReachedThreshold={0.3}
                    ListFooterComponent={loadingMore ? (
                        <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                            <ActivityIndicator size="small" />
                        </View>
                    ) : null}
                    ListHeaderComponent={waitingForResponse ? (
                        streamingContent ? (
                            <View style={styles.messageContainer}>
                                <View style={styles.assistantMessage}>
                                    <MarkdownView markdown={streamingContent} />
                                </View>
                            </View>
                        ) : (
                            <View style={styles.typingIndicator}>
                                <Text style={styles.typingText}>Думаю...</Text>
                            </View>
                        )
                    ) : null}
                />
            )}

            <AgentInput
                value={text}
                onChangeText={setText}
                placeholder="Задайте вопрос..."
                onSend={handleSend}
                onAbort={handleAbort}
                showAbortButton={waitingForResponse}
                onMicPress={micButtonState.onMicPress}
                onMicLongPress={micButtonState.onMicLongPress}
                isMicActive={micButtonState.isMicActive}
                isMicContinuous={micButtonState.isMicContinuous}
                onAttach={handleAttach}
                pendingImages={pendingImages}
                onRemoveImage={handleRemoveImage}
                pendingDocuments={pendingDocuments}
                onRemoveDocument={handleRemoveDocument}
                autocompletePrefixes={[]}
                autocompleteSuggestions={EMPTY_SUGGESTIONS}
            />
        </View>
    );
});
