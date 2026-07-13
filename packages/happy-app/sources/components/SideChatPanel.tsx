import * as React from 'react';
import { View, Text, Pressable, TextInput, Platform, ActivityIndicator, ScrollView, useWindowDimensions, NativeSyntheticEvent, TextInputKeyPressEventData } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSession, useSideChatSessions } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { spawnSideChat, sessionKill, sessionArchive } from '@/sync/ops';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { Modal } from '@/modal';
import type { Session } from '@/sync/storageTypes';
import { ChatList } from './ChatList';

/**
 * Right-sidebar "side chat" panel.
 *
 * A side chat is a forked child session of `parentSessionId`: it inherits the
 * parent's full context at creation time but is provably isolated (writes only
 * to its own transcript, never back into the parent) and is flagged
 * `metadata.isSideChat` so it never shows up in the top-level session list.
 *
 * A parent can have several side chats at once. The panel shows them as tabs:
 * switch between them, spin up new ones (+), and close individual ones (x)
 * without touching siblings or the parent. Closing archives just that child.
 */
export const SideChatPanel = React.memo(function SideChatPanel({ parentSessionId }: { parentSessionId: string }) {
    const parent = useSession(parentSessionId);
    const sideChats = useSideChatSessions(parentSessionId);
    const forkSource = parent ? getSessionForkSource(parent) : null;

    // Which side chat the panel is focused on. Derived-with-fallback: if the
    // selected id is gone (closed) we fall back to the newest remaining tab.
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const activeSession = React.useMemo(() => {
        if (selectedId) {
            const match = sideChats.find((s) => s.id === selectedId);
            if (match) return match;
        }
        return sideChats.length > 0 ? sideChats[sideChats.length - 1] : null;
    }, [selectedId, sideChats]);

    // Pull the focused side chat's messages into the store while mounted.
    const activeId = activeSession?.id ?? null;
    React.useEffect(() => {
        if (activeId) {
            sync.onSessionVisible(activeId);
        }
    }, [activeId]);

    const [creating, createSideChat] = useHappyAction(async () => {
        if (!forkSource) {
            throw new HappyError(t('sideChat.unavailable'), false);
        }
        const result = await spawnSideChat(forkSource);
        if (result.type === 'error') {
            throw new HappyError(result.errorMessage, true);
        }
        if (result.type === 'success') {
            setSelectedId(result.sessionId);
        }
    });

    const closeSideChat = React.useCallback((id: string) => {
        // Move focus to a neighbour *before* the tab disappears so the panel
        // doesn't flash to the newest chat on the way out.
        const idx = sideChats.findIndex((s) => s.id === id);
        if (idx !== -1) {
            const neighbour = sideChats[idx - 1] ?? sideChats[idx + 1] ?? null;
            setSelectedId(neighbour?.id ?? null);
        }
        // Best-effort close: kill the running agent, fall back to server-side
        // archive if the process is already gone. Either way the child gets
        // `lifecycleState: 'archived'` and drops out of useSideChatSessions.
        (async () => {
            const killed = await sessionKill(id);
            if (!killed.success) {
                await sessionArchive(id);
            }
            try {
                await sync.refreshSessions();
            } catch {
                // Broadcast sync will reconcile shortly even if this flaked.
            }
        })();
    }, [sideChats]);

    if (sideChats.length === 0) {
        return (
            <SideChatEmptyState
                creating={creating}
                canStart={!!forkSource}
                onStart={createSideChat}
            />
        );
    }

    return (
        <View style={styles.panel}>
            <SideChatTabs
                sessions={sideChats}
                activeId={activeId}
                creating={creating}
                canCreate={!!forkSource}
                onSelect={setSelectedId}
                onClose={closeSideChat}
                onNew={createSideChat}
            />
            {activeSession && (
                <SideChatConversation key={activeSession.id} session={activeSession} />
            )}
        </View>
    );
});

/** Compute a short, stable label for a side-chat tab / header. */
function sideChatLabel(session: Session, index: number): string {
    const title = session.metadata?.summary?.text?.trim();
    if (title) return title;
    return t('sideChat.tabLabel', { index: index + 1 });
}

/** Horizontal tab strip: one pill per side chat + a "new" button. */
const SideChatTabs = React.memo(function SideChatTabs({
    sessions,
    activeId,
    creating,
    canCreate,
    onSelect,
    onClose,
    onNew,
}: {
    sessions: Session[];
    activeId: string | null;
    creating: boolean;
    canCreate: boolean;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.tabsRow}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.tabsScroll}
            >
                {sessions.map((session, index) => (
                    <SideChatTab
                        key={session.id}
                        label={sideChatLabel(session, index)}
                        active={session.id === activeId}
                        onSelect={() => onSelect(session.id)}
                        onClose={() => onClose(session.id)}
                    />
                ))}
            </ScrollView>
            <Pressable
                onPress={onNew}
                disabled={creating || !canCreate}
                accessibilityLabel={t('sideChat.newChat')}
                hitSlop={6}
                style={({ pressed, hovered }: any) => [
                    styles.newTabButton,
                    (pressed || hovered) && { backgroundColor: theme.colors.surface },
                    (creating || !canCreate) && { opacity: 0.5 },
                ]}
            >
                {creating
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Octicons name="plus" size={14} color={theme.colors.textSecondary} />}
            </Pressable>
        </View>
    );
});

