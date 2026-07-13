import * as React from 'react';
import { View, Text, Pressable, TextInput, Platform, ActivityIndicator, NativeSyntheticEvent, TextInputKeyPressEventData } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSession, useSideChatSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { spawnSideChat } from '@/sync/ops';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { ChatList } from './ChatList';

/**
 * Right-sidebar "side chat" panel.
 *
 * A side chat is a forked child session of `parentSessionId`: it inherits the
 * parent's full context at creation time but is provably isolated (writes only
 * to its own transcript, never back into the parent). It is flagged
 * `metadata.isSideChat` so it never shows up in the top-level session list —
 * it lives only here, scoped to this one parent chat.
 *
 * When no side chat exists yet the panel offers to start one (an explicit
 * action, so toggling the panel on never silently spawns an agent process).
 * Once it exists the panel embeds the child's message list plus a compact
 * composer that sends straight to the child session.
 */
export const SideChatPanel = React.memo(function SideChatPanel({ parentSessionId }: { parentSessionId: string }) {
    const parent = useSession(parentSessionId);
    const child = useSideChatSession(parentSessionId);
    const childId = child?.id ?? null;

    // Pull the child's messages into the store while the panel is mounted.
    React.useEffect(() => {
        if (childId) {
            sync.onSessionVisible(childId);
        }
    }, [childId]);

    if (child) {
        return <SideChatConversation session={child} />;
    }

    return <SideChatEmptyState parent={parent} />;
});

/** Empty state: explain the side chat and offer to start one. */
const SideChatEmptyState = React.memo(function SideChatEmptyState({ parent }: { parent: ReturnType<typeof useSession> }) {
    const { theme } = useUnistyles();
    const forkSource = parent ? getSessionForkSource(parent) : null;

    const [creating, startSideChat] = useHappyAction(async () => {
        if (!forkSource) {
            throw new HappyError(t('sideChat.unavailable'), false);
        }
        const result = await spawnSideChat(forkSource);
        if (result.type === 'error') {
            throw new HappyError(result.errorMessage, true);
        }
        // On success the child session is pulled into the store by
        // forkAndSpawn -> refreshSessions; useSideChatSession then resolves it
        // and the panel swaps to the conversation view automatically.
    });

    return (
        <View style={styles.emptyContainer}>
            <View style={styles.emptyIconWrap}>
                <Octicons name="comment-discussion" size={26} color={theme.colors.textSecondary} />
            </View>
            <Text style={styles.emptyTitle}>{t('sideChat.emptyTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('sideChat.emptySubtitle')}</Text>
            <Pressable
                onPress={startSideChat}
                disabled={creating || !forkSource}
                style={({ pressed, hovered }: any) => [
                    styles.startButton,
                    (pressed || hovered) && styles.startButtonPressed,
                    (creating || !forkSource) && styles.startButtonDisabled,
                ]}
            >
                {creating ? (
                    <>
                        <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                        <Text style={styles.startButtonText}>{t('sideChat.creating')}</Text>
                    </>
                ) : (
                    <>
                        <Octicons name="plus" size={14} color={theme.colors.button.primary.tint} />
                        <Text style={styles.startButtonText}>{t('sideChat.startButton')}</Text>
                    </>
                )}
            </Pressable>
            {!forkSource && (
                <Text style={styles.unavailableHint}>{t('sideChat.unavailable')}</Text>
            )}
        </View>
    );
});

/** Conversation view: embedded message list + compact composer. */
const SideChatConversation = React.memo(function SideChatConversation({ session }: { session: NonNullable<ReturnType<typeof useSession>> }) {
    const { theme } = useUnistyles();
    const router = useRouter();

    return (
        <View style={styles.conversationContainer}>
            <View style={styles.toolbar}>
                <Pressable
                    onPress={() => router.push(`/session/${session.id}`)}
                    accessibilityLabel={t('sideChat.expand')}
                    hitSlop={6}
                    style={({ pressed, hovered }: any) => [
                        styles.toolbarButton,
                        (pressed || hovered) && { backgroundColor: theme.colors.surface },
                    ]}
                >
                    <Octicons name="screen-full" size={13} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            <View style={styles.chatWrap}>
                <ChatList session={session} />
            </View>
            <SideChatComposer sessionId={session.id} />
        </View>
    );
});

/** Minimal composer: text field + send. Sends straight to the child session. */
const SideChatComposer = React.memo(function SideChatComposer({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const [text, setText] = React.useState('');

    const send = React.useCallback(() => {
        const trimmed = text.trim();
        if (!trimmed) return;
        setText('');
        sync.sendMessage(sessionId, trimmed, { source: 'chat' });
    }, [text, sessionId]);

    // Web: Enter sends, Shift+Enter inserts a newline.
    const onKeyPress = React.useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (Platform.OS !== 'web') return;
        const native = e.nativeEvent as unknown as { key?: string; shiftKey?: boolean };
        if (native.key === 'Enter' && !native.shiftKey) {
            e.preventDefault?.();
            send();
        }
    }, [send]);

    const canSend = text.trim().length > 0;

    return (
        <View style={styles.composer}>
            <TextInput
                value={text}
                onChangeText={setText}
                onKeyPress={onKeyPress}
                placeholder={t('sideChat.composerPlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                style={[styles.composerInput, { color: theme.colors.text }]}
                multiline
                autoCapitalize="sentences"
            />
            <Pressable
                onPress={send}
                disabled={!canSend}
                accessibilityLabel={t('sideChat.startButton')}
                hitSlop={6}
                style={({ pressed, hovered }: any) => [
                    styles.sendButton,
                    canSend && styles.sendButtonActive,
                    canSend && (pressed || hovered) && styles.sendButtonActivePressed,
                ]}
            >
                <Octicons
                    name="paper-airplane"
                    size={15}
                    color={canSend ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        gap: 6,
    },
    emptyIconWrap: {
        width: 64,
        height: 64,
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        marginBottom: 12,
    },
    emptyTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    emptySubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 18,
        ...Typography.default(),
    },
    startButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 10,
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 10,
        backgroundColor: theme.colors.button.primary.background,
    },
    startButtonPressed: {
        opacity: 0.85,
    },
    startButtonDisabled: {
        opacity: 0.5,
    },
    startButtonText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
    unavailableHint: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 8,
        ...Typography.default(),
    },
    conversationContainer: {
        flex: 1,
    },
    toolbar: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    toolbarButton: {
        width: 26,
        height: 26,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chatWrap: {
        flex: 1,
    },
    composer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 6,
        paddingHorizontal: 10,
        paddingTop: 8,
        paddingBottom: Platform.select({ web: 10, default: 8 }),
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    composerInput: {
        flex: 1,
        minHeight: 36,
        maxHeight: 120,
        fontSize: 13,
        paddingHorizontal: 10,
        paddingVertical: Platform.select({ web: 8, default: 8 }),
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        ...Typography.default(),
        ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : null),
    },
    sendButton: {
        width: 36,
        height: 36,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    sendButtonActivePressed: {
        opacity: 0.85,
    },
}));
