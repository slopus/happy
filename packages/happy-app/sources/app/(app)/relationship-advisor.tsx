import * as React from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { layout } from '@/components/layout';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { MessageComposer } from '@/components/MessageComposer';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { Typography } from '@/constants/Typography';
import { useImagePicker } from '@/hooks/useImagePicker';
import { useRelationshipAdvisorChat } from '@/hooks/useRelationshipAdvisorChat';
import { Modal } from '@/modal';
import { shouldShowRelationshipAdvisorEmptyState } from '@/components/relationship-advisor/relationshipAdvisorChatModel';
import { StreamingMarkdownView } from '@/components/relationship-advisor/StreamingMarkdownView';
import { MAX_RELATIONSHIP_ADVISOR_IMAGE_SIZE } from '@/sync/relationshipAdvisorImages';
import { t } from '@/text';
import { useLocalSetting, useLocalSettingUpdater } from '@/sync/storage';
import {
    createRelationshipAdvisorConversation,
    saveRelationshipAdvisorConversation,
} from '@/components/relationship-advisor/relationshipAdvisorHistoryModel';

function RelationshipAdvisorScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ conversationId?: string | string[] }>();
    const conversations = useLocalSetting('relationshipAdvisorConversations');
    const updateConversations = useLocalSettingUpdater('relationshipAdvisorConversations');
    const requestedConversationId = Array.isArray(params.conversationId) ? params.conversationId[0] : params.conversationId;
    const conversation = conversations.find(({ id }) => id === requestedConversationId) ?? conversations[0];

    React.useEffect(() => {
        if (conversation && requestedConversationId === conversation.id) return;
        const target = conversation ?? createRelationshipAdvisorConversation(
            randomUUID(),
            t('relationshipAdvisor.newConversation'),
        );
        if (!conversation) updateConversations((current) => saveRelationshipAdvisorConversation(current, target));
        router.setParams({ conversationId: target.id });
    }, [conversation, requestedConversationId, router, updateConversations]);

    if (!conversation) {
        return <View style={styles.root} />;
    }

    return <RelationshipAdvisorConversationScreen key={conversation.id} conversationId={conversation.id} />;
}