const SideChatTab = React.memo(function SideChatTab({
    label,
    active,
    onSelect,
    onClose,
}: {
    label: string;
    active: boolean;
    onSelect: () => void;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={onSelect}
            style={[styles.tab, active && styles.tabActive]}
        >
            <Octicons
                name="comment-discussion"
                size={12}
                color={active ? theme.colors.text : theme.colors.textSecondary}
            />
            <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
                {label}
            </Text>
            <Pressable
                onPress={(e) => {
                    e.stopPropagation?.();
                    onClose();
                }}
                accessibilityLabel={t('sideChat.close')}
                hitSlop={6}
                style={styles.tabClose}
            >
                <Octicons name="x" size={11} color={active ? theme.colors.text : theme.colors.textSecondary} />
            </Pressable>
        </Pressable>
    );
});

/** Empty state: explain the side chat and offer to start the first one. */
const SideChatEmptyState = React.memo(function SideChatEmptyState({
    creating,
    canStart,
    onStart,
}: {
    creating: boolean;
    canStart: boolean;
    onStart: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.emptyContainer}>
            <View style={styles.emptyIconWrap}>
                <Octicons name="comment-discussion" size={26} color={theme.colors.textSecondary} />
            </View>
            <Text style={styles.emptyTitle}>{t('sideChat.emptyTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('sideChat.emptySubtitle')}</Text>
            <Pressable
                onPress={onStart}
                disabled={creating || !canStart}
                style={({ pressed, hovered }: any) => [
                    styles.startButton,
                    (pressed || hovered) && styles.startButtonPressed,
                    (creating || !canStart) && styles.startButtonDisabled,
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
            {!canStart && (
                <Text style={styles.unavailableHint}>{t('sideChat.unavailable')}</Text>
            )}
        </View>
    );
});

/** Focused side chat inside the panel: message list + compact composer. */
const SideChatConversation = React.memo(function SideChatConversation({ session }: { session: Session }) {
    const { theme } = useUnistyles();
    const openFullScreen = React.useCallback(() => {
        Modal.show({ component: SideChatModal, props: { sessionId: session.id } });
    }, [session.id]);

    return (
        <View style={styles.conversationContainer}>
            <View style={styles.toolbar}>
                <Pressable
                    onPress={openFullScreen}
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

/** Full-screen modal presentation of a single side chat. */
const SideChatModal = React.memo(function SideChatModal({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const session = useSession(sessionId);

    React.useEffect(() => {
        sync.onSessionVisible(sessionId);
    }, [sessionId]);

    // If the side chat was closed while the modal was open, dismiss it.
    React.useEffect(() => {
        if (!session && onClose) onClose();
    }, [session, onClose]);

    if (!session) return null;

    return (
        <View style={[styles.modalContainer, { width, height, backgroundColor: theme.colors.groupped.background }]}>
            <View style={styles.modalHeader}>
                <Octicons name="comment-discussion" size={15} color={theme.colors.textSecondary} />
                <Text style={styles.modalTitle} numberOfLines={1}>
                    {sideChatLabel(session, 0)}
                </Text>
                <Pressable
                    onPress={onClose}
                    accessibilityLabel={t('sideChat.close')}
                    hitSlop={8}
                    style={({ pressed, hovered }: any) => [
                        styles.toolbarButton,
                        (pressed || hovered) && { backgroundColor: theme.colors.surface },
                    ]}
                >
                    <Octicons name="x" size={18} color={theme.colors.text} />
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
                accessibilityLabel={t('sideChat.composerPlaceholder')}
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
    panel: {
        flex: 1,
    },
    tabsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 6,
        paddingBottom: 6,
        gap: 4,
    },
    tabsScroll: {
        alignItems: 'center',
        gap: 4,
        paddingRight: 4,
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingLeft: 8,
        paddingRight: 5,
        paddingVertical: 5,
        borderRadius: 7,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'transparent',
        maxWidth: 140,
    },
    tabActive: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
    },
    tabText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    tabTextActive: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    tabClose: {
        width: 16,
        height: 16,
        borderRadius: 4,
        alignItems: 'center',
        justifyContent: 'center',
    },
    newTabButton: {
        width: 26,
        height: 26,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
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
        width: 30,
        height: 30,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chatWrap: {
        flex: 1,
    },
    modalContainer: {
        borderRadius: Platform.select({ web: 12, default: 0 }),
        overflow: 'hidden',
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    modalTitle: {
        flex: 1,
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
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
