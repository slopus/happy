import * as React from 'react';
import { View, Text, Pressable, Platform, ActivityIndicator, ScrollView, useWindowDimensions } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSession, useSideChatSessions } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import type { Session } from '@/sync/storageTypes';
import { SessionViewLoaded } from '@/-session/SessionView';

/**
 * Right-sidebar "side chat" panel (controlled).
 *
 * A side chat is a forked child session of `parentSessionId`: it inherits the
 * parent's context inside the model but starts empty in the UI and is flagged
 * `metadata.isSideChat` so it never shows in the top-level session list.
 *
 * A parent can have several side chats, shown here as switchable tabs. Creation
 * is unified into the sidebar panel picker (the top "+"), so this panel has no
 * add button of its own — it only switches between and closes existing chats.
 * Which chat is focused, plus create/close, are owned by the parent so the
 * picker can create-and-focus in one action; this component is presentational.
 *
 * The chat body is the exact same `SessionViewLoaded` used by the main screen
 * (rendered `embedded`), so tools, MCP, options, permission/model pickers and
 * everything else behave identically to a normal chat.
 */
export const SideChatPanel = React.memo(function SideChatPanel({
    sideChats,
    activeSideChatId,
    onSelectSideChat,
    onCloseSideChat,
    onCreateSideChat,
    canCreateSideChat,
    creatingSideChat,
}: {
    parentSessionId: string;
    sideChats: Session[];
    activeSideChatId: string | null;
    onSelectSideChat: (id: string) => void;
    onCloseSideChat: (id: string) => void;
    onCreateSideChat: () => void;
    canCreateSideChat: boolean;
    creatingSideChat: boolean;
}) {
    const activeSession = React.useMemo(() => {
        if (activeSideChatId) {
            const match = sideChats.find((s) => s.id === activeSideChatId);
            if (match) return match;
        }
        return sideChats.length > 0 ? sideChats[sideChats.length - 1] : null;
    }, [activeSideChatId, sideChats]);

    // Pull the focused side chat's messages into the store while mounted.
    const activeId = activeSession?.id ?? null;
    React.useEffect(() => {
        if (activeId) {
            sync.onSessionVisible(activeId);
        }
    }, [activeId]);

    if (sideChats.length === 0) {
        return (
            <SideChatEmptyState
                creating={creatingSideChat}
                canStart={canCreateSideChat}
                onStart={onCreateSideChat}
            />
        );
    }

    return (
        <View style={styles.panel}>
            <SideChatTabs
                sessions={sideChats}
                activeId={activeId}
                onSelect={onSelectSideChat}
                onClose={onCloseSideChat}
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

/** Horizontal tab strip: one pill per side chat. No add button — creation is
 *  handled by the sidebar panel picker. */
const SideChatTabs = React.memo(function SideChatTabs({
    sessions,
    activeId,
    onSelect,
    onClose,
}: {
    sessions: Session[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
}) {
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

/** Empty state: shown only if the panel is open with no side chats. Offers to
 *  start one (same action as the picker's "New side chat"). */
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

/** Focused side chat inside the panel: the real chat body + an expand button. */
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
                <SessionViewLoaded sessionId={session.id} session={session} embedded />
            </View>
        </View>
    );
});

/** Full-screen modal presentation of a single side chat. */
const SideChatModal = React.memo(function SideChatModal({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const session = useSession(sessionId);
    // Resolve this side chat's position among its live siblings — gives the
    // correct "Side chat N" title and lets us auto-dismiss the modal once the
    // chat is closed (it drops out of useSideChatSessions when archived).
    const parentId = session?.metadata?.parentSessionId ?? null;
    const liveSideChats = useSideChatSessions(parentId);
    const index = liveSideChats.findIndex((s) => s.id === sessionId);
    const stillOpen = !!session && index !== -1;

    React.useEffect(() => {
        if (!stillOpen && onClose) onClose();
    }, [stillOpen, onClose]);

    if (!stillOpen) return null;

    return (
        <View style={[styles.modalContainer, { width, height, backgroundColor: theme.colors.groupped.background }]}>
            <View style={styles.modalHeader}>
                <Octicons name="comment-discussion" size={15} color={theme.colors.textSecondary} />
                <Text style={styles.modalTitle} numberOfLines={1}>
                    {sideChatLabel(session, index)}
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
                <SessionViewLoaded sessionId={session.id} session={session} embedded />
            </View>
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
}));