function RelationshipAdvisorConversationScreen({ conversationId }: { conversationId: string }) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const scrollRef = React.useRef<ScrollView>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const [draft, setDraft] = React.useState('');
    const { selectedImages, pickImages, removeImage, clearImages, addImages } = useImagePicker({
        maxAttachments: 4,
        maxImageSizeBytes: MAX_RELATIONSHIP_ADVISOR_IMAGE_SIZE,
    });
    const {
        messages,
        activeRequestId,
        streamingText,
        error,
        send,
        cancel,
        clear,
        canRetry,
        retry,
    } = useRelationshipAdvisorChat(conversationId);

    const handleSend = React.useCallback(async () => {
        const started = await send(draft, selectedImages);
        if (!started) return;
        inputRef.current?.setTextAndSelection('', { start: 0, end: 0 });
        setDraft('');
        clearImages();
    }, [clearImages, draft, selectedImages, send]);

    const handleClear = React.useCallback(async () => {
        if (activeRequestId || messages.length === 0) return;
        const confirmed = await Modal.confirm(
            t('relationshipAdvisor.clearConfirmTitle'),
            t('relationshipAdvisor.clearConfirmMessage'),
            { confirmText: t('relationshipAdvisor.clear'), destructive: true },
        );
        if (confirmed) clear();
    }, [activeRequestId, clear, messages.length]);

    React.useEffect(() => {
        const frame = requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
        return () => cancelAnimationFrame(frame);
    }, [messages.length, streamingText]);

    const hasStreamingAssistant = Boolean(activeRequestId);

    return (
        <KeyboardAvoidingView
            testID="relationship-advisor-screen"
            style={styles.root}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
        >
            <Stack.Screen
                options={{
                    headerTitle: t('relationshipAdvisor.title'),
                    headerRight: () => (
                        <Pressable
                            testID="relationship-advisor-clear-button"
                            accessibilityRole="button"
                            accessibilityLabel={t('relationshipAdvisor.clearAccessibility')}
                            disabled={Boolean(activeRequestId) || messages.length === 0}
                            onPress={handleClear}
                            hitSlop={10}
                            style={({ pressed }) => [
                                styles.headerButton,
                                pressed && styles.headerButtonPressed,
                                (Boolean(activeRequestId) || messages.length === 0) && styles.headerButtonDisabled,
                            ]}
                        >
                            <Ionicons name="trash-outline" size={19} color={theme.colors.header.tint} />
                        </Pressable>
                    ),
                }}
            />

            <ScrollView
                testID="relationship-advisor-messages"
                ref={scrollRef}
                style={styles.messages}
                contentContainerStyle={styles.messagesContent}
                keyboardShouldPersistTaps="handled"
                onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
                {shouldShowRelationshipAdvisorEmptyState({
                    messages,
                    activeRequestId,
                    streamingText,
                    error,
                }) ? (
                    <View style={styles.empty} testID="relationship-advisor-empty-state">
                        <View style={styles.avatar}>
                            <Text style={styles.avatarText}>聊</Text>
                        </View>
                        <Text style={styles.emptyText}>{t('relationshipAdvisor.emptyPrompt')}</Text>
                    </View>
                ) : (
                    <View style={styles.thread}>
                        {messages.map((message) => (
                            <View
                                key={message.id}
                                testID={`relationship-advisor-message-${message.role}`}
                                style={[styles.messageRow, message.role === 'user' ? styles.userRow : styles.assistantRow]}
                            >
                                <View style={[styles.bubble, message.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
                                    {message.imageCount > 0 && (
                                        <View style={styles.imageLabel}>
                                            <Ionicons name="image-outline" size={14} color={theme.colors.textSecondary} />
                                            <Text style={styles.imageLabelText}>
                                                {t('relationshipAdvisor.imageCount', { count: message.imageCount })}
                                            </Text>
                                        </View>
                                    )}
                                    {message.text ? (
                                        message.role === 'assistant'
                                            ? <MarkdownView markdown={message.text} />
                                            : <Text selectable style={styles.userText}>{message.text}</Text>
                                    ) : null}
                                </View>
                            </View>
                        ))}

                        {hasStreamingAssistant && (
                            <View style={[styles.messageRow, styles.assistantRow]}>
                                <View style={[styles.bubble, styles.assistantBubble, styles.streamingBubble]}>
                                    {streamingText
                                        ? (
                                            <StreamingMarkdownView markdown={streamingText} />
                                        )
                                        : (
                                            <ActivityIndicator
                                                accessibilityLabel={t('status.running')}
                                                size="small"
                                                color={theme.colors.textSecondary}
                                            />
                                        )}
                                </View>
                            </View>
                        )}

                        {error && !hasStreamingAssistant && (
                            <View style={styles.errorRow} testID="relationship-advisor-error">
                                <Ionicons name="cloud-offline-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.errorText}>{t('relationshipAdvisor.unavailable')}</Text>
                                {canRetry && (
                                    <Pressable
                                        testID="relationship-advisor-retry-button"
                                        accessibilityRole="button"
                                        onPress={() => { void retry(); }}
                                        style={({ pressed }) => [styles.retryButton, pressed && styles.headerButtonPressed]}
                                    >
                                        <Text style={styles.retryText}>{t('common.retry')}</Text>
                                    </Pressable>
                                )}
                            </View>
                        )}
                    </View>
                )}
            </ScrollView>

            <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 8) }] }>
                <View style={styles.composerInner}>
                    <MessageComposer
                        ref={inputRef}
                        mode="home"
                        initialValue=""
                        placeholder={t('relationshipAdvisor.placeholder')}
                        onChangeText={setDraft}
                        onSend={handleSend}
                        isSending={false}
                        isSendDisabled={Boolean(activeRequestId)}
                        selectedImages={selectedImages.length > 0 ? selectedImages : undefined}
                        onPickImages={pickImages}
                        onRemoveImage={removeImage}
                        onAddImages={addImages}
                        leadingControls={activeRequestId ? (
                            <Pressable
                                testID="relationship-advisor-stop-button"
                                accessibilityRole="button"
                                accessibilityLabel={t('relationshipAdvisor.stopAccessibility')}
                                onPress={cancel}
                                hitSlop={8}
                                style={({ pressed }) => [styles.stopButton, pressed && styles.headerButtonPressed]}
                            >
                                <Ionicons name="stop-circle-outline" size={20} color={theme.colors.textSecondary} />
                            </Pressable>
                        ) : undefined}
                    />
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}

export default React.memo(RelationshipAdvisorScreen);

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    messages: {
        flex: 1,
    },
    messagesContent: {
        flexGrow: 1,
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 12,
    },
    thread: {
        width: '100%',
        maxWidth: layout.maxWidth,
        gap: 12,
    },
    messageRow: {
        width: '100%',
        flexDirection: 'row',
    },
    userRow: {
        justifyContent: 'flex-end',
    },
    assistantRow: {
        justifyContent: 'flex-start',
    },
    bubble: {
        maxWidth: '84%',
        borderRadius: 8,
        paddingHorizontal: 13,
        paddingVertical: 10,
    },
    userBubble: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    assistantBubble: {
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    streamingBubble: {
        minWidth: 44,
        minHeight: 40,
        justifyContent: 'center',
    },
    userText: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 23,
        ...Typography.default(),
    },
    imageLabel: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginBottom: 6,
    },
    imageLabelText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    errorRow: {
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 8,
    },
    errorText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        ...Typography.default(),
    },
    retryButton: {
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 10,
        borderRadius: 8,
    },
    retryText: {
        color: theme.colors.text,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    empty: {
        flex: 1,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        paddingBottom: 48,
    },
    avatar: {
        width: 48,
        height: 48,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceSelected,
    },
    avatarText: {
        color: theme.colors.text,
        fontSize: 21,
        ...Typography.default('semiBold'),
    },
    emptyText: {
        maxWidth: 320,
        color: theme.colors.textSecondary,
        fontSize: 15,
        lineHeight: 22,
        textAlign: 'center',
        ...Typography.default(),
    },
    composerWrap: {
        alignItems: 'center',
        paddingHorizontal: 12,
        backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    composerInner: {
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    headerButton: {
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
    headerButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    headerButtonDisabled: {
        opacity: 0.35,
    },
    stopButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
}));
