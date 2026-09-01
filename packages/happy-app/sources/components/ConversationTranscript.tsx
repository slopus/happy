import * as React from 'react';
import {
    AppState,
    FlatList,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    Pressable,
    Text,
    View,
} from 'react-native';
import { Octicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { Metadata } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import {
    type DisplayItem,
    type ToolGroupItem,
    useGroupedMessages,
} from '@/hooks/useGroupedMessages';
import { useUserMessageAnchors, type UserMessageAnchor } from '@/hooks/useUserMessageAnchors';
import { getAgentMessageForkTargets, type MessageForkTarget } from '@/utils/messageForkPoint';
import { Modal } from '@/modal';
import { t } from '@/text';
import { MessageView } from './MessageView';
import { AgentWorkGroupView, ToolGroupView } from './ToolGroupView';
import { AttachmentGalleryView } from './AttachmentGalleryView';
import { AnchorListSheet } from './AnchorListSheet';

const SCROLL_THRESHOLD = 300;
const ANCHOR_PILL_LINGER_MS = 1600;

type ForkFromMessage = (
    messageId: string,
    rewindPointId: string | undefined,
    messageText: string,
    retainSelectedTurn?: boolean,
    messageCreatedAt?: number,
) => void;

export type ConversationTranscriptProps = {
    metadata: Metadata | null;
    sessionId?: string;
    messages: Message[];
    groupToolCalls?: boolean;
    currentTurnActive?: boolean;
    hasPendingPermission?: boolean;
    onLoadOlder?: () => void;
    visualTop?: React.ReactElement | null;
    visualBottom?: React.ReactElement | null;
    showMessageActions?: boolean;
    canEditLatestUserMessage?: boolean;
    onEditUserMessage?: (messageId: string, messageText: string) => Promise<void> | void;
    onForkFromMessage?: ForkFromMessage;
    forkingFromMessageId?: string | null;
    showAnchorNavigation?: boolean;
    showScrollToBottom?: boolean;
    inverted?: boolean;
};

export const ConversationTranscript = React.memo((props: ConversationTranscriptProps) => {
    const { theme } = useUnistyles();
    const flatListRef = React.useRef<FlatList>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const showScrollButtonRef = React.useRef(false);
    const [showAnchorPill, setShowAnchorPill] = React.useState(false);
    const anchorPillVisibleRef = React.useRef(false);
    const anchorPillTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const groupingOptions = React.useMemo(
        () => ({ currentTurnActive: props.currentTurnActive ?? false }),
        [props.currentTurnActive],
    );
    const displayItems = useGroupedMessages(props.messages, props.groupToolCalls ?? true, groupingOptions);
    const inverted = props.inverted ?? true;
    const listItems = React.useMemo(
        () => inverted ? displayItems : [...displayItems].reverse(),
        [displayItems, inverted],
    );
    const latestVisibleUserMessageId = React.useMemo(() => {
        for (const item of displayItems) {
            if (item.type === 'message' && item.message.kind === 'user-text') return item.message.id;
        }
        return null;
    }, [displayItems]);
    const anchors = useUserMessageAnchors(displayItems);
    const anchorsRef = React.useRef(anchors);
    anchorsRef.current = anchors;

    const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        for (const item of displayItems) {
            if (isCollapsibleDisplayItem(item) && !item.hasPendingPermission) initial.add(item.id);
        }
        return initial;
    });
    const manuallyCollapsedRef = React.useRef<Set<string>>(new Set());
    const seenCollapsibleGroupsRef = React.useRef<Set<string>>(new Set(
        displayItems.filter(isCollapsibleDisplayItem).map((item) => item.id),
    ));

    React.useEffect(() => {
        setCollapsedGroups((previous) => {
            let changed = false;
            const next = new Set(previous);
            for (const item of displayItems) {
                if (!isCollapsibleDisplayItem(item)) continue;
                const isNew = !seenCollapsibleGroupsRef.current.has(item.id);
                if (isNew) seenCollapsibleGroupsRef.current.add(item.id);
                if (item.hasPendingPermission && next.has(item.id) && !manuallyCollapsedRef.current.has(item.id)) {
                    next.delete(item.id);
                    changed = true;
                } else if (isNew && !item.hasPendingPermission) {
                    next.add(item.id);
                    changed = true;
                }
            }
            return changed ? next : previous;
        });
    }, [displayItems]);

    const displayItemsRef = React.useRef(displayItems);
    displayItemsRef.current = displayItems;
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') return;
            setCollapsedGroups((previous) => {
                const next = new Set(previous);
                for (const item of displayItemsRef.current) {
                    if (isCollapsibleDisplayItem(item) && !item.hasRunning) next.add(item.id);
                }
                return next;
            });
        });
        return () => subscription.remove();
    }, []);

    const latestUserMessageId = React.useMemo(() => {
        for (const message of props.messages) {
            if (message.kind === 'user-text') return message.id;
        }
        return null;
    }, [props.messages]);
    const previousUserMessageIdRef = React.useRef(latestUserMessageId);
    React.useEffect(() => {
        if (!latestUserMessageId || latestUserMessageId === previousUserMessageIdRef.current) return;
        previousUserMessageIdRef.current = latestUserMessageId;
        manuallyCollapsedRef.current.clear();
        setCollapsedGroups((previous) => {
            const next = new Set(previous);
            for (const item of displayItemsRef.current) {
                if (isCollapsibleDisplayItem(item)) next.add(item.id);
            }
            return next;
        });
    }, [latestUserMessageId]);

    const handleToggleGroup = React.useCallback((groupId: string) => {
        setCollapsedGroups((previous) => {
            const next = new Set(previous);
            if (next.has(groupId)) {
                next.delete(groupId);
                manuallyCollapsedRef.current.delete(groupId);
            } else {
                next.add(groupId);
                manuallyCollapsedRef.current.add(groupId);
            }
            return next;
        });
    }, []);
    const agentForkTargets = React.useMemo<Map<string, MessageForkTarget>>(
        () => getAgentMessageForkTargets(props.messages, {
            flavor: props.metadata?.flavor === 'codex' ? 'codex' : 'claude',
            allowMissingRewindPoint: props.metadata?.flavor === 'codex',
        }),
        [props.messages, props.metadata?.flavor],
    );
    const renderItem = React.useCallback(({ item }: { item: DisplayItem }) => {
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={!collapsedGroups.has(item.id)}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        if (item.type === 'image-group') {
            return (
                <AttachmentGalleryView
                    messages={item.messages}
                    sessionId={props.sessionId}
                    presentation={item.presentation}
                    pendingCount={item.pendingCount}
                    pendingStartedAt={item.pendingStartedAt}
                />
            );
        }
        if (item.type === 'agent-work-group') {
            return (
                <AgentWorkGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={!collapsedGroups.has(item.id)}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        return (
            <MessageView
                message={item.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
                onForkFromMessage={props.onForkFromMessage}
                forkingFromMessageId={props.forkingFromMessageId}
                agentForkTarget={item.message.kind === 'agent-text' ? agentForkTargets.get(item.message.id) : undefined}
                showAgentMessageActions={props.showMessageActions}
                showUserMessageActions={props.showMessageActions}
                canEditUserMessage={Boolean(
                    props.canEditLatestUserMessage
                    && item.message.kind === 'user-text'
                    && item.message.id === latestVisibleUserMessageId
                    && !props.hasPendingPermission
                )}
                onEditUserMessage={props.onEditUserMessage}
            />
        );
    }, [
        agentForkTargets,
        collapsedGroups,
        handleToggleGroup,
        latestVisibleUserMessageId,
        props.canEditLatestUserMessage,
        props.hasPendingPermission,
        props.metadata,
        props.onEditUserMessage,
        props.onForkFromMessage,
        props.forkingFromMessageId,
        props.sessionId,
        props.showMessageActions,
    ]);

    const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        const distanceFromBottom = inverted
            ? contentOffset.y
            : Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y);
        const next = distanceFromBottom > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
        if (props.showAnchorNavigation !== false && anchorsRef.current.length > 0) {
            if (!anchorPillVisibleRef.current) {
                anchorPillVisibleRef.current = true;
                setShowAnchorPill(true);
            }
            if (anchorPillTimerRef.current) clearTimeout(anchorPillTimerRef.current);
            anchorPillTimerRef.current = setTimeout(() => {
                anchorPillVisibleRef.current = false;
                setShowAnchorPill(false);
            }, ANCHOR_PILL_LINGER_MS);
        }
    }, [inverted, props.showAnchorNavigation]);

    React.useEffect(() => () => {
        if (anchorPillTimerRef.current) clearTimeout(anchorPillTimerRef.current);
    }, []);

    const scrollToBottom = React.useCallback(() => {
        if (inverted) flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
        else flatListRef.current?.scrollToEnd({ animated: true });
    }, [inverted]);
    const scrollToAnchor = React.useCallback((anchor: UserMessageAnchor) => {
        flatListRef.current?.scrollToIndex({ index: anchor.displayIndex, animated: true, viewPosition: 0.5 });
    }, []);
    const handleScrollToIndexFailed = React.useCallback((info: { index: number; averageItemLength: number }) => {
        flatListRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
        setTimeout(() => {
            flatListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
        }, 120);
    }, []);
    const openAnchorSheet = React.useCallback(() => {
        Modal.show({
            component: AnchorListSheet,
            props: { anchors: anchorsRef.current, onSelect: scrollToAnchor },
        } as any);
    }, [scrollToAnchor]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const node = (flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
        if (!node) return;
        const handler = (event: WheelEvent) => {
            if (event.shiftKey && Math.abs(event.deltaX) > 0 && Math.abs(event.deltaY) < 1) {
                node.scrollTop += event.deltaX;
                event.preventDefault();
            }
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
    }, []);

    return (
        <View style={styles.container}>
            <FlatList
                ref={flatListRef}
                testID="conversation-transcript-list"
                data={listItems}
                inverted={inverted}
                keyExtractor={(item) => item.id}
                maintainVisibleContentPosition={inverted
                    ? { minIndexForVisible: 1, autoscrollToTopThreshold: 50 }
                    : undefined}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                ListHeaderComponent={(inverted ? props.visualBottom : props.visualTop) ?? undefined}
                ListFooterComponent={(inverted ? props.visualTop : props.visualBottom) ?? undefined}
                onEndReached={props.onLoadOlder}
                onEndReachedThreshold={0.5}
                onScrollToIndexFailed={handleScrollToIndexFailed}
            />
            {props.showAnchorNavigation !== false && showAnchorPill && anchors.length > 0 ? (
                <Animated.View
                    entering={FadeIn.duration(180)}
                    exiting={FadeOut.duration(260)}
                    style={[styles.anchorPillContainer, { pointerEvents: 'box-none' }]}
                >
                    <Pressable onPress={openAnchorSheet} style={({ pressed }) => [styles.anchorPill, pressed && styles.anchorPillPressed]}>
                        <Octicons name="list-unordered" size={14} color={theme.colors.text} />
                        <Text style={styles.anchorPillLabel}>{t('session.anchorsButton')}</Text>
                        <Text style={styles.anchorPillCount}>{anchors.length}</Text>
                    </Pressable>
                </Animated.View>
            ) : null}
            {props.showScrollToBottom !== false && showScrollButton ? (
                <View style={styles.scrollButtonContainer}>
                    <Pressable
                        style={({ pressed }) => [styles.scrollButton, pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault]}
                        onPress={scrollToBottom}
                    >
                        <Octicons name="arrow-down" size={14} color={theme.colors.text} />
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
});

function isCollapsibleDisplayItem(
    item: DisplayItem,
): item is ToolGroupItem | Extract<DisplayItem, { type: 'agent-work-group' }> {
    return item.type === 'tool-group' || item.type === 'agent-work-group';
}

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1 },
    scrollButtonContainer: {
        position: 'absolute', right: 16, bottom: 16, alignItems: 'flex-end', justifyContent: 'center', pointerEvents: 'box-none',
    },
    scrollButton: {
        borderRadius: 16, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderWidth: 1,
        borderColor: theme.colors.divider, shadowColor: theme.colors.shadow.color, shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2, shadowOpacity: theme.colors.shadow.opacity * 0.5, elevation: 2,
    },
    scrollButtonDefault: { backgroundColor: theme.colors.surface, opacity: 0.9 },
    scrollButtonPressed: { backgroundColor: theme.colors.surface, opacity: 0.7 },
    anchorPillContainer: {
        position: 'absolute', right: 16, bottom: 60, alignItems: 'flex-end', justifyContent: 'center', pointerEvents: 'box-none',
    },
    anchorPill: {
        flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 14, height: 34,
        borderRadius: 17, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface,
        shadowColor: theme.colors.shadow.color, shadowOffset: { width: 0, height: 2 }, shadowRadius: 6,
        shadowOpacity: theme.colors.shadow.opacity, elevation: 3,
    },
    anchorPillPressed: { opacity: 0.7 },
    anchorPillLabel: { fontSize: 13, fontWeight: '600' as const, color: theme.colors.text },
    anchorPillCount: { fontSize: 11, fontWeight: '700' as const, color: theme.colors.textSecondary },
}));
